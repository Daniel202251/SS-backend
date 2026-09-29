import Decimal from "decimal.js";

import { TtlCache } from "../lib/ttl-cache";
import { logger as globalLogger } from "../observability/logger";
import type { AppLogger } from "../observability/logger";
import type { DecodedSorobanEvent } from "../types/soroban.types";
import type { DividendAllocation } from "../models/DividendAllocation.model";
import type { DividendClaim } from "../models/DividendClaim.model";
import {
  normalizeTopic,
  readEventString,
  type ContractEventHandler,
} from "./contract-event-bus.service";

/**
 * Holder dividend claims are read from a wallet screen on every app open, and
 * the underlying chain state only changes when a distribution or a claim is
 * emitted, so a short TTL keeps the endpoint responsive.
 */
export const DIVIDEND_CACHE_TTL_SECONDS = 30;

export const DIVIDEND_EVENTS = {
  distributed: "dividend_distributed",
  claimed: "dividend_claimed",
} as const;

const AMOUNT_SCALE = 4;

export interface DividendDistributionInput {
  issuerWallet: string;
  totalAmount: string;
  recipientCount: number;
  cycleFrequency: string | null;
  txHash: string | null;
  ledgerSequence: string | null;
  distributedAt: Date;
}

export interface DividendAllocationInput {
  allocationId: string;
  distributionId: string | null;
  issuerWallet: string;
  recipientWallet: string;
  amount: string;
  cycleFrequency: string | null;
  txHash: string | null;
  ledgerSequence: string | null;
  distributedAt: Date;
}

export interface DividendClaimInput {
  claimId: string;
  distributionId: string | null;
  issuerWallet: string | null;
  recipientWallet: string;
  amount: string;
  cycleFrequency: string | null;
  txHash: string | null;
  ledgerSequence: string | null;
  claimedAt: Date;
}

/**
 * Storage boundary for the dividend holder projection. Implemented over
 * TypeORM in `onchain-projection-repositories.ts`.
 */
export interface DividendRepositoryContract {
  recordDistribution(input: DividendDistributionInput): Promise<void>;
  recordAllocations(inputs: DividendAllocationInput[]): Promise<void>;
  recordClaim(input: DividendClaimInput): Promise<void>;
  allocationsByWallet(wallet: string): Promise<DividendAllocation[]>;
  claimsByWallet(wallet: string): Promise<DividendClaim[]>;
}

export interface DividendCycleClaimableView {
  cycleId: string;
  cycleFrequency: string | null;
  distributedAt: string | null;
  txHash: string | null;
  earned: string;
  claimed: string;
  claimable: string;
}

export interface DividendClaimableView {
  wallet: string;
  cycles: DividendCycleClaimableView[];
  totalEarned: string;
  totalClaimed: string;
  totalClaimable: string;
  computedAt: string;
}

export interface DividendSummaryView {
  wallet: string;
  totalEarned: string;
  totalClaimed: string;
  totalPending: string;
  cycleCount: number;
  computedAt: string;
}

export interface DividendClaimView {
  claimId: string;
  distributionId: string | null;
  issuerWallet: string | null;
  cycleFrequency: string | null;
  amount: string;
  txHash: string | null;
  ledgerSequence: string | null;
  claimedAt: string | null;
}

