import {
  LEDGERS_PER_DAY,
  SUBSCRIPTION_STATUS_CACHE_TTL_SECONDS,
  createSubscriptionStatusService,
  type SubscriptionHoldingReader,
  type KeyHoldingReading,
} from "../../src/services/subscription-status.service";
import type { DecodedSorobanEvent } from "../../src/types/soroban.types";

const WALLET = "GHOLDER00000000000000000000000000000000000000000000000000000AA";
const OTHER_WALLET = "GOTHER00000000000000000000000000000000000000000000000000000AA";
const KEY_ID = "CKEYGATED00000000000000000000000000000000000000000000000000AA";

function makeEvent(overrides: Partial<DecodedSorobanEvent> = {}): DecodedSorobanEvent {
  return {
    id: "event-1",
    contractId: KEY_ID,
    ledger: 1_000_000,
    ledgerClosedAt: "2026-06-01T00:00:00.000Z",
    txHash: "tx-1",
    topic: "holding_changed",
    topics: [],
    data: {},
    inSuccessfulContractCall: true,
    ...overrides,
  };
}

function fakeReader(reading: Partial<KeyHoldingReading> = {}) {
  const state: KeyHoldingReading = {
    balance: "100",
    minBalance: "10",
    expiryLedger: null,
    ledger: 1_000_000,
    ...reading,
  };
  const calls: Array<{ wallet: string; keyId: string }> = [];

  const reader: SubscriptionHoldingReader = {
    async readHolding(input: { wallet: string; keyId: string }) {
      calls.push({ ...input });
      return state;
    },
  };

  return {
    reader,
    calls,
    state,
  };
}

describe("SubscriptionStatusService (issue #539)", () => {
  it("caches status for 30 seconds and assumes ~5s ledgers", () => {
    expect(SUBSCRIPTION_STATUS_CACHE_TTL_SECONDS).toBe(30);
    expect(LEDGERS_PER_DAY).toBe(17_280);
  });

  it("reports subscribed when the balance meets the contract minimum", async () => {
    const { reader } = fakeReader({ balance: "10", minBalance: "10" });
    const service = createSubscriptionStatusService({ holdingReader: reader });

    const status = await service.getStatus({ wallet: WALLET, keyId: KEY_ID });
    expect(status.subscribed).toBe(true);
    expect(status.balance).toBe("10");
    expect(status.minBalance).toBe("10");
    expect(status.daysRemaining).toBe(0);
  });

  it("reports not subscribed when the balance is below the minimum", async () => {
    const { reader } = fakeReader({ balance: "9", minBalance: "10" });
    const service = createSubscriptionStatusService({ holdingReader: reader });

    const status = await service.getStatus({ wallet: WALLET, keyId: KEY_ID });
    expect(status.subscribed).toBe(false);
    expect(status.daysRemaining).toBe(0);
  });

  it("treats a wallet with no holding as not subscribed", async () => {
    const { reader } = fakeReader({ balance: "0", minBalance: "10" });
    const service = createSubscriptionStatusService({ holdingReader: reader });

    const status = await service.getStatus({ wallet: WALLET, keyId: KEY_ID });
    expect(status.subscribed).toBe(false);
  });

  it("computes days remaining from the expiry ledger, rounding up", async () => {
    const { reader } = fakeReader({
      balance: "10",
      minBalance: "10",
      ledger: 1_000_000,
      expiryLedger: 1_000_000 + LEDGERS_PER_DAY * 3 + 1,
    });
    const service = createSubscriptionStatusService({ holdingReader: reader });

    const status = await service.getStatus({ wallet: WALLET, keyId: KEY_ID });
    expect(status.subscribed).toBe(true);
    expect(status.expiryLedger).toBe(1_000_000 + LEDGERS_PER_DAY * 3 + 1);
    expect(status.daysRemaining).toBe(4);
  });

  it("reports zero days remaining once access has lapsed", async () => {
    const { reader } = fakeReader({ ledger: 1_000_000, expiryLedger: 999_999 });
    const service = createSubscriptionStatusService({ holdingReader: reader });

    const status = await service.getStatus({ wallet: WALLET, keyId: KEY_ID });
    expect(status.subscribed).toBe(false);
    expect(status.daysRemaining).toBe(0);
  });

  it("serves a cached response without hitting the chain again", async () => {
    const { reader, calls } = fakeReader();
    const service = createSubscriptionStatusService({ holdingReader: reader });

    const first = await service.getStatus({ wallet: WALLET, keyId: KEY_ID });
    const second = await service.getStatus({ wallet: WALLET, keyId: KEY_ID });

    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("answers from cache well inside the latency budget", async () => {
    const { reader } = fakeReader();
    const service = createSubscriptionStatusService({ holdingReader: reader });

    await service.getStatus({ wallet: WALLET, keyId: KEY_ID });
    const started = Date.now();
    for (let i = 0; i < 50; i += 1) {
      await service.getStatus({ wallet: WALLET, keyId: KEY_ID });
    }
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("invalidates the cached status of the key named by a holding change event", async () => {
    const { reader, calls, state } = fakeReader();
    const service = createSubscriptionStatusService({ holdingReader: reader });

    await service.getStatus({ wallet: WALLET, keyId: KEY_ID });
    expect(calls).toHaveLength(1);

    await service.handle(makeEvent({ data: { key_id: KEY_ID } }));
    state.balance = "0";

    const afterEvent = await service.getStatus({ wallet: WALLET, keyId: KEY_ID });
    expect(calls).toHaveLength(2);
    expect(afterEvent.subscribed).toBe(false);
  });

  it("leaves other keys cached when a holding change event names one key", async () => {
    const { reader, calls } = fakeReader();
    const service = createSubscriptionStatusService({ holdingReader: reader });

    await service.getStatus({ wallet: WALLET, keyId: "COTHERKEY" });
    await service.getStatus({ wallet: OTHER_WALLET, keyId: "COTHERKEY" });
    expect(calls).toHaveLength(2);

    await service.handle(makeEvent({ data: { key_id: KEY_ID } }));
    await service.getStatus({ wallet: OTHER_WALLET, keyId: "COTHERKEY" });
    expect(calls).toHaveLength(2);
  });

  it("clears every cached status when a holding change event names no key", async () => {
    const { reader, calls } = fakeReader();
    const service = createSubscriptionStatusService({ holdingReader: reader });

    await service.getStatus({ wallet: WALLET, keyId: KEY_ID });
    await service.getStatus({ wallet: OTHER_WALLET, keyId: "COTHERKEY" });
    expect(calls).toHaveLength(2);

    await service.handle(makeEvent());
    await service.getStatus({ wallet: WALLET, keyId: KEY_ID });
    expect(calls).toHaveLength(3);
  });

  it("ignores events for other topics", async () => {
    const { reader, calls } = fakeReader();
    const service = createSubscriptionStatusService({ holdingReader: reader });

    await service.getStatus({ wallet: WALLET, keyId: KEY_ID });
    await service.handle(makeEvent({ topic: "royalty_paid" }));
    await service.getStatus({ wallet: WALLET, keyId: KEY_ID });

    expect(calls).toHaveLength(1);
  });
});
