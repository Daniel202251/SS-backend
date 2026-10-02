import {
  calculateInvestmentShares,
  InvestmentShareInput,
} from "../../../src/utils/investment-share-calculator.utils";

describe("Investment Share Calculator", () => {
  it("should calculate exact percentages for a three-way split with remainder assigned to the first investor", () => {
    const investments: InvestmentShareInput[] = [
      { id: "inv1", amount: 3000n },
      { id: "inv2", amount: 3000n },
      { id: "inv3", amount: 3000n },
    ];

    const results = calculateInvestmentShares(investments);

    expect(results).toHaveLength(3);
    expect(results[0].percentage).toBe(34);
    expect(results[1].percentage).toBe(33);
    expect(results[2].percentage).toBe(33);

    const sum = results.reduce((acc, r) => acc + r.percentage, 0);
    expect(sum).toBe(100);
  });

  it("should calculate exact percentages for a 25/75 split", () => {
    const investments: InvestmentShareInput[] = [
      { id: "inv1", amount: 2500n },
      { id: "inv2", amount: 7500n },
    ];

    const results = calculateInvestmentShares(investments);

    expect(results).toHaveLength(2);
    expect(results[0].percentage).toBe(25);
    expect(results[1].percentage).toBe(75);

    const sum = results.reduce((acc, r) => acc + r.percentage, 0);
    expect(sum).toBe(100);
  });

  it("should return 100% for a single investor", () => {
    const investments: InvestmentShareInput[] = [
      { id: "inv1", amount: 5000n },
    ];

    const results = calculateInvestmentShares(investments);

    expect(results).toHaveLength(1);
    expect(results[0].percentage).toBe(100);

    const sum = results.reduce((acc, r) => acc + r.percentage, 0);
    expect(sum).toBe(100);
  });

  it("should assign the remainder to the investor with the largest commitment", () => {
    const investments: InvestmentShareInput[] = [
      { id: "inv1", amount: 3000n },
      { id: "inv2", amount: 3001n },
      { id: "inv3", amount: 3000n },
    ];

    const results = calculateInvestmentShares(investments);

    expect(results).toHaveLength(3);
    // Base is 33% for everyone, sum is 99%, remainder is 1%
    // The largest is inv2 (3001). So it gets 34%
    expect(results[0].percentage).toBe(33);
    expect(results[1].percentage).toBe(34);
    expect(results[2].percentage).toBe(33);

    const sum = results.reduce((acc, r) => acc + r.percentage, 0);
    expect(sum).toBe(100);
  });

  it("should always sum to exactly 100%", () => {
    const investments: InvestmentShareInput[] = [
      { id: "inv1", amount: 1234n },
      { id: "inv2", amount: 5678n },
      { id: "inv3", amount: 9012n },
      { id: "inv4", amount: 3456n },
    ];

    const results = calculateInvestmentShares(investments);
    
    const sum = results.reduce((acc, r) => acc + r.percentage, 0);
    expect(sum).toBe(100);
  });

  it("should return 0 percentages if total amount is 0", () => {
    const investments: InvestmentShareInput[] = [
      { id: "inv1", amount: 0n },
      { id: "inv2", amount: 0n },
    ];

    const results = calculateInvestmentShares(investments);
    expect(results[0].percentage).toBe(0);
    expect(results[1].percentage).toBe(0);
  });

  it("should return empty array for empty input", () => {
    const results = calculateInvestmentShares([]);
    expect(results).toEqual([]);
  });
});
