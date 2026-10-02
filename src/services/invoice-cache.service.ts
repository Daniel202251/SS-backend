import Redis from "ioredis";
import { logger } from "../observability/logger";

export interface InvoiceCacheOptions {
  redisUrl?: string;
  redisClient?: Redis;
  listTtlSeconds?: number;
  detailTtlSeconds?: number;
  enabled?: boolean;
}

interface MemoryCacheEntry {
  value: string;
  expiresAt: number;
}

export class InvoiceCacheService {
  private readonly redis: Redis | null = null;
  private readonly memoryFallback = new Map<string, MemoryCacheEntry>();
  private readonly listTtlSeconds: number;
  private readonly detailTtlSeconds: number;
  private readonly enabled: boolean;
  private isRedisHealthy: boolean = false;

  constructor(options: InvoiceCacheOptions = {}) {
    this.listTtlSeconds = options.listTtlSeconds ?? 30;
    this.detailTtlSeconds = options.detailTtlSeconds ?? 60;
    this.enabled = options.enabled !== false;

    if (options.redisClient) {
      this.redis = options.redisClient;
      this.isRedisHealthy = true;
    } else if (options.redisUrl && this.enabled) {
      try {
        this.redis = new Redis(options.redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 2000,
          retryStrategy: () => null, // Do not loop reconnecting if Redis is down
        });

        this.redis.on("connect", () => {
          this.isRedisHealthy = true;
          logger.info("InvoiceCache: Redis connected");
        });

        this.redis.on("error", (err: unknown) => {
          this.isRedisHealthy = false;
          logger.warn("InvoiceCache: Redis error, falling back gracefully", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } catch (err) {
        this.redis = null;
        this.isRedisHealthy = false;
        logger.warn("InvoiceCache: Failed to initialize Redis client, falling back", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  public getListTtl(): number {
    return this.listTtlSeconds;
  }

  public getDetailTtl(): number {
    return this.detailTtlSeconds;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  private buildListKey(sellerId: string, page: number, limit: number, status?: string): string {
    return `invoices:list:${sellerId}:${page}:${limit}:${status || "all"}`;
  }

  private buildDetailKey(sellerId: string, invoiceId: string): string {
    return `invoices:detail:${sellerId}:${invoiceId}`;
  }

  /**
   * Retrieve cached invoice listing. Returns raw JSON string or null.
   */
  async getInvoicesList(
    sellerId: string,
    page: number,
    limit: number,
    status?: string
  ): Promise<string | null> {
    if (!this.enabled) return null;
    const key = this.buildListKey(sellerId, page, limit, status);
    return this.get(key);
  }

  /**
   * Cache invoice listing.
   */
  async setInvoicesList(
    sellerId: string,
    page: number,
    limit: number,
    status: string | undefined,
    data: unknown,
    ttlSeconds?: number
  ): Promise<void> {
    if (!this.enabled) return;
    const key = this.buildListKey(sellerId, page, limit, status);
    const ttl = ttlSeconds ?? this.listTtlSeconds;
    await this.set(key, JSON.stringify(data), ttl);
  }

  /**
   * Retrieve cached invoice detail. Returns raw JSON string or null.
   */
  async getInvoiceDetail(sellerId: string, invoiceId: string): Promise<string | null> {
    if (!this.enabled) return null;
    const key = this.buildDetailKey(sellerId, invoiceId);
    return this.get(key);
  }

  /**
   * Cache invoice detail.
   */
  async setInvoiceDetail(
    sellerId: string,
    invoiceId: string,
    data: unknown,
    ttlSeconds?: number
  ): Promise<void> {
    if (!this.enabled) return;
    const key = this.buildDetailKey(sellerId, invoiceId);
    const ttl = ttlSeconds ?? this.detailTtlSeconds;
    await this.set(key, JSON.stringify(data), ttl);
  }

  /**
   * Invalidate cached invoice detail and any listing cache for that seller.
   */
  async invalidateInvoice(invoiceId: string, sellerId?: string): Promise<void> {
    if (!this.enabled) return;
    try {
      if (sellerId) {
        await this.delPattern(`invoices:detail:${sellerId}:${invoiceId}`);
        await this.delPattern(`invoices:list:${sellerId}:*`);
      } else {
        await this.delPattern(`invoices:detail:*:${invoiceId}`);
        await this.delPattern(`invoices:list:*`);
      }
    } catch (err) {
      logger.warn("InvoiceCache: Error invalidating invoice cache", {
        invoiceId,
        sellerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Invalidate all cached data for a specific seller (listing & details).
   */
  async invalidateSellerInvoices(sellerId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.delPattern(`invoices:list:${sellerId}:*`);
      await this.delPattern(`invoices:detail:${sellerId}:*`);
    } catch (err) {
      logger.warn("InvoiceCache: Error invalidating seller invoice caches", {
        sellerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Flush all invoice-related cache keys.
   */
  async invalidateAll(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.delPattern("invoices:*");
    } catch (err) {
      logger.warn("InvoiceCache: Error invalidating all invoice caches", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Graceful disconnect on shutdown.
   */
  async disconnect(): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        this.redis.disconnect();
      }
    }
  }

  // --- Internal Redis & In-Memory Fallback Get/Set/Del ---

  private async get(key: string): Promise<string | null> {
    if (this.redis) {
      try {
        const val = await this.redis.get(key);
        if (val !== null) return val;
      } catch (err) {
        logger.warn("InvoiceCache: Redis get failed, checking memory fallback", {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Check memory fallback
    const entry = this.memoryFallback.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.memoryFallback.delete(key);
      return null;
    }
    return entry.value;
  }

  private async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.setex(key, ttlSeconds, value);
      } catch (err) {
        logger.warn("InvoiceCache: Redis set failed, storing in memory fallback", {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Always maintain memory fallback for fault tolerance
    this.memoryFallback.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  private async delPattern(pattern: string): Promise<void> {
    // Delete in memory fallback matching pattern (simple wildcard)
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    for (const key of this.memoryFallback.keys()) {
      if (regex.test(key)) {
        this.memoryFallback.delete(key);
      }
    }

    if (this.redis) {
      try {
        // Use scan/keys safely to find and delete
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } catch (err) {
        logger.warn("InvoiceCache: Redis delPattern failed", {
          pattern,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

export function createInvoiceCacheService(options: InvoiceCacheOptions = {}): InvoiceCacheService {
  return new InvoiceCacheService(options);
}
