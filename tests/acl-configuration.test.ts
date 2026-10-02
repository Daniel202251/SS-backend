import crypto from "node:crypto";

import { TtlCache } from "../src/lib/ttl-cache";
import {
  createAclService,
  type AclRepositoryContract,
  type AclUpdateInput,
} from "../src/services/acl.service";
import type { ContractAcl, AclStatus } from "../src/models/ContractAcl.model";
import type { ContractAclLog } from "../src/models/ContractAclLog.model";
import type { DecodedSorobanEvent } from "../src/types/soroban.types";

function makeEvent(
  overrides: Partial<DecodedSorobanEvent> & { topic: string }
): DecodedSorobanEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    contractId: "CACLMGR",
    ledger: 2000,
    ledgerClosedAt: "2026-01-01T00:00:00.000Z",
    txHash: "b".repeat(64),
    topics: [],
    data: null,
    inSuccessfulContractCall: true,
    ...overrides,
  };
}

interface FakeAclState {
  current: ContractAcl[];
  log: ContractAclLog[];
}

/** Distinct timestamps, so newest-first ordering is deterministic. */
function makeClock(startMs = Date.parse("2026-01-01T00:00:00.000Z")) {
  let tick = 0;
  return () => new Date(startMs + tick++ * 1000);
}

function fakeAclRepository(
  state: FakeAclState,
  now: () => Date = makeClock()
): AclRepositoryContract & {
  findActiveCalls: number;
  updates: number;
} {
  const repo = {
    findActiveCalls: 0,
    updates: 0,
    async findActive() {
      repo.findActiveCalls += 1;
      return state.current.filter((entry) => entry.status === "active");
    },
    async findHistory({ limit, offset }: { limit: number; offset?: number }) {
      // Newest first, mirroring the real repository's `createdAt DESC` order.
      const newestFirst = [...state.log].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)
      );
      return newestFirst.slice(offset ?? 0, (offset ?? 0) + limit);
    },
    async applyUpdate(update: AclUpdateInput) {
      repo.updates += 1;
      const existing = state.current.find(
        (entry) => entry.contractAddress === update.contractAddress
      );
      const status: AclStatus = update.action === "remove" ? "removed" : "active";

      if (existing) {
        existing.permittedFunctions = update.permittedFunctions;
        existing.status = status;
        existing.removedAt = status === "removed" ? new Date() : null;
      } else {
        state.current.push({
          id: crypto.randomUUID(),
          contractAddress: update.contractAddress,
          permittedFunctions: update.permittedFunctions,
          status,
          addedAt: new Date(),
          removedAt: null,
          lastLedger: update.ledgerSequence,
          lastTxHash: update.txHash,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as ContractAcl);
      }

      state.log.push({
        id: crypto.randomUUID(),
        contractAddress: update.contractAddress,
        action: update.action,
        permittedFunctions: update.permittedFunctions,
        ledgerSequence: update.ledgerSequence,
        txHash: update.txHash,
        actor: update.actor,
        createdAt: now(),
      } as ContractAclLog);
    },
  };
  return repo;
}

describe("Issue #543: ACL configuration for whitelisted contract integrations", () => {
  it("syncs the whitelist from ACLUpdated events and exposes permitted functions", async () => {
    const state: FakeAclState = { current: [], log: [] };
    const service = createAclService({ aclRepository: fakeAclRepository(state) });

    await service.handle(
      makeEvent({
        topic: "acl_updated",
        topics: ["acl_updated", "CINTEGRATION"],
        data: {
          action: "add",
          permitted_functions: ["submit_invoice", "settle"],
          actor: "GADMIN",
        },
      })
    );

    const acl = await service.getAcl();

    expect(acl.total).toBe(1);
    expect(acl.contracts[0].contractAddress).toBe("CINTEGRATION");
    expect(acl.contracts[0].permittedFunctions).toEqual(["submit_invoice", "settle"]);
    expect(acl.contracts[0].status).toBe("active");
  });

  it("removes a contract from the whitelist on a removal event but keeps the history", async () => {
    const state: FakeAclState = { current: [], log: [] };
    const service = createAclService({ aclRepository: fakeAclRepository(state) });

    await service.handle(
      makeEvent({
        topic: "acl_updated",
        topics: ["acl_updated", "CINTEGRATION"],
        data: { action: "add", permitted_functions: ["settle"] },
      })
    );
    await service.handle(
      makeEvent({
        topic: "acl_updated",
        topics: ["acl_updated", "CINTEGRATION"],
        data: { action: "remove", permitted_functions: [] },
      })
    );

    const acl = await service.getAcl();
    expect(acl.total).toBe(0);

    const log = await service.getAclLog();
    expect(log.map((entry) => entry.action)).toEqual(["remove", "add"]);
    expect(log[0].contractAddress).toBe("CINTEGRATION");
  });

  it("caches the ACL for five minutes and invalidates on a new event", async () => {
    const state: FakeAclState = { current: [], log: [] };
    const repository = fakeAclRepository(state);
    const service = createAclService({
      aclRepository: repository,
      cache: new TtlCache({ ttlSeconds: 300, namespace: "test-acl" }),
    });

    await service.getAcl();
    await service.getAcl();
    expect(repository.findActiveCalls).toBe(1);

    await service.handle(
      makeEvent({
        topic: "acl_updated",
        topics: ["acl_updated", "CNEW"],
        data: { action: "add", permitted_functions: ["buy"] },
      })
    );

    const refreshed = await service.getAcl();
    expect(repository.findActiveCalls).toBe(2);
    expect(refreshed.contracts.map((c) => c.contractAddress)).toEqual(["CNEW"]);
  });

  it("caps the ACL log page size and defaults to 50", async () => {
    const state: FakeAclState = { current: [], log: [] };
    const seen: number[] = [];
    const service = createAclService({
      aclRepository: {
        ...fakeAclRepository(state),
        async findHistory({ limit }: { limit: number; offset?: number }) {
          seen.push(limit);
          return [];
        },
      },
    });

    await service.getAclLog();
    await service.getAclLog({ limit: 5000 });
    await service.getAclLog({ limit: 0 });

    expect(seen).toEqual([50, 200, 1]);
  });

  it("ignores events without a contract address", async () => {
    const state: FakeAclState = { current: [], log: [] };
    const repository = fakeAclRepository(state);
    const service = createAclService({ aclRepository: repository });

    await service.handle(makeEvent({ topic: "acl_updated", topics: ["acl_updated"] }));

    expect(repository.updates).toBe(0);
  });
});
