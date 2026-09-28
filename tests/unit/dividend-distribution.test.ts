import {
  DIVIDEND_CACHE_TTL_SECONDS,
  createDividendDistributionService,
  type DividendClaimInput,
  type DividendDistributionInput,
  type DividendRepositoryContract,
} from "../../src/services/dividend-distribution.service";
import type { DividendAllocation } from "../../src/models/DividendAllocation.model";
import type { DividendClaim } from "../../src/models/DividendClaim.model";
import type { DecodedSorobanEvent } from "../../src/types/soroban.types";

const HOLDER = "GHOLDER00000000000000000000000000000000000000000000000000000AA";
const ISSUER = "GISSUER00000000000000000000000000000000000000000000000000000AA";

function makeEvent(overrides: Partial<DecodedSorobanEvent> = {}): DecodedSorobanEvent {
  return {
    id: "event-1",
    contractId: "CDIV",
    ledger: 500,
    ledgerClosedAt: "2026-03-01T00:00:00.000Z",
    txHash: "tx-dist-1",
    topic: "dividend_distributed",
    topics: [],
    data: {},
    inSuccessfulContractCall: true,
    ...overrides,
  };
}

function fakeRepository() {
  const distributions: DividendDistributionInput[] = [];
  const allocations: DividendAllocation[] = [];
  const claims: DividendClaim[] = [];
  let sequence = 0;

  const repo: DividendRepositoryContract = {
    async recordDistribution(input) {
      if (distributions.some((row) => row.txHash === input.txHash && row.ledgerSequence === input.ledgerSequence)) {
        return;
      }
      distributions.push(input);
    },
    async recordAllocations(inputs) {
      for (const input of inputs) {
        if (allocations.some((row) => row.allocationId === input.allocationId)) continue;
        sequence += 1;
        allocations.push({ id: `alloc-row-${sequence}`, ...input } as DividendAllocation);
      }
    },
    async recordClaim(input: DividendClaimInput) {
      if (claims.some((row) => row.claimId === input.claimId)) return;
      sequence += 1;
      claims.push({ id: `claim-row-${sequence}`, ...input } as DividendClaim);
    },
    async allocationsByWallet(wallet) {
      return allocations.filter((row) => row.recipientWallet === wallet);
    },
    async claimsByWallet(wallet) {
      return claims.filter((row) => row.recipientWallet === wallet);
    },
  };

  return { repo, distributions, allocations, claims };
}

function distributedEvent(overrides: Partial<DecodedSorobanEvent> = {}): DecodedSorobanEvent {
  return makeEvent({
    data: {
      issuer_wallet: ISSUER,
      cycle_frequency: "monthly",
      distribution_id: "cycle-1",
      recipients: [
        { wallet: HOLDER, amount: "30.0000" },
        { wallet: "GOTHER00000000000000000000000000000000000000000000000000000AA", amount: "70.0000" },
      ],
    },
    ...overrides,
  });
}

function claimedEvent(overrides: Partial<DecodedSorobanEvent> = {}): DecodedSorobanEvent {
  return makeEvent({
    id: "event-2",
    ledger: 600,
    ledgerClosedAt: "2026-03-15T00:00:00.000Z",
    txHash: "tx-claim-1",
    topic: "dividend_claimed",
    data: {
      recipient_wallet: HOLDER,
      amount: "10.0000",
      claim_id: "claim-1",
      distribution_id: "cycle-1",
      issuer_wallet: ISSUER,
      cycle_frequency: "monthly",
    },
    ...overrides,
  });
}

