import {
  ROYALTY_EARNINGS_CACHE_TTL_SECONDS,
  createRoyaltyEarningsService,
  type RoyaltyClaimInput,
  type RoyaltyEarningsRepositoryContract,
  type RoyaltyPaidInput,
} from "../../src/services/royalty-earnings.service";
import type { RoyaltyClaim } from "../../src/models/RoyaltyClaim.model";
import type { RoyaltyEvent } from "../../src/models/RoyaltyEvent.model";
import type { DecodedSorobanEvent } from "../../src/types/soroban.types";

const timeOf = (value: Date | null): number => (value ? value.getTime() : 0);

const CREATOR = "GCREATOR0000000000000000000000000000000000000000000000000000AA";
const OTHER_CREATOR = "GOTHER00000000000000000000000000000000000000000000000000000AA";

function makeEvent(overrides: Partial<DecodedSorobanEvent> = {}): DecodedSorobanEvent {
  return {
    id: "event-1",
    contractId: "CROYALTY",
    ledger: 1000,
    ledgerClosedAt: "2026-01-01T00:00:00.000Z",
    txHash: "tx-1",
    topic: "royalty_paid",
    topics: [],
    data: {},
    inSuccessfulContractCall: true,
    ...overrides,
  };
}

/** In-memory stand-in for the TypeORM adapter, preserving the idempotency rules. */
function fakeRepository() {
  const transfers: RoyaltyEvent[] = [];
  const claims: RoyaltyClaim[] = [];
  let sequence = 0;

  const repo: RoyaltyEarningsRepositoryContract = {
    async totalsByCreator(creatorWallet) {
      const rows = transfers.filter((row) => row.creatorWallet === creatorWallet);
      return {
        totalEarned: rows.reduce((sum, row) => sum + Number(row.amount), 0).toFixed(4),
        transferCount: rows.length,
      };
    },
    async listTransfers(creatorWallet, { limit, offset }) {
      return transfers
        .filter((row) => row.creatorWallet === creatorWallet)
        .sort((a, b) => timeOf(b.paidAt) - timeOf(a.paidAt))
        .slice(offset ?? 0, (offset ?? 0) + limit);
    },
    async claimTotalsByCreator(creatorWallet) {
      const rows = claims.filter((row) => row.creatorWallet === creatorWallet);
      return {
        totalClaimed: rows.reduce((sum, row) => sum + Number(row.amount), 0).toFixed(4),
        claimCount: rows.length,
      };
    },
    async listClaims(creatorWallet, { limit, cursor }) {
      const sorted = claims
        .filter((row) => row.creatorWallet === creatorWallet)
        .sort((a, b) => timeOf(b.claimedAt) - timeOf(a.claimedAt));
      const start = cursor
        ? sorted.findIndex(
            (row) =>
              timeOf(row.claimedAt) < cursor.claimedAt.getTime() ||
              (timeOf(row.claimedAt) === cursor.claimedAt.getTime() && row.id < cursor.id)
          )
        : 0;
      return sorted.slice(start < 0 ? sorted.length : start, (start < 0 ? sorted.length : start) + limit);
    },
    async recordRoyaltyPaid(input: RoyaltyPaidInput) {
      if (transfers.some((row) => row.txHash === input.txHash && row.ledgerSequence === input.ledgerSequence)) {
        return;
      }
      sequence += 1;
      transfers.push({
        id: `transfer-${sequence}`,
        keyAddress: input.keyAddress,
        creatorWallet: input.creatorWallet,
        buyerWallet: input.buyerWallet,
        amount: input.amount,
        txHash: input.txHash,
        ledgerSequence: input.ledgerSequence,
        paidAt: input.paidAt,
        createdAt: input.paidAt,
      } as RoyaltyEvent);
    },
    async recordRoyaltyClaim(input: RoyaltyClaimInput) {
      if (claims.some((row) => row.claimId === input.claimId)) return;
      sequence += 1;
      claims.push({
        id: `claim-row-${sequence}`,
        claimId: input.claimId,
        keyAddress: input.keyAddress,
        creatorWallet: input.creatorWallet,
        amount: input.amount,
        txHash: input.txHash,
        ledgerSequence: input.ledgerSequence,
        claimedAt: input.claimedAt,
        createdAt: input.claimedAt,
      } as RoyaltyClaim);
    },
  };

  return { repo, transfers, claims };
}

