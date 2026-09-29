import { TtlCache } from "../lib/ttl-cache";
import { HttpError } from "../utils/http-error";
import type { DecodedSorobanEvent } from "../types/soroban.types";
import type { CreatorKey } from "../models/CreatorKey.model";
import {
  readEventNumber,
  readEventString,
  type ContractEventHandler,
} from "./contract-event-bus.service";

/** Cache lifetime for key limit/detail projections. */
export const BUY_LIMIT_CACHE_TTL_SECONDS = 60;

export const CREATOR_KEY_EVENTS = {
  keyConfigUpdated: "key_config_updated",
} as const;

export interface CreatorKeyRepositoryContract {
  findById(id: string): Promise<CreatorKey | null>;
  findByContractAddress(contractAddress: string): Promise<CreatorKey | null>;
  applyConfigUpdate(
    keyId: string,
    update: { maxBuyPerTx?: string; maxBuyPerDay?: string; currentSupply?: string }
  ): Promise<CreatorKey | null>;
}

export interface BuyLimitResponse {
  keyId: string;
  maxBuyPerTx: string;
  maxBuyPerDay: string;
  currentSupply: string;
  curveType: string;
  configVersion: number;
  isActive: boolean;
  contractAddress: string;
  cachedAt: string;
}

export interface CreatorKeyDetail extends BuyLimitResponse {
  creatorId: string;
  creatorWallet: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatorKeyServiceDependencies {
  creatorKeyRepository: CreatorKeyRepositoryContract;
  cache?: TtlCache;
  cacheTtlSeconds?: number;
}

/**
 * Read model for creator keys: exposes the per-transaction buy cap so the
 * frontend can clamp the buy input before signing, and keeps the projection
 * fresh from `KeyConfigUpdated` contract events.
 */
export class CreatorKeyService implements ContractEventHandler {
  private readonly creatorKeyRepository: CreatorKeyRepositoryContract;
  private readonly cache: TtlCache;
  private readonly cacheTtlSeconds: number;

  constructor({
    creatorKeyRepository,
    cache,
    cacheTtlSeconds = BUY_LIMIT_CACHE_TTL_SECONDS,
  }: CreatorKeyServiceDependencies) {
    this.creatorKeyRepository = creatorKeyRepository;
    this.cacheTtlSeconds = cacheTtlSeconds;
    this.cache =
      cache ??
      new TtlCache({
        ttlSeconds: cacheTtlSeconds,
        namespace: "creator-keys",
        enabled: true,
      });
  }

  topics(): string[] {
    return [CREATOR_KEY_EVENTS.keyConfigUpdated, "creator_key_config_updated"];
  }

  /**
   * `GET /keys/:id/buy-limit` payload. Public read: no auth required, since it
   * only exposes caps that are already enforced on-chain.
   */
  async getBuyLimit(keyId: string): Promise<BuyLimitResponse> {
    const id = this.normalizeId(keyId);
    const cacheKey = `buy-limit:${id}`;

    const cached = await this.cache.get<BuyLimitResponse>(cacheKey);
    if (cached) return cached;

    const key = await this.loadKey(id);
    const payload = this.toBuyLimit(key);
    await this.cache.set(cacheKey, payload, this.cacheTtlSeconds);
    return payload;
  }

  /** Key detail reuses the cached buy limit so detail pages stay under 100ms. */
  async getKeyDetail(keyId: string): Promise<CreatorKeyDetail> {
    const id = this.normalizeId(keyId);
    const cacheKey = `detail:${id}`;

    const cached = await this.cache.get<CreatorKeyDetail>(cacheKey);
    if (cached) return cached;

    const key = await this.loadKey(id);
    const detail: CreatorKeyDetail = {
      ...this.toBuyLimit(key),
      creatorId: key.creatorId,
      creatorWallet: key.creatorWallet,
      createdAt: new Date(key.createdAt).toISOString(),
      updatedAt: new Date(key.updatedAt).toISOString(),
    };

    await this.cache.set(cacheKey, detail, this.cacheTtlSeconds);
    return detail;
  }

  /** Cache invalidation, also used by the contract-event projection below. */
  async invalidate(keyId: string): Promise<void> {
    const id = this.normalizeId(keyId);
    await Promise.all([this.cache.delete(`buy-limit:${id}`), this.cache.delete(`detail:${id}`)]);
  }

  /**
   * Applies a `KeyConfigUpdated` event: updates the stored caps and drops the
   * cached projections so the next read reflects on-chain state immediately.
   */
  async handle(event: DecodedSorobanEvent): Promise<void> {
    const keyId = readEventString(event, ["key_id", "keyId", "id", "0"], 1);
    if (!keyId) return;

    const maxBuyPerTx = readEventNumber(event, ["max_buy_per_tx", "maxBuyPerTx"]);
    const maxBuyPerDay = readEventNumber(event, ["max_buy_per_day", "maxBuyPerDay"]);
    const supply = readEventNumber(event, ["current_supply", "currentSupply", "supply"]);

    await this.creatorKeyRepository.applyConfigUpdate(keyId, {
      maxBuyPerTx: maxBuyPerTx === null ? undefined : String(maxBuyPerTx),
      maxBuyPerDay: maxBuyPerDay === null ? undefined : String(maxBuyPerDay),
      currentSupply: supply === null ? undefined : String(supply),
    });

    await this.invalidate(keyId);
  }

  private async loadKey(id: string): Promise<CreatorKey> {
    const key = await this.creatorKeyRepository.findById(id);
    if (!key) {
      throw new HttpError(404, "Creator key not found.");
    }
    return key;
  }

  private normalizeId(keyId: string): string {
    if (typeof keyId !== "string" || !keyId.trim()) {
      throw new HttpError(400, "A creator key id is required.");
    }
    return keyId.trim();
  }

  private toBuyLimit(key: CreatorKey): BuyLimitResponse {
    return {
      keyId: key.id,
      maxBuyPerTx: key.maxBuyPerTx,
      maxBuyPerDay: key.maxBuyPerDay,
      currentSupply: key.currentSupply,
      curveType: key.curveType,
      configVersion: key.configVersion,
      isActive: key.isActive,
      contractAddress: key.contractAddress,
      cachedAt: new Date().toISOString(),
    };
  }
}

export function createCreatorKeyService(
  dependencies: CreatorKeyServiceDependencies
): CreatorKeyService {
  return new CreatorKeyService(dependencies);
}
