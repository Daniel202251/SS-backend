import type { DataSource } from "typeorm";

import { TtlCache } from "../lib/ttl-cache";
import type { AppLogger } from "../observability/logger";
import { logger as globalLogger } from "../observability/logger";
import type { DecodedSorobanEvent } from "../types/soroban.types";
import { ACL_CACHE_TTL_SECONDS, createAclService, type AclService } from "./acl.service";
import { createAtomicSwapService, type AtomicSwapService } from "./atomic-swap.service";
import { ContractEventBus, type ContractEventHandler } from "./contract-event-bus.service";
import {
  BUY_LIMIT_CACHE_TTL_SECONDS,
  createCreatorKeyService,
  type CreatorKeyService,
} from "./creator-key.service";
import {
  createCurveMigrationService,
  type AdminNotifier,
  type CurveMigrationService,
} from "./curve-migration.service";
import {
  createAclRepository,
  createCreatorKeyRepository,
  createCurveMigrationRepository,
  createSwapRepository,
} from "./onchain-projection-repositories";

export interface OnchainProjections {
  creatorKeyService: CreatorKeyService;
  aclService: AclService;
  curveMigrationService: CurveMigrationService;
  swapService: AtomicSwapService;
  /** Handed to `EventIndexerService` so polled events feed the projections. */
  eventBus: ContractEventBus;
  /** Direct entry point for replaying already-decoded events. */
  syncEvents(events: DecodedSorobanEvent[]): Promise<number>;
}

export interface OnchainProjectionsDependencies {
  dataSource: DataSource;
  logger?: AppLogger;
  buyLimitCache?: TtlCache;
  aclCache?: TtlCache;
  adminNotifier?: AdminNotifier;
}

/**
 * Wires the read models that are derived from Soroban contract events
 * (creator key config, ACL whitelist, curve migrations, atomic swaps) against
 * the database, and registers them on a shared event bus.
 */
export function createOnchainProjections({
  dataSource,
  logger = globalLogger,
  buyLimitCache,
  aclCache,
  adminNotifier,
}: OnchainProjectionsDependencies): OnchainProjections {
  const creatorKeyService = createCreatorKeyService({
    creatorKeyRepository: createCreatorKeyRepository(dataSource),
    cache:
      buyLimitCache ??
      new TtlCache({
        ttlSeconds: BUY_LIMIT_CACHE_TTL_SECONDS,
        namespace: "creator-keys",
        enabled: true,
      }),
  });

  const aclService = createAclService({
    aclRepository: createAclRepository(dataSource),
    cache:
      aclCache ??
      new TtlCache({ ttlSeconds: ACL_CACHE_TTL_SECONDS, namespace: "acl", enabled: true }),
  });

  const curveMigrationService = createCurveMigrationService({
    curveMigrationRepository: createCurveMigrationRepository(dataSource),
    ...(adminNotifier ? { adminNotifier } : {}),
  });

  const swapService = createAtomicSwapService({ swapRepository: createSwapRepository(dataSource) });

  const handlers: ContractEventHandler[] = [
    creatorKeyService,
    aclService,
    curveMigrationService,
    swapService,
  ];
  const eventBus = new ContractEventBus({ handlers, logger });

  return {
    creatorKeyService,
    aclService,
    curveMigrationService,
    swapService,
    eventBus,
    async syncEvents(events) {
      let handled = 0;
      for (const event of events) {
        handled += await eventBus.dispatch(event);
      }
      return handled;
    },
  };
}