function royaltyPaidEvent(overrides: Partial<DecodedSorobanEvent> = {}): DecodedSorobanEvent {
  return makeEvent({
    topic: "royalty_paid",
    data: {
      key_address: "CKEY1",
      creator_wallet: CREATOR,
      buyer_wallet: "GBUYER000000000000000000000000000000000000000000000000000000AA",
      amount: "12.5",
    },
    ...overrides,
  });
}

function royaltyClaimedEvent(overrides: Partial<DecodedSorobanEvent> = {}): DecodedSorobanEvent {
  return makeEvent({
    id: "event-2",
    txHash: "tx-claim-1",
    ledger: 1100,
    topic: "royalty_claimed",
    data: { creator_wallet: CREATOR, amount: "5.0000", claim_id: "claim-1", key_address: "CKEY1" },
    ...overrides,
  });
}

describe("RoyaltyEarningsService (issue #537)", () => {
  it("uses a 30s cache TTL for royalty earnings", () => {
    expect(ROYALTY_EARNINGS_CACHE_TTL_SECONDS).toBe(30);
  });

  it("syncs RoyaltyPaid events into the per-transfer breakdown", async () => {
    const { repo, transfers } = fakeRepository();
    const service = createRoyaltyEarningsService({ royaltyRepository: repo });

    await service.handle(royaltyPaidEvent());
    await service.handle(
      royaltyPaidEvent({
        id: "event-1b",
        txHash: "tx-2",
        ledger: 1001,
        data: {
          key_address: "CKEY2",
          creator_wallet: CREATOR,
          buyer_wallet: "GBUYER000000000000000000000000000000000000000000000000000000AA",
          amount: 7.5,
        },
      })
    );

    const earnings = await service.getEarnings(CREATOR);
    expect(earnings.transferCount).toBe(2);
    expect(earnings.totalEarned).toBe("20.0000");
    expect(earnings.totalClaimed).toBe("0.0000");
    expect(earnings.pending).toBe("20.0000");
    expect(earnings.transfers).toHaveLength(2);
    expect(earnings.transfers.map((t) => t.keyAddress).sort()).toEqual(["CKEY1", "CKEY2"]);
    expect(transfers.every((row) => row.ledgerSequence !== null)).toBe(true);
  });

  it("ignores a replayed RoyaltyPaid event for the same transaction", async () => {
    const { repo } = fakeRepository();
    const service = createRoyaltyEarningsService({ royaltyRepository: repo });

    await service.handle(royaltyPaidEvent());
    await service.handle(royaltyPaidEvent());

    const earnings = await service.getEarnings(CREATOR);
    expect(earnings.transferCount).toBe(1);
    expect(earnings.totalEarned).toBe("12.5000");
  });

  it("reports pending as earned minus claimed and never goes negative", async () => {
    const { repo } = fakeRepository();
    const service = createRoyaltyEarningsService({ royaltyRepository: repo });

    await service.handle(royaltyPaidEvent());
    await service.handle(royaltyClaimedEvent());

    const earnings = await service.getEarnings(CREATOR);
    expect(earnings.totalEarned).toBe("12.5000");
    expect(earnings.totalClaimed).toBe("5.0000");
    expect(earnings.pending).toBe("7.5000");
    expect(earnings.claimCount).toBe(1);
  });

  it("clamps pending at zero when a claim exceeds recorded earnings", async () => {
    const { repo } = fakeRepository();
    const service = createRoyaltyEarningsService({ royaltyRepository: repo });

    await service.handle(
      royaltyClaimedEvent({
        data: { creator_wallet: CREATOR, amount: "100.0000", claim_id: "claim-big" },
      })
    );

    const earnings = await service.getEarnings(CREATOR);
    expect(earnings.pending).toBe("0.0000");
  });

  it("scopes earnings and history to the requested creator wallet", async () => {
    const { repo } = fakeRepository();
    const service = createRoyaltyEarningsService({ royaltyRepository: repo });

    await service.handle(royaltyPaidEvent());
    await service.handle(
      royaltyPaidEvent({
        id: "event-3",
        txHash: "tx-other",
        data: { key_address: "CKEY9", creator_wallet: OTHER_CREATOR, amount: "99.0000" },
      })
    );

    const earnings = await service.getEarnings(CREATOR);
    expect(earnings.transferCount).toBe(1);
    expect(earnings.totalEarned).toBe("12.5000");
  });

  it("returns claimed history with on-chain tx hashes and cursor pagination", async () => {
    const { repo } = fakeRepository();
    const service = createRoyaltyEarningsService({ royaltyRepository: repo });

    await service.handle(royaltyClaimedEvent());
    await service.handle(
      royaltyClaimedEvent({
        id: "event-3",
        txHash: "tx-claim-2",
        ledger: 1200,
        ledgerClosedAt: "2026-02-01T00:00:00.000Z",
        data: { creator_wallet: CREATOR, amount: "1.2500", claim_id: "claim-2" },
      })
    );

    const first = await service.getClaimHistory(CREATOR, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0].claimId).toBe("claim-2");
    expect(first.items[0].txHash).toBe("tx-claim-2");
    expect(first.items[0].amount).toBe("1.2500");
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await service.getClaimHistory(CREATOR, { limit: 1, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].claimId).toBe("claim-1");
    expect(second.items[0].txHash).toBe("tx-claim-1");
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("serves repeated reads from cache and invalidates on a new RoyaltyPaid event", async () => {
    const { repo } = fakeRepository();
    const service = createRoyaltyEarningsService({ royaltyRepository: repo });

    await service.handle(royaltyPaidEvent());
    const first = await service.getEarnings(CREATOR);
    const cached = await service.getEarnings(CREATOR);
    expect(cached).toEqual(first);

    await service.handle(
      royaltyPaidEvent({
        id: "event-4",
        txHash: "tx-fresh",
        data: { key_address: "CKEY1", creator_wallet: CREATOR, amount: "2.5000" },
      })
    );

    const afterEvent = await service.getEarnings(CREATOR);
    expect(afterEvent).not.toEqual(first);
    expect(afterEvent.totalEarned).toBe("15.0000");
  });

  it("pages the per-transfer breakdown until every royalty event is included", async () => {
    const { repo } = fakeRepository();
    const service = createRoyaltyEarningsService({ royaltyRepository: repo });

    const total = 12;
    for (let index = 0; index < total; index += 1) {
      await service.handle(
        royaltyPaidEvent({
          id: `event-${index}`,
          txHash: `tx-${index}`,
          data: { key_address: "CKEY1", creator_wallet: CREATOR, amount: "1.0000" },
        })
      );
    }

    // A page size of 5 means three pages have to be walked.
    const earnings = await service.getEarnings(CREATOR, { transferLimit: 5 });

    expect(earnings.transferCount).toBe(total);
    expect(earnings.transfers).toHaveLength(total);
    expect(earnings.totalEarned).toBe("12.0000");
  });

  it("skips events that carry no creator wallet", async () => {
    const { repo } = fakeRepository();
    const service = createRoyaltyEarningsService({ royaltyRepository: repo });

    await service.handle(
      royaltyPaidEvent({ data: { key_address: "CKEY1", amount: "1.0000" } })
    );
    await service.handle(royaltyClaimedEvent({ data: { amount: "1.0000" } }));

    const earnings = await service.getEarnings(CREATOR);
    expect(earnings.transferCount).toBe(0);
    expect(earnings.claimCount).toBe(0);
  });
});
