import { computeInvestorReturn } from "../../../src/lib/investor-return";

function computeProRataDistribution(
  investorAmounts: bigint[],
  totalSettlementStroops: bigint,
  platformFeeBps: number
): { payouts: bigint[]; fee: bigint } {
  const totalFunded = investorAmounts.reduce((a, b) => a + b, 0n);
  const fee = (totalSettlementStroops * BigInt(platformFeeBps)) / 10_000n;
  const distributable = totalSettlementStroops - fee;

  const payouts = investorAmounts.map((amount) =>
    computeInvestorReturn(amount, totalFunded, distributable)
  );

  return { payouts, fee };
}

describe("Investment pro-rata yield distribution", () => {
  describe("2-investor splits", () => {
    it("60/40 split with 0% platform fee distributes exactly", () => {
      const investorA = 6_000_000_000_000n;
      const investorB = 4_000_000_000_000n;
      const settlement = 11_000_000_000_000n;

      const { payouts, fee } = computeProRataDistribution([investorA, investorB], settlement, 0);

      expect(fee).toBe(0n);
      expect(payouts[0] + payouts[1]).toBe(settlement);
      expect(payouts[0]).toBe(6_600_000_000_000n);
      expect(payouts[1]).toBe(4_400_000_000_000n);
    });

    it("60/40 split with 2.5% platform fee distributes exactly", () => {
      const investorA = 6_000_000_000_000n;
      const investorB = 4_000_000_000_000n;
      const settlement = 11_000_000_000_000n;

      const { payouts, fee } = computeProRataDistribution([investorA, investorB], settlement, 250);

      const expectedFee = (11_000_000_000_000n * 250n) / 10_000n;
      expect(fee).toBe(expectedFee);
      expect(payouts[0] + payouts[1] + fee).toBe(settlement);
    });

    it("50/50 split distributes equally", () => {
      const settlement = 10_000_000_000_000n;

      const { payouts } = computeProRataDistribution(
        [5_000_000_000_000n, 5_000_000_000_000n],
        settlement,
        0
      );

      expect(payouts[0]).toBe(payouts[1]);
      expect(payouts[0] + payouts[1]).toBe(settlement);
    });
  });

  describe("3-investor splits", () => {
    it("equal 3-way split with 1% fee sums to settlement minus fee", () => {
      const amount = 3_000_000_000_000n;
      const settlement = 10_000_000_000_000n;

      const { payouts, fee } = computeProRataDistribution(
        [amount, amount, amount],
        settlement,
        100
      );

      const expectedFee = (settlement * 100n) / 10_000n;
      expect(fee).toBe(expectedFee);
      expect(payouts[0] + payouts[1] + payouts[2] + fee).toBe(settlement);
      expect(payouts[0]).toBe(payouts[1]);
      expect(payouts[1]).toBe(payouts[2]);
    });

    it("70/20/10 split with 2.5% fee sums to settlement minus fee", () => {
      const investorA = 7_000_000_000_000n;
      const investorB = 2_000_000_000_000n;
      const investorC = 1_000_000_000_000n;
      const settlement = 12_000_000_000_000n;

      const { payouts, fee } = computeProRataDistribution(
        [investorA, investorB, investorC],
        settlement,
        250
      );

      const expectedFee = (settlement * 250n) / 10_000n;
      expect(fee).toBe(expectedFee);
      expect(payouts[0] + payouts[1] + payouts[2] + fee).toBe(settlement);
      expect(payouts[0]).toBeGreaterThan(payouts[1]);
      expect(payouts[1]).toBeGreaterThan(payouts[2]);
    });
  });

  describe("10-investor micro-investor split", () => {
    it("10 equal investors with 0% fee: total sums exactly to settlement", () => {
      const perInvestor = 1_000_000_000_000n;
      const investors = Array(10).fill(perInvestor) as bigint[];
      const settlement = perInvestor * 10n;

      const { payouts, fee } = computeProRataDistribution(investors, settlement, 0);

      expect(fee).toBe(0n);
      const totalPayout = payouts.reduce((a, b) => a + b, 0n);
      expect(totalPayout).toBe(settlement);
      expect(payouts.every((p) => p === payouts[0])).toBe(true);
    });

    it("10 equal investors with 2.5% fee: total + fee equals settlement", () => {
      const perInvestor = 1_000_000_000_000n;
      const investors = Array(10).fill(perInvestor) as bigint[];
      const settlement = perInvestor * 10n + 500_000_000_000n;

      const { payouts, fee } = computeProRataDistribution(investors, settlement, 250);

      const expectedFee = (settlement * 250n) / 10_000n;
      expect(fee).toBe(expectedFee);
      const totalPayout = payouts.reduce((a, b) => a + b, 0n);
      expect(totalPayout + fee).toBe(settlement);
    });

    it("10 unequal investors with 1% fee: total + fee equals settlement", () => {
      const investors = [
        5_000_000_000_000n,
        3_000_000_000_000n,
        2_000_000_000_000n,
        1_500_000_000_000n,
        1_000_000_000_000n,
        800_000_000_000n,
        600_000_000_000n,
        400_000_000_000n,
        200_000_000_000n,
        100_000_000_000n,
      ];
      const settlement = 15_000_000_000_000n;

      const { payouts, fee } = computeProRataDistribution(investors, settlement, 100);

      const expectedFee = (settlement * 100n) / 10_000n;
      expect(fee).toBe(expectedFee);
      const totalPayout = payouts.reduce((a, b) => a + b, 0n);
      const remainder = settlement - (totalPayout + fee);
      expect(remainder).toBeGreaterThanOrEqual(0n);
      expect(remainder).toBeLessThanOrEqual(BigInt(investors.length));
    });
  });

  describe("fractional stroop remainders", () => {
    it("1/3 split produces floor-rounded values that sum within 1 stroop", () => {
      const amount = 1_000_000_000_000n;
      const settlement = 10_000_000_000_003n;

      const { payouts } = computeProRataDistribution([amount, amount, amount], settlement, 0);

      const totalPayout = payouts.reduce((a, b) => a + b, 0n);
      expect(totalPayout).toBeLessThanOrEqual(settlement);
      expect(settlement - totalPayout).toBeLessThanOrEqual(3n);
    });

    it("asymmetric split with odd settlement leaves at most a few stroops unallocated", () => {
      const investors = [3_333_333_333_333n, 6_666_666_666_667n];
      const settlement = 9_999_999_999_999n;

      const { payouts } = computeProRataDistribution(investors, settlement, 0);

      const totalPayout = payouts.reduce((a, b) => a + b, 0n);
      expect(totalPayout).toBeLessThanOrEqual(settlement);
      expect(settlement - totalPayout).toBeLessThanOrEqual(1n);
    });
  });

  describe("single investor 100%", () => {
    it("single investor receives entire settlement with 0% fee", () => {
      const settlement = 7_500_000_000_000n;

      const { payouts, fee } = computeProRataDistribution([settlement], settlement, 0);

      expect(fee).toBe(0n);
      expect(payouts[0]).toBe(settlement);
    });

    it("single investor receives settlement minus fee with 1% fee", () => {
      const settlement = 7_500_000_000_000n;

      const { payouts, fee } = computeProRataDistribution([settlement], settlement, 100);

      const expectedFee = (settlement * 100n) / 10_000n;
      expect(fee).toBe(expectedFee);
      expect(payouts[0] + fee).toBe(settlement);
    });
  });

  describe("platform fee edge cases", () => {
    it("0% fee returns zero fee and full settlement as distributable", () => {
      const settlement = 10_000_000_000_000n;

      const { fee } = computeProRataDistribution(
        [5_000_000_000_000n, 5_000_000_000_000n],
        settlement,
        0
      );

      expect(fee).toBe(0n);
    });

    it("2.5% fee (250 bps) is calculated correctly", () => {
      const settlement = 100_000_000_000_000n;

      const { fee } = computeProRataDistribution(
        [50_000_000_000_000n, 50_000_000_000_000n],
        settlement,
        250
      );

      expect(fee).toBe(2_500_000_000_000n);
    });

    it("1% fee (100 bps) is calculated correctly", () => {
      const settlement = 100_000_000_000_000n;

      const { fee } = computeProRataDistribution([100_000_000_000_000n], settlement, 100);

      expect(fee).toBe(1_000_000_000_000n);
    });
  });

  describe("zero division and NaN safety", () => {
    it("throws RangeError when totalFunded is zero", () => {
      expect(() => computeInvestorReturn(0n, 0n, 1000n)).toThrow(RangeError);
    });

    it("returns 0 when investor amount is 0", () => {
      expect(computeInvestorReturn(0n, 5_000_000n, 10_000_000n)).toBe(0n);
    });

    it("returns 0 when settled proceeds is 0", () => {
      expect(computeInvestorReturn(5_000_000n, 5_000_000n, 0n)).toBe(0n);
    });

    it("does not produce NaN with very small amounts", () => {
      const result = computeInvestorReturn(1n, 3n, 10n);
      expect(typeof result).toBe("bigint");
      expect(Number.isNaN(result)).toBe(false);
    });

    it("does not produce Infinity with maximum bigint values", () => {
      const result = computeInvestorReturn(
        1_000_000_000_000n,
        1_000_000_000_001n,
        1_000_000_000_000n
      );
      expect(typeof result).toBe("bigint");
      expect(Number.isFinite(Number(result))).toBe(true);
    });
  });
});
