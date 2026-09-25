import Redis from "ioredis";

import { AppLogger, logger } from "../observability/logger";

export interface XlmUsdRateSnapshot {
  rate: number;
  fetched_at: string;
  stale: boolean;
}

interface CachedRateValue {
  rate: number;
  fetchedAt: string;
}

export interface XlmUsdRateServiceOptions {
  redisUrl?: string;
  enabled?: boolean;
  horizonUrl?: string;
  refreshIntervalMs?: number;
  cacheTtlSeconds?: number;
  staleAfterMs?: number;
  assetCode?: string;
  assetIssuer?: string;
  logger?: AppLogger;
}

export class XlmUsdRateService {
  private readonly redisKey = "rates:xlm-usd";
  private readonly redis: Redis | null;
  private readonly refreshIntervalMs: number;
  private readonly cacheTtlSeconds: number;
  private readonly staleAfterMs: number;
  private readonly horizonUrl: string;
  private readonly assetCode: string;
  private readonly assetIssuer?: string;
  private readonly logger: AppLogger;
  private intervalId?: NodeJS.Timeout;
  private cachedValue: CachedRateValue | null = null;

  constructor({
    redisUrl,
    enabled = true,
    horizonUrl = process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org",
    refreshIntervalMs = 60_000,
    cacheTtlSeconds = 60,
    staleAfterMs = 5 * 60 * 1000,
    assetCode = "USD",
    assetIssuer,
    logger: appLogger = logger,
  }: XlmUsdRateServiceOptions = {}) {
    this.redis = enabled && redisUrl ? new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 }) : null;
    this.refreshIntervalMs = refreshIntervalMs;
    this.cacheTtlSeconds = cacheTtlSeconds;
    this.staleAfterMs = staleAfterMs;
    this.horizonUrl = horizonUrl.replace(/\/+$/, "");
    this.assetCode = assetCode.toUpperCase();
    this.assetIssuer = assetIssuer;
    this.logger = appLogger;

    if (this.redis) {
      this.redis.on("error", (error) => {
        this.logger.warn("XLM/USD rate cache redis error", {
          error,
          key: this.redisKey,
        });
      });
    }
  }

  start(): void {
    if (this.intervalId) return;

    void this.refreshFromHorizon();
    this.intervalId = setInterval(() => {
      void this.refreshFromHorizon();
    }, this.refreshIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    if (this.redis) {
      await this.redis.quit();
    }
  }

  async getCurrentRate(): Promise<XlmUsdRateSnapshot> {
    const cached = await this.readFromCache();

    try {
      return await this.refreshFromHorizon();
    } catch (error) {
      if (cached) {
        this.logger.warn("XLM/USD rate refresh failed; falling back to cached value", {
          error,
          cachedRate: cached.rate,
          cachedFetchedAt: cached.fetchedAt,
        });
        return this.toResponse(cached);
      }

      this.logger.warn("XLM/USD rate refresh failed and no valid cache was available", {
        error,
      });
      throw error;
    }
  }

  async refreshFromHorizon(): Promise<XlmUsdRateSnapshot> {
    const rate = await this.fetchRateFromHorizon();
    const fetchedAt = new Date().toISOString();
    const snapshot: CachedRateValue = { rate, fetchedAt };

    await this.writeToCache(snapshot);
    return this.toResponse(snapshot);
  }

  private async fetchRateFromHorizon(): Promise<number> {
    const assetIssuer = this.assetIssuer ?? (await this.resolveAssetIssuer());
    if (!assetIssuer) {
      throw new Error("Unable to resolve a Horizon USD asset issuer for XLM/USD pricing.");
    }

    const url = new URL(`${this.horizonUrl}/trade_aggregations`);
    const nowMs = Date.now();
    url.searchParams.set("base_asset_type", "native");
    url.searchParams.set("counter_asset_type", "credit_alphanum4");
    url.searchParams.set("counter_asset_code", this.assetCode);
    url.searchParams.set("counter_asset_issuer", assetIssuer);
    url.searchParams.set("start_time", String(Math.max(nowMs - 60 * 60 * 1000, 0)));
    url.searchParams.set("end_time", String(nowMs));
    url.searchParams.set("resolution", "3600000");
    url.searchParams.set("limit", "1");

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Horizon trade aggregation request failed with status ${response.status}.`);
    }

    const data = (await response.json()) as {
      _embedded?: { records?: Array<Record<string, unknown>> };
      records?: Array<Record<string, unknown>>;
    };

    const records = data._embedded?.records ?? data.records ?? [];
    const record = records[0];
    if (!record) {
      throw new Error("No trade aggregation data was returned for XLM/USD.");
    }

    const rate = this.extractRate(record);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("Horizon returned an invalid XLM/USD rate.");
    }

    return rate;
  }

  private async resolveAssetIssuer(): Promise<string | null> {
    const url = new URL(`${this.horizonUrl}/assets`);
    url.searchParams.set("asset_code", this.assetCode);
    url.searchParams.set("limit", "20");

    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      _embedded?: { records?: Array<Record<string, unknown>> };
      records?: Array<Record<string, unknown>>;
    };
    const records = data._embedded?.records ?? data.records ?? [];
    const issuer = records.find((entry) => {
      const assetCode = (entry as Record<string, unknown>).asset_code;
      const assetType = (entry as Record<string, unknown>).asset_type;
      return assetType === "credit_alphanum4" && assetCode === this.assetCode;
    }) as Record<string, unknown> | undefined;

    return (issuer?.asset_issuer as string | undefined) ?? null;
  }

  private extractRate(record: Record<string, unknown>): number {
    const directPrice = record.price;
    if (typeof directPrice === "number" && Number.isFinite(directPrice) && directPrice > 0) {
      return directPrice;
    }

    if (typeof directPrice === "string" && directPrice.trim() !== "") {
      const parsed = Number(directPrice);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    const priceR = record.price_r as { n?: number | string; d?: number | string } | undefined;
    if (priceR) {
      const numerator = Number(priceR.n ?? 0);
      const denominator = Number(priceR.d ?? 0);
      if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
        return numerator / denominator;
      }
    }

    const baseAmount = Number(record.base_amount ?? 0);
    const counterAmount = Number(record.counter_amount ?? 0);
    if (baseAmount > 0 && counterAmount > 0) {
      return counterAmount / baseAmount;
    }

    return Number.NaN;
  }

  private async readFromCache(): Promise<CachedRateValue | null> {
    if (this.redis) {
      const raw = await this.redis.get(this.redisKey).catch(() => null);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<CachedRateValue>;
          if (parsed.rate !== undefined && parsed.fetchedAt) {
            const value: CachedRateValue = {
              rate: Number(parsed.rate),
              fetchedAt: String(parsed.fetchedAt),
            };
            this.cachedValue = value;
            return value;
          }
        } catch {
          this.logger.warn("XLM/USD rate cache payload was malformed", { key: this.redisKey, raw });
        }
      }
    }

    if (this.cachedValue) {
      return this.cachedValue;
    }

    return null;
  }

  private async writeToCache(value: CachedRateValue): Promise<void> {
    this.cachedValue = value;

    if (this.redis) {
      try {
        await this.redis.set(this.redisKey, JSON.stringify(value), "EX", this.cacheTtlSeconds);
      } catch (error) {
        this.logger.warn("XLM/USD rate cache write failed", {
          error,
          key: this.redisKey,
        });
      }
    }
  }

  private toResponse(value: CachedRateValue): XlmUsdRateSnapshot {
    const fetchedAtMs = new Date(value.fetchedAt).getTime();
    const stale = Number.isFinite(fetchedAtMs)
      ? Date.now() - fetchedAtMs > this.staleAfterMs
      : true;

    return {
      rate: value.rate,
      fetched_at: value.fetchedAt,
      stale,
    };
  }
}
