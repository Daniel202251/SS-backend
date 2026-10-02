import crypto from "node:crypto";

import { TtlCache } from "../src/lib/ttl-cache";
import {
  createCreatorKeyService,
  type CreatorKeyRepositoryContract,
} from "../src/services/creator-key.service";
import {
  createCurveMigrationService,
  type CurveMigrationRepositoryContract,
} from "../src/services/curve-migration.service";
import type { CreatorKey } from "../src/models/CreatorKey.model";
import type { CurveMigration } from "../src/models/CurveMigration.model";
import type { DecodedSorobanEvent } from "../src/types/soroban.types";

function makeEvent(
  overrides: Partial<DecodedSorobanEvent> & { topic: string }
): DecodedSorobanEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    contractId: "CONTRACT",
    ledger: 1000,
    ledgerClosedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    txHash: "a".repeat(64),
    topics: [],
    data: null,
    inSuccessfulContractCall: true,
    ...overrides,
  };
}

function makeKey(overrides: Partial<CreatorKey> = {}): CreatorKey {
  return {
    id: "key-1",
    creatorId: "user-1",
    creatorWallet: "GKEYCREATOR",
    contractAddress: "CKEY",
    maxBuyPerTx: "500.0000000",
    maxBuyPerDay: "2000.0000000",
    currentSupply: "1000.0000000",
    curveType: "constant_product",
    configVersion: 3,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as CreatorKey;
}

function fakeKeyRepository(keys: CreatorKey[]): CreatorKeyRepositoryContract & {
  findByIdCalls: number;
} {
  const repo = {
    findByIdCalls: 0,
    async findById(id: string) {
      repo.findByIdCalls += 1;
      return keys.find((key) => key.id === id) ?? null;
    },
    async findByContractAddress(contractAddress: string) {
      return keys.find((key) => key.contractAddress === contractAddress) ?? null;
    },
    async applyConfigUpdate(keyId: string, update: Record<string, string | undefined>) {
      const key = keys.find((k) => k.id === keyId);
      if (!key) return null;
      if (update.maxBuyPerTx !== undefined) key.maxBuyPerTx = update.maxBuyPerTx;
      if (update.maxBuyPerDay !== undefined) key.maxBuyPerDay = update.maxBuyPerDay;
      if (update.currentSupply !== undefined) key.currentSupply = update.currentSupply;
      key.configVersion += 1;
      return key;
    },
  };
  return repo;
}

describe("Issue #542: per-transaction buy limit for creator keys", () => {
  it("returns max_buy_per_tx and current supply from the key configuration", async () => {
    const service = createCreatorKeyService({
      creatorKeyRepository: fakeKeyRepository([makeKey()]),
    });

    const result = await service.getBuyLimit("key-1");

    expect(result.maxBuyPerTx).toBe("500.0000000");
    expect(result.currentSupply).toBe("1000.0000000");
    expect(result.maxBuyPerDay).toBe("2000.0000000");
    expect(result.keyId).toBe("key-1");
  });

  it("includes the limit in the key detail response", async () => {
    const service = createCreatorKeyService({
      creatorKeyRepository: fakeKeyRepository([makeKey()]),
    });

    const detail = await service.getKeyDetail("key-1");

    expect(detail.maxBuyPerTx).toBe("500.0000000");
    expect(detail.currentSupply).toBe("1000.0000000");
    expect(detail.creatorWallet).toBe("GKEYCREATOR");
  });

  it("serves repeat reads from the 60s cache", async () => {
    const repository = fakeKeyRepository([makeKey()]);
    const service = createCreatorKeyService({
      creatorKeyRepository: repository,
      cache: new TtlCache({ ttlSeconds: 60, namespace: "test-keys" }),
    });

    const first = await service.getBuyLimit("key-1");
    const second = await service.getBuyLimit("key-1");

    expect(repository.findByIdCalls).toBe(1);
    expect(second.maxBuyPerTx).toBe(first.maxBuyPerTx);
  });

  it("invalidates the cache and applies new limits on a key config update event", async () => {
    const keys = [makeKey()];
    const repository = fakeKeyRepository(keys);
    const service = createCreatorKeyService({
      creatorKeyRepository: repository,
      cache: new TtlCache({ ttlSeconds: 60, namespace: "test-keys" }),
    });

    await service.getBuyLimit("key-1");
    expect(repository.findByIdCalls).toBe(1);

    await service.handle(
      makeEvent({
        topic: "key_config_updated",
        topics: ["key_config_updated", "key-1"],
        data: { max_buy_per_tx: 750, max_buy_per_day: 3000, current_supply: 1500 },
      })
    );

    const updated = await service.getBuyLimit("key-1");
    expect(updated.maxBuyPerTx).toBe("750");
    expect(updated.currentSupply).toBe("1500");
    expect(keys[0].configVersion).toBe(4);
  });

  it("404s for an unknown key and 400s for a missing id", async () => {
    const service = createCreatorKeyService({
      creatorKeyRepository: fakeKeyRepository([]),
    });

    await expect(service.getBuyLimit("missing")).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.getBuyLimit("  ")).rejects.toMatchObject({ statusCode: 400 });
  });
});

