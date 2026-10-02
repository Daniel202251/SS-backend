import { computeInvestorReturn } from "../src/lib/investor-return";

describe("computeInvestorReturn", () => {
  it("computes the correct return when division is exact", () => {
    expect(computeInvestorReturn(2000n, 4000n, 4400n)).toBe(2200n);
  });

  it("floors the result when division is not exact (repeating fractional ratios), without rounding up", () => {
    // (1000 * 1000) / 3000 = 333.33... -> floors to 333
    expect(computeInvestorReturn(1000n, 3000n, 1000n)).toBe(333n);
  });

  it("handles repeating fractional ratios correctly in edge cases", () => {
    // e.g., 2/3 of 1000 = 666
    expect(computeInvestorReturn(2000n, 3000n, 1000n)).toBe(666n);
  });

  it("returns 0 when yield (settledProceeds) is zero", () => {
    expect(computeInvestorReturn(1000n, 5000n, 0n)).toBe(0n);
  });

  it("handles maximum supported yield without overflow and exact division", () => {
    // 64-bit signed integer max
    const int64Max = 9223372036854775807n;
    expect(computeInvestorReturn(1000n, 2000n, int64Max)).toBe(int64Max / 2n);
  });

  it("returns the full settled proceeds when investedAmount equals totalFunded", () => {
    expect(computeInvestorReturn(5000n, 5000n, 7500n)).toBe(7500n);
  });

  it("returns 0 when investedAmount is 0", () => {
    expect(computeInvestorReturn(0n, 5000n, 7500n)).toBe(0n);
  });

  it("throws when totalFunded is zero or negative", () => {
    expect(() => computeInvestorReturn(100n, 0n, 100n)).toThrow(RangeError);
    expect(() => computeInvestorReturn(100n, -100n, 100n)).toThrow(RangeError);
  });

  it("throws on negative investedAmount or settledProceeds", () => {
    expect(() => computeInvestorReturn(-1n, 1000n, 1000n)).toThrow(RangeError);
    expect(() => computeInvestorReturn(1n, 1000n, -1000n)).toThrow(RangeError);
  });

  it("asserts integer output at the service boundary (bigint return type)", () => {
    const result = computeInvestorReturn(1000n, 3000n, 1000n);
    expect(typeof result).toBe("bigint");
  });
});
