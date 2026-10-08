import Decimal from "decimal.js";

import { TtlCache } from "../lib/ttl-cache";
import { logger as globalLogger } from "../observability/logger";
import type { AppLogger } from "../observability/logger";
import type { DecodedSorobanEvent } from "../types/soroban.types";
import {
  normalizeTopic,
  readEventString,
  type ContractEventHandler,
} from "./contract-event-bus.service";

/**
 * Subscription status is read on every gated-content screen, and on-chain
 * holdings only change when a key is bought, sold or burned, so a short cache
 * keeps the endpoint comfortably inside its latency budget.
 */
export const SUBSCRIPTION_STATUS_CACHE_TTL_SECONDS = 30;

/**
 * Stellar closes a ledger roughly every 5 seconds, so a day is ~17,280
 * ledgers. Used to turn a ledger-based expiry into a day count.
 */
export const LEDGERS_PER_DAY = 17_280;

export const SUBSCRIPTION_EVENTS = {
  holdingChanged: "holding_changed",
  keyHoldingChanged: "key_holding_changed",
} as const;

/** One on-chain reading of a wallet's position in a gated key. */
export interface KeyHoldingReading {
  /** Wallet's current balance of the key, in the key's smallest unit. */
  balance: string;
  /** Balance the contract requires before access is granted. */
  minBalance: string;
  /** Ledger at which access lapses; `null` when it does not expire. */
  expiryLedger: number | null;
  /** Ledger the reading was taken at, used to measure time remaining. */
  ledger: number;
}

/**
 * Chain access boundary. Implemented over Soroban RPC in
 * `soroban-subscription-reader.ts`; declared here so the status endpoint can be
 * tested without a node.
 */
export interface SubscriptionHoldingReader {
  readHolding(input: { wallet: string; keyId: string }): Promise<KeyHoldingReading>;
}

export interface SubscriptionStatusView {
  wallet: string;
  keyId: string;
  subscribed: boolean;
  balance: string;
  minBalance: string;
  expiryLedger: number | null;
  daysRemaining: number;
  ledger: number;
  checkedAt: string;
}

export interface SubscriptionStatusServiceDependencies {
  holdingReader: SubscriptionHoldingReader;
  cache?: TtlCache;
  cacheTtlSeconds?: number;
  ledgersPerDay?: number;
  now?: () => Date;
  logger?: AppLogger;
}

/**
 * Read model for gated-content access.
 *
 * Access is derived from the chain, never from local state: a wallet is
 * subscribed while it holds at least the contract's minimum balance and its
 * access has not lapsed. The answer is cached briefly and evicted as soon as a
 * holding-change event lands, so a sale revokes access without waiting for the
 * TTL to expire.
 */
export class SubscriptionStatusService implements ContractEventHandler {
  private readonly holdingReader: SubscriptionHoldingReader;
  private readonly cache: TtlCache;
  private readonly cacheTtlSeconds: number;
  private readonly ledgersPerDay: number;
  private readonly now: () => Date;
  private readonly logger: AppLogger;
  /** Cache keys written per gated key, so an event evicts only that key. */
  private readonly cacheKeysByKeyId = new Map<string, Set<string>>();

  constructor({
    holdingReader,
    cache,
    cacheTtlSeconds = SUBSCRIPTION_STATUS_CACHE_TTL_SECONDS,
    ledgersPerDay = LEDGERS_PER_DAY,
    now = () => new Date(),
    logger = globalLogger,
  }: SubscriptionStatusServiceDependencies) {
    this.holdingReader = holdingReader;
    this.cacheTtlSeconds = cacheTtlSeconds;
    this.ledgersPerDay = ledgersPerDay > 0 ? ledgersPerDay : LEDGERS_PER_DAY;
    this.now = now;
    this.logger = logger;
    this.cache =
      cache ??
      new TtlCache({
        ttlSeconds: cacheTtlSeconds,
        namespace: "subscriptions",
        enabled: true,
      });
  }

  topics(): string[] {
    return [SUBSCRIPTION_EVENTS.holdingChanged, SUBSCRIPTION_EVENTS.keyHoldingChanged];
  }

