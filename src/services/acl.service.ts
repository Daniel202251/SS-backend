import { TtlCache } from "../lib/ttl-cache";
import { HttpError } from "../utils/http-error";
import type { DecodedSorobanEvent } from "../types/soroban.types";
import type { ContractAcl } from "../models/ContractAcl.model";
import type { AclLogAction } from "../models/ContractAclLog.model";
import type { ContractAclLog } from "../models/ContractAclLog.model";
import {
  readEventString,
  readEventStringList,
  type ContractEventHandler,
} from "./contract-event-bus.service";

/** ACL projections change rarely; a 5 minute cache keeps the endpoint cheap. */
export const ACL_CACHE_TTL_SECONDS = 300;

export const ACL_EVENTS = {
  aclUpdated: "acl_updated",
} as const;

export interface AclUpdateInput {
  contractAddress: string;
  permittedFunctions: string[];
  action: AclLogAction;
  ledgerSequence: string | null;
  txHash: string | null;
  actor: string | null;
  occurredAt?: Date;
}

export interface AclRepositoryContract {
  findActive(): Promise<ContractAcl[]>;
  findHistory(options: { limit: number; offset?: number }): Promise<ContractAclLog[]>;
  applyUpdate(update: AclUpdateInput): Promise<void>;
}

export interface AclContractView {
  contractAddress: string;
  permittedFunctions: string[];
  status: string;
  addedAt: string;
  removedAt: string | null;
  lastLedger: string | null;
  lastTxHash: string | null;
}

export interface AclSnapshot {
  contracts: AclContractView[];
  total: number;
  cachedAt: string;
}

export interface AclLogView {
  id: string;
  contractAddress: string;
  action: AclLogAction;
  permittedFunctions: string[];
  ledgerSequence: string | null;
  txHash: string | null;
  actor: string | null;
  createdAt: string;
}

export interface AclServiceDependencies {
  aclRepository: AclRepositoryContract;
  cache?: TtlCache;
  cacheTtlSeconds?: number;
  logger?: { error: (obj: unknown, msg?: string) => void };
}

/**
 * Read model for the on-chain ACL that governs whitelisted contract
 * integrations. Populated exclusively from `ACLUpdated` contract events, so
 * what admins read here matches what the chain enforces.
 */
export class AclService implements ContractEventHandler {
  private readonly aclRepository: AclRepositoryContract;
  private readonly cache: TtlCache;
  private readonly cacheTtlSeconds: number;

  constructor({
    aclRepository,
    cache,
    cacheTtlSeconds = ACL_CACHE_TTL_SECONDS,
  }: AclServiceDependencies) {
    this.aclRepository = aclRepository;
    this.cacheTtlSeconds = cacheTtlSeconds;
    this.cache =
      cache ?? new TtlCache({ ttlSeconds: cacheTtlSeconds, namespace: "acl", enabled: true });
  }

  topics(): string[] {
    return [ACL_EVENTS.aclUpdated];
  }

  /** GET /admin/acl payload: every whitelisted contract and its functions. */
  async getAcl(): Promise<AclSnapshot> {
    const cached = await this.cache.get<AclSnapshot>("current");
    if (cached) return cached;

    const entries = await this.aclRepository.findActive();
    const snapshot: AclSnapshot = {
      contracts: entries.map((entry) => this.toView(entry)),
      total: entries.length,
      cachedAt: new Date().toISOString(),
    };

    await this.cache.set("current", snapshot, this.cacheTtlSeconds);
    return snapshot;
  }

  /** GET /admin/acl/log payload: add/remove history, newest first. */
  async getAclLog(options: { limit?: number; offset?: number } = {}): Promise<AclLogView[]> {
    const limit = this.normalizeLimit(options.limit);
    const offset =
      Number.isSafeInteger(options.offset) && (options.offset as number) > 0
        ? (options.offset as number)
        : 0;

    const entries = await this.aclRepository.findHistory({ limit, offset });
    return entries.map((entry) => this.toLogView(entry));
  }

  /** Cache invalidation, also invoked after every `ACLUpdated` event. */
  async invalidate(): Promise<void> {
    await this.cache.delete("current");
  }

  /**
   * Projects an `ACLUpdated` event into the current ACL plus its audit log and
   * drops the cached snapshot so the next admin read is immediately accurate.
   */
  async handle(event: DecodedSorobanEvent): Promise<void> {
    const contractAddress = readEventString(
      event,
      ["contract_address", "contractAddress", "contract", "0"],
      1
    );
    if (!contractAddress) return;

    const permittedFunctions = readEventStringList(event, [
      "permitted_functions",
      "permittedFunctions",
      "functions",
    ]);
    const action = this.resolveAction(event, permittedFunctions);

    await this.aclRepository.applyUpdate({
      contractAddress,
      permittedFunctions,
      action,
      ledgerSequence: Number.isFinite(event.ledger) ? String(event.ledger) : null,
      txHash: event.txHash ?? null,
      actor: readEventString(event, ["actor", "admin", "updated_by"], 2),
    });

    await this.invalidate();
  }

  private resolveAction(event: DecodedSorobanEvent, permittedFunctions: string[]): AclLogAction {
    const explicit = readEventString(event, ["action", "event", "operation"]);
    if (explicit && /remove|revoke|delete|disable/i.test(explicit)) return "remove";
    if (explicit && /add|grant|whitelist|enable/i.test(explicit)) return "add";

    const data = event.data as Record<string, unknown> | null;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      if (data.active === false || data.whitelisted === false || data.removed === true) {
        return "remove";
      }
    }

    // A removal carries no permitted functions, so an empty list is treated as
    // a removal rather than a whitelist with no callable functions.
    return permittedFunctions.length === 0 ? "remove" : "add";
  }

  private normalizeLimit(limit?: number): number {
    if (!Number.isFinite(limit)) return 50;
    return Math.min(200, Math.max(1, Math.trunc(limit as number)));
  }

  private toView(entry: ContractAcl): AclContractView {
    return {
      contractAddress: entry.contractAddress,
      permittedFunctions: entry.permittedFunctions ?? [],
      status: entry.status,
      addedAt: new Date(entry.addedAt).toISOString(),
      removedAt: entry.removedAt ? new Date(entry.removedAt).toISOString() : null,
      lastLedger: entry.lastLedger ?? null,
      lastTxHash: entry.lastTxHash ?? null,
    };
  }

  private toLogView(entry: ContractAclLog): AclLogView {
    return {
      id: entry.id,
      contractAddress: entry.contractAddress,
      action: entry.action,
      permittedFunctions: entry.permittedFunctions ?? [],
      ledgerSequence: entry.ledgerSequence ?? null,
      txHash: entry.txHash ?? null,
      actor: entry.actor ?? null,
      createdAt: new Date(entry.createdAt).toISOString(),
    };
  }
}

export function createAclService(dependencies: AclServiceDependencies): AclService {
  return new AclService(dependencies);
}

/** Fails fast on a malformed ACL request instead of silently returning []. */
export function assertValidContractAddress(contractAddress: string): void {
  if (!/^[A-Z0-9]{1,64}$/i.test(contractAddress)) {
    throw new HttpError(400, "Invalid contract address.");
  }
}