describe("DividendDistributionService (issue #538)", () => {
  it("uses a 30s cache TTL for holder dividend reads", () => {
    expect(DIVIDEND_CACHE_TTL_SECONDS).toBe(30);
  });

  it("syncs a distribution cycle and its per-wallet allocations", async () => {
    const { repo, distributions, allocations } = fakeRepository();
    const service = createDividendDistributionService({ dividendRepository: repo });

    await service.handle(distributedEvent());

    expect(distributions).toHaveLength(1);
    expect(distributions[0].totalAmount).toBe("100.0000");
    expect(distributions[0].recipientCount).toBe(2);
    expect(distributions[0].cycleFrequency).toBe("monthly");
    expect(allocations.map((row) => row.recipientWallet)).toContain(HOLDER);
  });

  it("does not duplicate a replayed distribution event", async () => {
    const { repo, distributions, allocations } = fakeRepository();
    const service = createDividendDistributionService({ dividendRepository: repo });

    await service.handle(distributedEvent());
    await service.handle(distributedEvent());

    expect(distributions).toHaveLength(1);
    expect(allocations).toHaveLength(2);
  });

  it("keeps every recipient when the event carries one top-level allocation id", async () => {
    const { repo, allocations } = fakeRepository();
    const service = createDividendDistributionService({ dividendRepository: repo });

    await service.handle(
      distributedEvent({
        data: {
          issuer_wallet: ISSUER,
          cycle_frequency: "monthly",
          distribution_id: "cycle-1",
          allocation_id: "batch-7",
          recipients: [
            { wallet: HOLDER, amount: "30.0000" },
            { wallet: "GOTHER00000000000000000000000000000000000000000000000000AA", amount: "70.0000" },
          ],
        },
      })
    );

    // A shared id would collapse the fan-out onto one row.
    expect(allocations).toHaveLength(2);
    expect(new Set(allocations.map((row) => row.allocationId)).size).toBe(2);
  });

  it("reports claimable amounts per cycle for the authenticated wallet", async () => {
    const { repo } = fakeRepository();
    const service = createDividendDistributionService({ dividendRepository: repo });

    await service.handle(distributedEvent());

    const claimable = await service.getClaimable(HOLDER);
    expect(claimable.cycles).toHaveLength(1);
    expect(claimable.cycles[0].earned).toBe("30.0000");
    expect(claimable.cycles[0].claimed).toBe("0.0000");
    expect(claimable.cycles[0].claimable).toBe("30.0000");
    expect(claimable.cycles[0].cycleFrequency).toBe("monthly");
    expect(claimable.cycles[0].txHash).toBe("tx-dist-1");
    expect(claimable.totalClaimable).toBe("30.0000");
  });

  it("reduces a cycle's claimable balance by the holder's claims", async () => {
    const { repo } = fakeRepository();
    const service = createDividendDistributionService({ dividendRepository: repo });

    await service.handle(distributedEvent());
    await service.handle(claimedEvent());

    const claimable = await service.getClaimable(HOLDER);
    expect(claimable.cycles[0].earned).toBe("30.0000");
    expect(claimable.cycles[0].claimed).toBe("10.0000");
    expect(claimable.cycles[0].claimable).toBe("20.0000");
    expect(claimable.totalClaimed).toBe("10.0000");
    expect(claimable.totalClaimable).toBe("20.0000");
  });

  it("returns claim history with tx hashes, newest first", async () => {
    const { repo } = fakeRepository();
    const service = createDividendDistributionService({ dividendRepository: repo });

    await service.handle(claimedEvent());
    await service.handle(
      claimedEvent({
        id: "event-3",
        txHash: "tx-claim-2",
        ledger: 700,
        ledgerClosedAt: "2026-04-01T00:00:00.000Z",
        data: {
          recipient_wallet: HOLDER,
          amount: "5.5000",
          claim_id: "claim-2",
          distribution_id: "cycle-1",
        },
      })
    );

    const page = await service.getClaimHistory(HOLDER);
    expect(page.items.map((item) => item.claimId)).toEqual(["claim-2", "claim-1"]);
    expect(page.items[0].txHash).toBe("tx-claim-2");
    expect(page.items[0].amount).toBe("5.5000");
    expect(page.items[1].txHash).toBe("tx-claim-1");
    expect(page.hasMore).toBe(false);
  });

  it("paginates claim history with a cursor", async () => {
    const { repo } = fakeRepository();
    const service = createDividendDistributionService({ dividendRepository: repo });

    await service.handle(claimedEvent());
    await service.handle(
      claimedEvent({
        id: "event-3",
        txHash: "tx-claim-2",
        ledger: 700,
        ledgerClosedAt: "2026-04-01T00:00:00.000Z",
        data: { recipient_wallet: HOLDER, amount: "5.5000", claim_id: "claim-2" },
      })
    );

    const first = await service.getClaimHistory(HOLDER, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);

    const second = await service.getClaimHistory(HOLDER, { limit: 1, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].claimId).toBe("claim-1");
    expect(second.hasMore).toBe(false);
  });

  it("aggregates summary totals across all cycles", async () => {
    const { repo } = fakeRepository();
    const service = createDividendDistributionService({ dividendRepository: repo });

    await service.handle(distributedEvent());
    await service.handle(
      distributedEvent({
        id: "event-4",
        txHash: "tx-dist-2",
        ledger: 800,
        ledgerClosedAt: "2026-05-01T00:00:00.000Z",
        data: {
          issuer_wallet: ISSUER,
          cycle_frequency: "quarterly",
          distribution_id: "cycle-2",
          recipients: [{ wallet: HOLDER, amount: "12.0000" }],
        },
      })
    );
    await service.handle(claimedEvent());

    const summary = await service.getSummary(HOLDER);
    expect(summary.cycleCount).toBe(2);
    expect(summary.totalEarned).toBe("42.0000");
    expect(summary.totalClaimed).toBe("10.0000");
    expect(summary.totalPending).toBe("32.0000");
  });

  it("serves cached reads and invalidates on a new distribution or claim", async () => {
    const { repo } = fakeRepository();
    const service = createDividendDistributionService({ dividendRepository: repo });

    await service.handle(distributedEvent());
    const first = await service.getClaimable(HOLDER);
    expect(await service.getClaimable(HOLDER)).toEqual(first);

    await service.handle(claimedEvent());
    const afterClaim = await service.getClaimable(HOLDER);
    expect(afterClaim.totalClaimable).toBe("20.0000");

    await service.handle(
      distributedEvent({
        id: "event-5",
        txHash: "tx-dist-3",
        ledger: 900,
        data: {
          issuer_wallet: ISSUER,
          distribution_id: "cycle-3",
          recipients: [{ wallet: HOLDER, amount: "1.0000" }],
        },
      })
    );
    const afterDistribution = await service.getClaimable(HOLDER);
    expect(afterDistribution.totalClaimable).toBe("21.0000");
  });

  it("skips events that carry no issuer or recipient wallet", async () => {
    const { repo, distributions, claims } = fakeRepository();
    const service = createDividendDistributionService({ dividendRepository: repo });

    await service.handle(makeEvent({ data: { recipients: [] } }));
    await service.handle(claimedEvent({ data: { amount: "1.0000" } }));

    expect(distributions).toHaveLength(0);
    expect(claims).toHaveLength(0);
  });
});