  /** GET /subscriptions/status payload for one wallet/key pair. */
  async getStatus(input: { wallet: string; keyId: string }): Promise<SubscriptionStatusView> {
    const cacheKey = `status:${input.wallet}:${input.keyId}`;

    const cached = await this.cache.get<SubscriptionStatusView>(cacheKey);
    if (cached) return cached;

    const reading = await this.holdingReader.readHolding(input);
    const view = this.buildStatusView(input, reading);

    await this.cache.set(cacheKey, view, this.cacheTtlSeconds);
    this.rememberCacheKey(input.keyId, cacheKey);
    return view;
  }

  /** Drops every cached status for one gated key. */
  async invalidateKey(keyId: string): Promise<void> {
    const keys = this.cacheKeysByKeyId.get(keyId);
    this.cacheKeysByKeyId.delete(keyId);
    if (!keys) return;
    for (const key of keys) {
      await this.cache.delete(key);
    }
  }

  /**
   * Evicts the cached status of the wallet named by a holding-change event, so
   * a buy or a sale takes effect on the next read.
   */
  async handle(event: DecodedSorobanEvent): Promise<void> {
    const topic = normalizeTopic(event.topic);
    if (
      topic !== SUBSCRIPTION_EVENTS.holdingChanged &&
      topic !== SUBSCRIPTION_EVENTS.keyHoldingChanged
    ) {
      return;
    }

    const keyId = readEventString(event, ["key_id", "keyId", "key_address", "keyAddress", "key"]);
    if (keyId) {
      await this.invalidateKey(keyId);
      return;
    }

    // Without a key id the event cannot be scoped, so every cached reading has
    // to go rather than leave a revoked access cached for the full TTL.
    this.logger.warn("Holding change event without a key id; clearing all cached statuses", {
      txHash: event.txHash,
      topic: event.topic,
    });
    await this.invalidateAll();
  }

  /** Drops every cached subscription status. */
  async invalidateAll(): Promise<void> {
    for (const keys of this.cacheKeysByKeyId.values()) {
      for (const key of keys) {
        await this.cache.delete(key);
      }
    }
    this.cacheKeysByKeyId.clear();
  }

  private buildStatusView(
    input: { wallet: string; keyId: string },
    reading: KeyHoldingReading
  ): SubscriptionStatusView {
    const balance = this.toDecimal(reading.balance);
    const minBalance = this.toDecimal(reading.minBalance);
    const holdsMinimum = balance.gte(minBalance);

    const expiryLedger = Number.isFinite(reading.expiryLedger as number)
      ? (reading.expiryLedger as number)
      : null;
    const ledger = Number.isFinite(reading.ledger) ? reading.ledger : 0;

    // Holding the minimum is necessary but not sufficient: an access that has
    // already lapsed must read as unsubscribed even if the balance is intact.
    const expired = expiryLedger !== null && expiryLedger <= ledger;
    const subscribed = holdsMinimum && !expired;

    const daysRemaining =
      subscribed && expiryLedger !== null && expiryLedger > ledger
        ? Math.ceil((expiryLedger - ledger) / this.ledgersPerDay)
        : 0;

    return {
      wallet: input.wallet,
      keyId: input.keyId,
      subscribed,
      balance: balance.toFixed(0),
      minBalance: minBalance.toFixed(0),
      expiryLedger,
      daysRemaining,
      ledger,
      checkedAt: this.now().toISOString(),
    };
  }

  private toDecimal(value: string | number | bigint | null | undefined): Decimal {
    try {
      if (value === null || value === undefined) return new Decimal(0);
      if (typeof value === "bigint") return new Decimal(value.toString());
      if (typeof value === "number") return Number.isFinite(value) ? new Decimal(value) : new Decimal(0);
      return new Decimal(String(value).trim() || "0");
    } catch {
      return new Decimal(0);
    }
  }

  private rememberCacheKey(keyId: string, key: string): void {
    const keys = this.cacheKeysByKeyId.get(keyId) ?? new Set<string>();
    keys.add(key);
    this.cacheKeysByKeyId.set(keyId, keys);
  }
}

export function createSubscriptionStatusService(
  dependencies: SubscriptionStatusServiceDependencies
): SubscriptionStatusService {
  return new SubscriptionStatusService(dependencies);
}