export interface DividendClaimPage {
  items: DividendClaimView[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface DividendDistributionServiceDependencies {
  dividendRepository: DividendRepositoryContract;
  cache?: TtlCache;
  cacheTtlSeconds?: number;
  now?: () => Date;
  logger?: AppLogger;
}

/** Groups the per-wallet accruals and claims of a holder by distribution cycle. */
interface CycleTotals {
  cycleId: string;
  cycleFrequency: string | null;
  distributedAt: Date | null;
  claimedAt: Date | null;
  txHash: string | null;
  earned: Decimal;
  claimed: Decimal;
}

/**
 * Read model for the invoice holder dividend model.
 *
 * `DividendDistributed` events carry the per-wallet allocation for a cycle, and
 * `DividendClaimed` events record what a holder has actually withdrawn. What
 * the holder can still claim for a cycle is therefore
 * `sum(allocations) - sum(claims)`, grouped by cycle.
 */
export class DividendDistributionService implements ContractEventHandler {
  private readonly dividendRepository: DividendRepositoryContract;
  private readonly cache: TtlCache;
  private readonly cacheTtlSeconds: number;
  private readonly now: () => Date;
  private readonly logger: AppLogger;
  /** Cache keys written per wallet, so claims invalidate a single holder. */
  private readonly cacheKeysByWallet = new Map<string, Set<string>>();

  constructor({
    dividendRepository,
    cache,
    cacheTtlSeconds = DIVIDEND_CACHE_TTL_SECONDS,
    now = () => new Date(),
    logger = globalLogger,
  }: DividendDistributionServiceDependencies) {
    this.dividendRepository = dividendRepository;
    this.cacheTtlSeconds = cacheTtlSeconds;
    this.now = now;
    this.logger = logger;
    this.cache =
      cache ??
      new TtlCache({ ttlSeconds: cacheTtlSeconds, namespace: "dividends", enabled: true });
  }

  topics(): string[] {
    return [DIVIDEND_EVENTS.distributed, DIVIDEND_EVENTS.claimed];
  }

  /** GET /dividends/claimable payload: what the holder can withdraw, per cycle. */
  async getClaimable(wallet: string): Promise<DividendClaimableView> {
    const cacheKey = `claimable:${wallet}`;
    const cached = await this.cache.get<DividendClaimableView>(cacheKey);
    if (cached) return cached;

    const view = this.buildClaimableView(wallet, await this.loadCycles(wallet));

    await this.cache.set(cacheKey, view, this.cacheTtlSeconds);
    this.rememberCacheKey(wallet, cacheKey);
    return view;
  }

  /** GET /dividends/summary payload: lifetime earned vs. still pending. */
  async getSummary(wallet: string): Promise<DividendSummaryView> {
    const cacheKey = `summary:${wallet}`;
    const cached = await this.cache.get<DividendSummaryView>(cacheKey);
    if (cached) return cached;

    const cycles = await this.loadCycles(wallet);
    const view = this.buildClaimableView(wallet, cycles);
    const summary: DividendSummaryView = {
      wallet,
      totalEarned: view.totalEarned,
      totalClaimed: view.totalClaimed,
      totalPending: view.totalClaimable,
      cycleCount: view.cycles.length,
      computedAt: view.computedAt,
    };

    await this.cache.set(cacheKey, summary, this.cacheTtlSeconds);
    this.rememberCacheKey(wallet, cacheKey);
    return summary;
  }

  /** GET /dividends/claims payload: claimed dividends, newest first, with tx hashes. */
  async getClaimHistory(
    wallet: string,
    options: { limit?: number; cursor?: string | null } = {}
  ): Promise<DividendClaimPage> {
    const limit = this.normalizeLimit(options.limit);
    const cursor = this.parseCursor(options.cursor);
    const cacheKey = `claims:${wallet}:${limit}:${options.cursor ?? ""}`;

    const cached = await this.cache.get<DividendClaimPage>(cacheKey);
    if (cached) return cached;

    const rows = await this.dividendRepository.claimsByWallet(wallet);
    const sorted = [...rows].sort(
      (a, b) => this.timeOf(b.claimedAt) - this.timeOf(a.claimedAt) || (a.id < b.id ? 1 : -1)
    );
    const start = cursor ? this.cursorOffset(sorted, cursor) : 0;
    const window = sorted.slice(start, start + limit + 1);
    const hasMore = window.length > limit;
    const page: DividendClaimPage = {
      items: window.slice(0, limit).map((row) => this.toClaimView(row)),
      hasMore,
      nextCursor: hasMore ? this.formatCursor(window[limit - 1]) : null,
    };

    await this.cache.set(cacheKey, page, this.cacheTtlSeconds);
    this.rememberCacheKey(wallet, cacheKey);
    return page;
  }

  /** Drops every cached entry for one holder. */
  async invalidateWallet(wallet: string): Promise<void> {
    const keys = this.cacheKeysByWallet.get(wallet);
    this.cacheKeysByWallet.delete(wallet);
    if (!keys) return;
    for (const key of keys) {
      await this.cache.delete(key);
    }
  }

  /**
   * Drops the whole cache. A `DividendDistributed` event changes what every
   * holder of the invoice is owed, and the affected wallets are not known
   * until the event has been read, so a scoped eviction is not possible.
   */
  async invalidateAll(): Promise<void> {
    for (const keys of this.cacheKeysByWallet.values()) {
      for (const key of keys) {
        await this.cache.delete(key);
      }
    }
    this.cacheKeysByWallet.clear();
  }

  /**
   * Projects a dividend contract event into the holder read model and evicts
   * the affected caches so the next read is immediately accurate.
   */
  async handle(event: DecodedSorobanEvent): Promise<void> {
    const topic = normalizeTopic(event.topic);

    if (topic === DIVIDEND_EVENTS.distributed) {
      await this.handleDistributed(event);
      return;
    }
    if (topic === DIVIDEND_EVENTS.claimed) {
      await this.handleClaimed(event);
    }
  }

  private async handleDistributed(event: DecodedSorobanEvent): Promise<void> {
    const issuerWallet = readEventString(
      event,
      ["issuer_wallet", "issuerWallet", "issuer", "0"],
      1
    );
    if (!issuerWallet) {
      this.logger.warn("DividendDistributed event missing issuer; skipped", {
        txHash: event.txHash,
        topic: event.topic,
      });
      return;
    }

    const cycleFrequency =
      readEventString(event, ["cycle_frequency", "cycleFrequency", "frequency"]) ?? null;
    const txHash = event.txHash ?? null;
    const ledgerSequence = Number.isFinite(event.ledger) ? String(event.ledger) : null;
    const distributedAt = this.eventTimestamp(event);
    const allocations = this.readAllocations(event, issuerWallet, cycleFrequency);

    await this.dividendRepository.recordDistribution({
      issuerWallet,
      totalAmount: this.sumAmounts(allocations),
      recipientCount: allocations.length,
      cycleFrequency,
      txHash,
      ledgerSequence,
      distributedAt,
    });

    if (allocations.length > 0) {
      await this.dividendRepository.recordAllocations(
        allocations.map((allocation) => ({
          ...allocation,
          txHash,
          ledgerSequence,
          distributedAt,
        }))
      );
    }

    await this.invalidateAll();
  }

  private async handleClaimed(event: DecodedSorobanEvent): Promise<void> {
    const recipientWallet = readEventString(
      event,
      ["recipient_wallet", "recipientWallet", "recipient", "claimer", "holder", "0"],
      1
    );
    if (!recipientWallet) {
      this.logger.warn("DividendClaimed event missing recipient; skipped", {
        txHash: event.txHash,
        topic: event.topic,
      });
      return;
    }

    const amount = this.readAmount(event, ["amount", "claimed", "claim_amount", "1"]);
    if (amount === null) {
      this.logger.warn("DividendClaimed event missing amount; skipped", {
        txHash: event.txHash,
        topic: event.topic,
      });
      return;
    }

    const claimId =
      readEventString(event, ["claim_id", "claimId", "claim", "2"]) ??
      (event.txHash ? `claim:${event.txHash}` : `claim:${event.id}`);

    await this.dividendRepository.recordClaim({
      claimId,
      distributionId:
        readEventString(event, ["distribution_id", "distributionId", "cycle_id", "cycleId"]) ?? null,
      issuerWallet: readEventString(event, ["issuer_wallet", "issuerWallet", "issuer"]),
      recipientWallet,
      amount,
      cycleFrequency:
        readEventString(event, ["cycle_frequency", "cycleFrequency", "frequency"]) ?? null,
      txHash: event.txHash ?? null,
      ledgerSequence: Number.isFinite(event.ledger) ? String(event.ledger) : null,
      claimedAt: this.eventTimestamp(event),
    });

    await this.invalidateWallet(recipientWallet);
  }

  /**
   * Reads the per-wallet allocation list from the event payload. Contracts
   * emit either a list of `{ wallet, amount }` records or two parallel arrays;
   * both shapes are accepted so a contract revision does not silently zero out
   * every holder's claimable balance.
   */
  private readAllocations(
    event: DecodedSorobanEvent,
    issuerWallet: string,
    cycleFrequency: string | null
  ): Array<{
    allocationId: string;
    distributionId: string | null;
    issuerWallet: string;
    recipientWallet: string;
    amount: string;
    cycleFrequency: string | null;
    txHash: string | null;
    ledgerSequence: string | null;
    distributedAt: Date;
  }> {
    const data = event.data;
    const records = this.extractRecipientRecords(data);
    if (records.length === 0) return [];

    // One event fans out to many holders, so the recipient index is always part
    // of the allocation id. Reusing a top-level `allocation_id` verbatim would
    // make every row in a distribution collapse onto the same key.
    const eventAllocationId = this.readEventField(event, ["allocation_id", "allocationId"]);
    const eventKey = eventAllocationId ?? event.txHash ?? event.id;

    return records.map((record, index) => ({
      allocationId: `${eventKey}:${index}`,
      distributionId: this.readEventField(event, ["distribution_id", "distributionId"]),
      issuerWallet,
      recipientWallet: record.wallet,
      amount: record.amount,
      cycleFrequency,
      txHash: event.txHash ?? null,
      ledgerSequence: Number.isFinite(event.ledger) ? String(event.ledger) : null,
      distributedAt: this.eventTimestamp(event),
    }));
  }

  private extractRecipientRecords(
    data: unknown
  ): Array<{ wallet: string; amount: string }> {
    if (!data || typeof data !== "object") return [];

    const record = data as Record<string, unknown>;
    const holderKeys = ["recipients", "allocations", "holders", "beneficiaries", "payouts"];
    let entries: unknown[] | null = null;

    for (const key of holderKeys) {
      const value = record[key];
      if (Array.isArray(value)) {
        entries = value;
        break;
      }
      if (value instanceof Set) {
        entries = [...value];
        break;
      }
    }

    const wallets = this.toStringArray(record.wallets ?? record.holders);
    const amounts = this.toStringArray(record.amounts);

    // Some contract revisions emit the allocation as two parallel arrays rather
    // than a list of records, so both shapes are accepted.
    if (!entries) {
      if (!wallets || !amounts) return [];
      return wallets
        .map((wallet, index) => ({ wallet, amount: amounts[index] }))
        .filter((entry) => entry.wallet && entry.amount)
        .map((entry) => ({ wallet: entry.wallet, amount: this.normalizeAmount(entry.amount) }));
    }

    const records: Array<{ wallet: string; amount: string }> = [];
    entries.forEach((entry, index) => {
      if (typeof entry === "string") {
        const amount = amounts?.[index];
        if (amount) records.push({ wallet: entry, amount: this.normalizeAmount(amount) });
        return;
      }
      if (!entry || typeof entry !== "object") return;
      const holder = entry as Record<string, unknown>;
      const wallet = this.firstString(holder, ["wallet", "address", "recipient", "holder", "account"]);
      const amount = this.tryDecimal(
        holder.amount ?? holder.value ?? holder.share ?? holder.allocated ?? holder.payout
      );
      if (wallet && amount) records.push({ wallet, amount: amount.toFixed(AMOUNT_SCALE) });
    });

    return records;
  }

  /** Fixes an allocation amount to the entity's decimal scale. */
  private normalizeAmount(value: string): string {
    return (this.tryDecimal(value) ?? new Decimal(0)).toFixed(AMOUNT_SCALE);
  }

  private toStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    return value.map((entry) => {
      if (typeof entry === "string") return entry;
      if (typeof entry === "bigint") return entry.toString();
      if (typeof entry === "number") return String(entry);
      return "";
    });
  }

  private firstString(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }

  private readEventField(event: DecodedSorobanEvent, keys: string[]): string | null {
    return readEventString(event, keys);
  }

  private sumAmounts(allocations: Array<{ amount: string }>): string {
    return allocations
      .reduce((total, allocation) => total.plus(allocation.amount), new Decimal(0))
      .toFixed(AMOUNT_SCALE);
  }

  private async loadCycles(wallet: string): Promise<CycleTotals[]> {
    const [allocations, claims] = await Promise.all([
      this.dividendRepository.allocationsByWallet(wallet),
      this.dividendRepository.claimsByWallet(wallet),
    ]);

    const byCycle = new Map<string, CycleTotals>();
    const touch = (cycleId: string): CycleTotals => {
      const existing = byCycle.get(cycleId);
      if (existing) return existing;
      const created: CycleTotals = {
        cycleId,
        cycleFrequency: null,
        distributedAt: null,
        claimedAt: null,
        txHash: null,
        earned: new Decimal(0),
        claimed: new Decimal(0),
      };
      byCycle.set(cycleId, created);
      return created;
    };

    for (const allocation of allocations) {
      const cycleId = allocation.distributionId ?? allocation.allocationId;
      const cycle = touch(cycleId);
      cycle.earned = cycle.earned.plus(this.toDecimal(allocation.amount));
      cycle.cycleFrequency = allocation.cycleFrequency ?? cycle.cycleFrequency;
      cycle.distributedAt = allocation.distributedAt ?? cycle.distributedAt;
      cycle.txHash = allocation.txHash ?? cycle.txHash;
    }

    for (const claim of claims) {
      const cycleId = claim.distributionId ?? `claim:${claim.claimId}`;
      const cycle = touch(cycleId);
      cycle.claimed = cycle.claimed.plus(this.toDecimal(claim.amount));
      cycle.cycleFrequency = claim.cycleFrequency ?? cycle.cycleFrequency;
      cycle.claimedAt = cycle.claimedAt ?? claim.claimedAt;
    }

    return [...byCycle.values()].sort(
      (a, b) => this.timeOf(b.distributedAt) - this.timeOf(a.distributedAt)
    );
  }

  private buildClaimableView(
    wallet: string,
    cycles: CycleTotals[]
  ): DividendClaimableView {
    const cycleViews: DividendCycleClaimableView[] = cycles.map((cycle) => {
      const earned = cycle.earned.toFixed(AMOUNT_SCALE);
      const claimed = cycle.claimed.toFixed(AMOUNT_SCALE);
      const claimable = cycle.earned.minus(cycle.claimed);
      return {
        cycleId: cycle.cycleId,
        cycleFrequency: cycle.cycleFrequency,
        distributedAt: cycle.distributedAt ? new Date(cycle.distributedAt).toISOString() : null,
        txHash: cycle.txHash,
        earned,
        claimed,
        claimable: (claimable.isNegative() ? new Decimal(0) : claimable).toFixed(AMOUNT_SCALE),
      };
    });

    const totalEarned = cycleViews.reduce(
      (total, cycle) => total.plus(cycle.earned),
      new Decimal(0)
    );
    const totalClaimed = cycleViews.reduce(
      (total, cycle) => total.plus(cycle.claimed),
      new Decimal(0)
    );
    const totalClaimable = cycleViews.reduce(
      (total, cycle) => total.plus(cycle.claimable),
      new Decimal(0)
    );

    return {
      wallet,
      cycles: cycleViews,
      totalEarned: totalEarned.toFixed(AMOUNT_SCALE),
      totalClaimed: totalClaimed.toFixed(AMOUNT_SCALE),
      totalClaimable: totalClaimable.toFixed(AMOUNT_SCALE),
      computedAt: this.now().toISOString(),
    };
  }

  private toClaimView(row: DividendClaim): DividendClaimView {
    return {
      claimId: row.claimId,
      distributionId: row.distributionId ?? null,
      issuerWallet: row.issuerWallet ?? null,
      cycleFrequency: row.cycleFrequency ?? null,
      amount: this.toDecimal(row.amount).toFixed(AMOUNT_SCALE),
      txHash: row.txHash ?? null,
      ledgerSequence: row.ledgerSequence ?? null,
      claimedAt: row.claimedAt ? new Date(row.claimedAt).toISOString() : null,
    };
  }

  private readAmount(event: DecodedSorobanEvent, keys: string[]): string | null {
    const parsed = this.tryDecimal(this.readEventField(event, keys));
    return parsed ? parsed.toFixed(AMOUNT_SCALE) : null;
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

  private toDecimal(value: string): Decimal {
    return this.tryDecimal(value) ?? new Decimal(0);
  }

  private eventTimestamp(event: DecodedSorobanEvent): Date {
    if (event.ledgerClosedAt) {
      const closed = new Date(event.ledgerClosedAt);
      if (!Number.isNaN(closed.getTime())) return closed;
    }
    return this.now();
  }

  private timeOf(value: Date | null | undefined): number {
    return value ? new Date(value).getTime() : 0;
  }

  private normalizeLimit(value: number | undefined): number {
    if (!Number.isFinite(value) || (value as number) <= 0) return 20;
    return Math.min(100, Math.trunc(value as number));
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

  private cursorOffset(
    sorted: DividendClaim[],
    cursor: { claimedAt: Date; id: string }
  ): number {
    const index = sorted.findIndex((row) => {
      const at = this.timeOf(row.claimedAt);
      return at < cursor.claimedAt.getTime() || (at === cursor.claimedAt.getTime() && row.id > cursor.id);
    });
    return index < 0 ? sorted.length : index;
  }

  private formatCursor(row: DividendClaim): string {
    return `${new Date(row.claimedAt ?? this.now()).toISOString()}|${row.id}`;
  }

  private rememberCacheKey(wallet: string, key: string): void {
    const keys = this.cacheKeysByWallet.get(wallet) ?? new Set<string>();
    keys.add(key);
    this.cacheKeysByWallet.set(wallet, keys);
  }
}

export function createDividendDistributionService(
  dependencies: DividendDistributionServiceDependencies
): DividendDistributionService {
  return new DividendDistributionService(dependencies);
}
