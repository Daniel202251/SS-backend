import crypto from "node:crypto";

import { EventIndexerService } from "../src/services/stellar/event-indexer.service";
import {
  ContractEventBus,
  normalizeTopic,
  readEventNumber,
  readEventString,
  readEventStringList,
  type ContractEventHandler,
} from "../src/services/contract-event-bus.service";
import type { DecodedSorobanEvent } from "../src/types/soroban.types";

function makeEvent(overrides: Partial<DecodedSorobanEvent> = {}): DecodedSorobanEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    contractId: "C",
    ledger: 10,
    ledgerClosedAt: "2026-01-01T00:00:00.000Z",
    txHash: "f".repeat(64),
    topic: "acl_updated",
    topics: [],
    data: null,
    inSuccessfulContractCall: true,
    ...overrides,
  };
}

describe("contract event bus", () => {
  it("normalises CamelCase and kebab-case topics", () => {
    expect(normalizeTopic("ACLUpdated")).toBe("aclupdated");
    expect(normalizeTopic("acl-updated")).toBe("acl_updated");
    expect(normalizeTopic("  Curve Migration Proposed ")).toBe("curve_migration_proposed");
  });

  it("routes an event to the handlers subscribed to its topic", async () => {
    const seen: string[] = [];
    const bus = new ContractEventBus({
      handlers: [
        { topics: () => ["acl_updated"], handle: async () => void seen.push("acl") },
        { topics: () => ["curve_migration_executed"], handle: async () => void seen.push("curve") },
      ],
    });

    expect(await bus.dispatch(makeEvent({ topic: "acl_updated" }))).toBe(1);
    expect(seen).toEqual(["acl"]);

    expect(await bus.dispatch(makeEvent({ topic: "unrelated" }))).toBe(0);
  });

  it("isolates handler failures", async () => {
    const seen: string[] = [];
    const bus = new ContractEventBus({
      handlers: [
        {
          topics: () => ["acl_updated"],
          handle: async () => {
            throw new Error("boom");
          },
        },
        { topics: () => ["acl_updated"], handle: async () => void seen.push("survivor") },
      ],
    });

    expect(await bus.dispatch(makeEvent({ topic: "acl_updated" }))).toBe(1);
    expect(seen).toEqual(["survivor"]);
  });
});

describe("event indexer integration", () => {
  it("dispatches ingested events to the registered projections", async () => {
    const seen: string[] = [];
    const handler: ContractEventHandler = {
      topics: () => ["atomic_swap_executed"],
      handle: async (event) => void seen.push(event.topic),
    };
    const bus = new ContractEventBus({ handlers: [handler] });
    const indexer = new EventIndexerService({ contractIds: ["C"], eventBus: bus });

    expect(await indexer.ingestEvents([makeEvent({ topic: "atomic_swap_executed" })])).toBe(1);
    expect(seen).toEqual(["atomic_swap_executed"]);
  });

  it("still ingests when no bus is configured", async () => {
    const indexer = new EventIndexerService({ contractIds: ["C"] });
    expect(await indexer.ingestEvents([makeEvent()])).toBe(1);
  });
});

describe("event payload readers", () => {
  it("reads strings from data or indexed topics", () => {
    expect(
      readEventString(makeEvent({ data: { contract_address: "CABC" } }), ["contract_address"])
    ).toBe("CABC");
    expect(readEventString(makeEvent({ topics: ["acl_updated", "CTOPIC"] }), ["key_id"], 1)).toBe(
      "CTOPIC"
    );
    expect(readEventString(makeEvent(), ["key_id"], 1)).toBeNull();
  });

  it("reads numbers across representations", () => {
    expect(readEventNumber(makeEvent({ data: { fee: "12" } }), ["fee"])).toBe(12);
    expect(readEventNumber(makeEvent({ data: { fee: 7n } }), ["fee"])).toBe(7);
    expect(readEventNumber(makeEvent(), ["fee"])).toBeNull();
  });

  it("reads function lists from arrays and json", () => {
    expect(readEventStringList(makeEvent({ data: ["a", "b"] }), ["functions"])).toEqual(["a", "b"]);
    expect(
      readEventStringList(makeEvent({ data: { permitted_functions: ["settle"] } }), [
        "permitted_functions",
      ])
    ).toEqual(["settle"]);
    expect(readEventStringList(makeEvent(), ["functions"])).toEqual([]);
  });
});
