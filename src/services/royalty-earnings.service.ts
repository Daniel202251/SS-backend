import Decimal from "decimal.js";

import { TtlCache } from "../lib/ttl-cache";
import { logger as globalLogger } from "../observability/logger";
import type { AppLogger } from "../observability/logger";
import type { DecodedSorobanEvent } from "../types/soroban.types";
import type { RoyaltyClaim } from "../models/RoyaltyClaim.model";
import type { RoyaltyEvent } from "../models/RoyaltyEvent.model";
import {
  normalizeTopic,
  readEventString,
  type ContractEventHandler,
} from "./contract-event-bus.service";

/**
 * Royalty projections are rebuilt from a handful of transfers per creator, and
 * creators refresh these numbers from a dashboard, so a short TTL removes the
 * repeated aggregation without making a new transfer feel unaccounted for.
 */
export const ROYALTY_EARNINGS_CACHE_TTL_SECONDS = 30;

/** Page size used when the caller does not ask for a specific one. */
const DEFAULT_TRANSFER_PAGE_SIZE = 100;
const MAX_TRANSFER_PAGE_SIZE = 200;
/**
 * The breakdown has to cover every royalty event, so pages are followed until
 * the totals are accounted for. This bound only exists so a pathological event
 * count cannot balloon the response without limit.
 */
const MAX_TRANSFER_PAGES = 20;

export const ROYALTY_EVENTS = {
  royaltyPaid: "royalty_paid",
  royaltyClaimed: "royalty_claimed",
} as const;

export interface RoyaltyPaidInput {
  keyAddress: string;
  creatorWallet: string;
  buyerWallet: string | null;
  amount: string;
  txHash: string | null;
  ledgerSequence: string | null;
  paidAt: Date;
}

export interface RoyaltyClaimInput {
  claimId: string;
  keyAddress: string | null;
  creatorWallet: string;
  amount: string;
  txHash: string | null;
  ledgerSequence: string | null;
  claimedAt: Date;
}

export interface RoyaltyTotals {
  totalEarned: string;
  transferCount: number;
}

export interface RoyaltyClaimTotals {
  totalClaimed: string;
  claimCount: number;
}

/**
 * Storage boundary for the royalty projection. Implemented over TypeORM in
 * `onchain-projection-repositories.ts`; declared here so the service can be
 * unit tested without a database.
 */
export interface RoyaltyEarningsRepositoryContract {
  totalsByCreator(creatorWallet: string): Promise<RoyaltyTotals>;
  listTransfers(
    creatorWallet: string,
    options: { limit: number; offset?: number }
  ): Promise<RoyaltyEvent[]>;
  claimTotalsByCreator(creatorWallet: string): Promise<RoyaltyClaimTotals>;
  listClaims(
    creatorWallet: string,
    options: { limit: number; cursor?: { claimedAt: Date; id: string } | null }
  ): Promise<RoyaltyClaim[]>;
  recordRoyaltyPaid(input: RoyaltyPaidInput): Promise<void>;
  recordRoyaltyClaim(input: RoyaltyClaimInput): Promise<void>;
}

export interface RoyaltyTransferView {
  id: string;
  keyAddress: string;
  buyerWallet: string | null;
  amount: string;
  txHash: string | null;
  ledgerSequence: string | null;
  paidAt: string | null;
}

export interface RoyaltyEarningsView {
  creatorWallet: string;
  totalEarned: string;
  totalClaimed: string;
  pending: string;
  transferCount: number;
  claimCount: number;
  transfers: RoyaltyTransferView[];
  computedAt: string;
}

export interface RoyaltyClaimView {
  claimId: string;
  keyAddress: string | null;
  amount: string;
  txHash: string | null;
  ledgerSequence: string | null;
  claimedAt: string | null;
}