function makeMigration(overrides: Partial<CurveMigration> = {}): CurveMigration {
  return {
    id: "mig-1",
    keyId: "key-1",
    proposalId: "proposal-1",
    contractAddress: "CCURVE",
    status: "pending",
    proposedParams: { curveType: "linear", alpha: 1 },
    appliedParams: null,
    timelockExpiry: new Date("2026-01-02T00:00:00.000Z"),
    proposedAt: new Date("2026-01-01T00:00:00.000Z"),
    executedAt: null,
    proposalTxHash: "p".repeat(64),
    executionTxHash: null,
    ledgerSequence: "1000",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as CurveMigration;
}

function fakeMigrationRepository(rows: CurveMigration[]): CurveMigrationRepositoryContract {
  return {
    async findByKeyId(keyId) {
      return rows.filter((row) => row.keyId === keyId);
    },
    async recordProposal(input) {
      const existing = rows.find((row) => row.proposalId === input.proposalId);
      if (existing) return existing;
      const created = makeMigration({ ...input, id: `mig-${rows.length + 1}` });
      rows.push(created);
      return created;
    },
    async recordExecution(proposalId, input) {
      const row = rows.find((r) => r.proposalId === proposalId);
      if (!row) return null;
      row.status = "executed";
      row.appliedParams = input.appliedParams;
      row.executedAt = input.executedAt;
      row.executionTxHash = input.executionTxHash;
      return row;
    },
  };
}

describe("Issue #544: curve migration proposal tracking", () => {
  it("records proposals with the timelock expiry resolved from the event", async () => {
    const rows: CurveMigration[] = [];
    const service = createCurveMigrationService({
      curveMigrationRepository: fakeMigrationRepository(rows),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    await service.handle(
      makeEvent({
        topic: "curve_migration_proposed",
        topics: ["curve_migration_proposed", "key-1", "proposal-9"],
        data: {
          timelock: 86400,
          proposed_params: { curveType: "linear", alpha: 2 },
        },
      })
    );

    expect(rows).toHaveLength(1);
    const result = await service.listForKey("key-1");
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0].migrationId).toBe("proposal-9");
    expect(result.pending[0].status).toBe("pending");
    expect(result.pending[0].timelockExpiry).toBe("2026-01-02T00:00:00.000Z");
    expect(result.pending[0].proposedParams).toEqual({ curveType: "linear", alpha: 2 });
  });

  it("marks a migration expired once its timelock has elapsed without execution", async () => {
    const rows = [makeMigration({ timelockExpiry: new Date("2025-12-31T00:00:00.000Z") })];
    const service = createCurveMigrationService({
      curveMigrationRepository: fakeMigrationRepository(rows),
      now: () => new Date("2026-01-05T00:00:00.000Z"),
    });

    const result = await service.listForKey("key-1");

    expect(result.pending[0].status).toBe("expired");
    expect(result.pending[0].timelockExpired).toBe(true);
  });

  it("applies executed params, timestamps it and notifies admins", async () => {
    const rows = [makeMigration()];
    const notifications: unknown[] = [];
    const service = createCurveMigrationService({
      curveMigrationRepository: fakeMigrationRepository(rows),
      now: () => new Date("2026-01-03T00:00:00.000Z"),
      adminNotifier: {
        async notifyMigrationExecuted(payload) {
          notifications.push(payload);
        },
      },
    });

    await service.handle(
      makeEvent({
        topic: "curve_migration_executed",
        topics: ["curve_migration_executed", "proposal-1"],
        data: { applied_params: { curveType: "linear", alpha: 3 } },
        ledger: 1200,
        txHash: "e".repeat(64),
        ledgerClosedAt: "2026-01-03T12:00:00.000Z",
      })
    );

    const result = await service.listForKey("key-1");
    expect(result.pending).toHaveLength(0);
    expect(result.executed).toHaveLength(1);
    expect(result.executed[0].status).toBe("executed");
    expect(result.executed[0].appliedParams).toEqual({ curveType: "linear", alpha: 3 });
    expect(result.executed[0].executedAt).toBe("2026-01-03T12:00:00.000Z");

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ migrationId: "proposal-1", keyId: "key-1" });
  });
});