export interface RoyaltyClaimPage {
  items: RoyaltyClaimView[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface RoyaltyEarningsServiceDependencies {
  royaltyRepository: RoyaltyEarningsRepositoryContract;
  cache?: TtlCache;
  cacheTtlSeconds?: number;
  /** Clock override so expiry maths in tests is deterministic. */
  now?: () => Date;
  logger?: AppLogger;
}

/** Decimal places used by `royalty_events.amount` / `royalty_claims.amount`. */
const AMOUNT_SCALE = 4;

/**
 * Read model for creator royalty earnings on secondary-market transfers.
 *
 * Two contract events feed it: `RoyaltyPaid` accrues earnings for a creator
 * and `RoyaltyClaimed` moves accrued earnings into a wallet. Earnings are
 * therefore `sum(paid) - sum(claimed)`, and every accrual is reported as an
 * individual transfer so a creator can reconcile against the chain.
 */
export class RoyaltyEarningsService implements ContractEventHandler {
  private readonly royaltyRepository: RoyaltyEarningsRepositoryContract;
  private readonly cache: TtlCache;
  private readonly cacheTtlSeconds: number;
  private readonly now: () => Date;
  private readonly logger: AppLogger;
  /**
   * Cache keys written per creator, so an incoming `RoyaltyPaid` event can
   * evict that creator's earnings and history entries without clearing the
   * caches of every other creator.
   */
  private readonly cacheKeysByWallet = new Map<string, Set<string>>();

  constructor({
    royaltyRepository,
    cache,
    cacheTtlSeconds = ROYALTY_EARNINGS_CACHE_TTL_SECONDS,
    now = () => new Date(),
    logger = globalLogger,
  }: RoyaltyEarningsServiceDependencies) {
    this.royaltyRepository = royaltyRepository;
    this.cacheTtlSeconds = cacheTtlSeconds;
    this.now = now;
    this.logger = logger;
    this.cache =
      cache ??
      new TtlCache({
        ttlSeconds: cacheTtlSeconds,
        namespace: "royalties",
        enabled: true,
      });
  }

  topics(): string[] {
    return [ROYALTY_EVENTS.royaltyPaid, ROYALTY_EVENTS.royaltyClaimed];
  }

  /**
   * GET /royalties/earnings payload for one creator: lifetime accruals, what
   * has been claimed, and the still-claimable balance.
   */
  async getEarnings(
    creatorWallet: string,
    options: { transferLimit?: number } = {}
  ): Promise<RoyaltyEarningsView> {
    // `transfer_limit` is the page size, not a truncation: pages are followed
    // until every transfer counted in `transferCount` has been read.
    const pageSize = this.normalizeLimit(
      options.transferLimit,
      DEFAULT_TRANSFER_PAGE_SIZE,
      MAX_TRANSFER_PAGE_SIZE
    );
    const cacheKey = `earnings:${creatorWallet}:${pageSize}`;

    const cached = await this.cache.get<RoyaltyEarningsView>(cacheKey);
    if (cached) return cached;

    const [earned, claimed] = await Promise.all([
      this.royaltyRepository.totalsByCreator(creatorWallet),
      this.royaltyRepository.claimTotalsByCreator(creatorWallet),
    ]);
    // Totals first: the transfer count says how many pages are worth reading.
    const transfers = await this.listAllTransfers(
      creatorWallet,
      earned.transferCount,
      pageSize
    );

    const totalEarned = this.toAmount(earned.totalEarned);
    const totalClaimed = this.toAmount(claimed.totalClaimed);

    const view: RoyaltyEarningsView = {
      creatorWallet,
      totalEarned,
      totalClaimed,
      pending: this.subtract(totalEarned, totalClaimed),
      transferCount: earned.transferCount,
      claimCount: claimed.claimCount,
      transfers: transfers.map((transfer) => this.toTransferView(transfer)),
      computedAt: this.now().toISOString(),
    };

    await this.cache.set(cacheKey, view, this.cacheTtlSeconds);
    this.rememberCacheKey(creatorWallet, cacheKey);
    return view;
  }

  /**
   * Reads the per-transfer breakdown in pages until `expectedTotal` events have
   * been collected, so the breakdown is never silently truncated. A short page
   * means the repository is exhausted, which ends the walk early.
   */
  private async listAllTransfers(
    creatorWallet: string,
    expectedTotal: number,
    pageSize: number
  ): Promise<RoyaltyEvent[]> {
    const collected: RoyaltyEvent[] = [];

    for (let page = 0; page < MAX_TRANSFER_PAGES; page++) {
      const batch = await this.royaltyRepository.listTransfers(creatorWallet, {
        limit: pageSize,
        offset: collected.length,
      });
      collected.push(...batch);
      if (batch.length < pageSize || collected.length >= expectedTotal) break;
    }

    return collected;
  }

  /**
   * GET /royalties/history payload: royalties this creator has already
   * claimed, newest first, with the on-chain transaction that paid them.
   */
  async getClaimHistory(
    creatorWallet: string,
    options: { limit?: number; cursor?: string | null } = {}
  ): Promise<RoyaltyClaimPage> {
    const limit = this.normalizeLimit(options.limit, 20, 100);
    const cursor = this.parseCursor(options.cursor);
    const cacheKey = `history:${creatorWallet}:${limit}:${options.cursor ?? ""}`;

    const cached = await this.cache.get<RoyaltyClaimPage>(cacheKey);
    if (cached) return cached;

    const rows = await this.royaltyRepository.listClaims(creatorWallet, {
      limit: limit + 1,
      cursor,
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => this.toClaimView(row));
    const last = hasMore ? rows[limit - 1] : rows[rows.length - 1];

    const page: RoyaltyClaimPage = {
      items,
      hasMore,
      nextCursor: hasMore && last?.claimedAt ? this.formatCursor(last) : null,
    };

    await this.cache.set(cacheKey, page, this.cacheTtlSeconds);
    this.rememberCacheKey(creatorWallet, cacheKey);
    return page;
  }

  /** Drops every cached entry belonging to one creator. */
  async invalidate(creatorWallet: string): Promise<void> {
    const keys = this.cacheKeysByWallet.get(creatorWallet);
    this.cacheKeysByWallet.delete(creatorWallet);
    if (!keys) return;
    for (const key of keys) {
      await this.cache.delete(key);
    }
  }

  /**
   * Projects a royalty contract event into the earnings read model and evicts
   * the affected creator's cache, so a new accrual is visible immediately.
   */
  async handle(event: DecodedSorobanEvent): Promise<void> {
    const topic = normalizeTopic(event.topic);

    if (topic === ROYALTY_EVENTS.royaltyPaid) {
      await this.handleRoyaltyPaid(event);
      return;
    }
    if (topic === ROYALTY_EVENTS.royaltyClaimed) {
      await this.handleRoyaltyClaimed(event);
    }
  }

  private async handleRoyaltyPaid(event: DecodedSorobanEvent): Promise<void> {
    const keyAddress = readEventString(event, ["key_address", "keyAddress", "key", "0"], 1);
    const creatorWallet = readEventString(
      event,
      ["creator_wallet", "creatorWallet", "creator", "rights_holder", "1"],
      2
    );
    if (!keyAddress || !creatorWallet) {
      this.logger.warn("RoyaltyPaid event missing key or creator; skipped", {
        txHash: event.txHash,
        topic: event.topic,
      });
      return;
    }

    const amount = this.readAmount(event, ["amount", "royalty", "royalty_amount", "2"]);
    if (amount === null) {
      this.logger.warn("RoyaltyPaid event missing amount; skipped", {
        txHash: event.txHash,
        topic: event.topic,
      });
      return;
    }

    await this.royaltyRepository.recordRoyaltyPaid({
      keyAddress,
      creatorWallet,
      buyerWallet: readEventString(event, ["buyer_wallet", "buyerWallet", "buyer", "payer", "3"]),
      amount,
      txHash: event.txHash ?? null,
      ledgerSequence: Number.isFinite(event.ledger) ? String(event.ledger) : null,
      paidAt: this.eventTimestamp(event),
    });

    await this.invalidate(creatorWallet);
  }

  private async handleRoyaltyClaimed(event: DecodedSorobanEvent): Promise<void> {
    const creatorWallet = readEventString(
      event,
      ["creator_wallet", "creatorWallet", "creator", "claimer", "0"],
      1
    );
    if (!creatorWallet) {
      this.logger.warn("RoyaltyClaimed event missing creator; skipped", {
        txHash: event.txHash,
        topic: event.topic,
      });
      return;
    }

    const amount = this.readAmount(event, ["amount", "claimed", "claim_amount", "1"]);
    if (amount === null) return;

    const claimId =
      readEventString(event, ["claim_id", "claimId", "claim", "2"]) ??
      (event.txHash ? `claim:${event.txHash}` : `claim:${event.id}`);

    await this.royaltyRepository.recordRoyaltyClaim({
      claimId,
      keyAddress: readEventString(event, ["key_address", "keyAddress", "key"]),
      creatorWallet,
      amount,
      txHash: event.txHash ?? null,
      ledgerSequence: Number.isFinite(event.ledger) ? String(event.ledger) : null,
      claimedAt: this.eventTimestamp(event),
    });

    await this.invalidate(creatorWallet);
  }

  private toTransferView(transfer: RoyaltyEvent): RoyaltyTransferView {
    return {
      id: transfer.id,
      keyAddress: transfer.keyAddress,
      buyerWallet: transfer.buyerWallet ?? null,
      amount: this.toAmount(transfer.amount),
      txHash: transfer.txHash ?? null,
      ledgerSequence: transfer.ledgerSequence ?? null,
      paidAt: transfer.paidAt ? new Date(transfer.paidAt).toISOString() : null,
    };
  }

  private toClaimView(row: RoyaltyClaim): RoyaltyClaimView {
    return {
      claimId: row.claimId,
      keyAddress: row.keyAddress ?? null,
      amount: this.toAmount(row.amount),
      txHash: row.txHash ?? null,
      ledgerSequence: row.ledgerSequence ?? null,
      claimedAt: row.claimedAt ? new Date(row.claimedAt).toISOString() : null,
    };
  }

  private eventTimestamp(event: DecodedSorobanEvent): Date {
    if (event.ledgerClosedAt) {
      const closed = new Date(event.ledgerClosedAt);
      if (!Number.isNaN(closed.getTime())) return closed;
    }
    return this.now();
  }

  /**
   * Reads a monetary field from the event payload without going through
   * `readEventNumber`, which would lose precision on stroop-scale values.
   */
  private readAmount(event: DecodedSorobanEvent, keys: string[]): string | null {
    const data = event.data;
    const candidates: unknown[] = [];

    if (data && typeof data === "object" && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      for (const key of keys) candidates.push(record[key]);
    }
    if (Array.isArray(data)) {
      for (const key of keys) {
        const index = Number(key.replace(/\D/g, ""));
        if (Number.isInteger(index) && index >= 0 && index < data.length) candidates.push(data[index]);
      }
    }

    for (const candidate of candidates) {
      const parsed = this.tryDecimal(candidate);
      if (parsed) return this.toAmount(parsed);
    }

    return null;
  }

  /** Coerces a contract-supplied value into a Decimal, or null when unusable. */
  private tryDecimal(value: unknown): Decimal | null {
    try {
      if (typeof value === "bigint") return new Decimal(value.toString());
      if (typeof value === "number") return Number.isFinite(value) ? new Decimal(value) : null;
      if (typeof value === "string" && value.trim()) return new Decimal(value.trim());
      return null;
    } catch {
      return null;
    }
  }

  /** Normalises any numeric representation to the entity's fixed scale. */
  private toAmount(value: string | number | Decimal | null | undefined): string {
    const parsed = typeof value === "object" && value !== null ? value : this.tryDecimal(value);
    return parsed ? parsed.toFixed(AMOUNT_SCALE) : new Decimal(0).toFixed(AMOUNT_SCALE);
  }

  private subtract(minuend: string, subtrahend: string): string {
    const result = new Decimal(minuend).minus(subtrahend);
    return (result.isNegative() ? new Decimal(0) : result).toFixed(AMOUNT_SCALE);
  }

  private normalizeLimit(value: number | undefined, fallback: number, max: number): number {
    if (!Number.isFinite(value) || (value as number) <= 0) return fallback;
    return Math.min(max, Math.trunc(value as number));
  }

  private parseCursor(cursor?: string | null): { claimedAt: Date; id: string } | null {
    if (!cursor) return null;
    const separator = cursor.indexOf("|");
    if (separator === -1) return null;
    const claimedAt = new Date(cursor.slice(0, separator));
    const id = cursor.slice(separator + 1);
    if (Number.isNaN(claimedAt.getTime()) || !id) return null;
    return { claimedAt, id };
  }

  private formatCursor(row: RoyaltyClaim): string {
    return `${new Date(row.claimedAt ?? this.now()).toISOString()}|${row.id}`;
  }

  private rememberCacheKey(creatorWallet: string, key: string): void {
    const keys = this.cacheKeysByWallet.get(creatorWallet) ?? new Set<string>();
    keys.add(key);
    this.cacheKeysByWallet.set(creatorWallet, keys);
  }
}

export function createRoyaltyEarningsService(
  dependencies: RoyaltyEarningsServiceDependencies
): RoyaltyEarningsService {
  return new RoyaltyEarningsService(dependencies);
}
