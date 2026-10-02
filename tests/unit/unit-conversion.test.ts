import Decimal from "decimal.js";
import { stroopsToXlm, xlmToStroops } from "../../src/utils/unit-conversion.utils";

describe("stroopsToXlm", () => {
  it("converts 10,000,000 stroops to 1.0000000 XLM", () => {
    expect(stroopsToXlm(10_000_000n)).toBe("1.0000000");
  });

  it("converts 1 stroop to 0.0000001 XLM", () => {
    expect(stroopsToXlm(1n)).toBe("0.0000001");
  });

  it("converts 0 stroops to 0.0000000 XLM", () => {
    expect(stroopsToXlm(0n)).toBe("0.0000000");
  });

  it("converts 100,000 XLM worth of stroops without floating point error", () => {
    // 100,000 XLM = 1,000,000,000,000 stroops
    const stroops = 100_000n * 10_000_000n;
    expect(stroopsToXlm(stroops)).toBe("100000.0000000");
  });

  it("handles large values above MAX_SAFE_INTEGER without precision loss", () => {
    // Number.MAX_SAFE_INTEGER (9007199254740991) whole XLM, in stroops
    const stroops = 9_007_199_254_740_991n * 10_000_000n;
    expect(stroopsToXlm(stroops)).toBe("9007199254740991.0000000");
  });

  it("handles string input for bigint", () => {
    expect(stroopsToXlm("10000000")).toBe("1.0000000");
    expect(stroopsToXlm("1")).toBe("0.0000001");
  });

  it("handles fractional stroop amounts correctly (truncation)", () => {
    // Fractional stroop concept: 1 stroop is the minimum unit
    // So 0.5 stroop doesn't exist, but we test boundary
    expect(stroopsToXlm(0n)).toBe("0.0000000");
  });
});

describe("xlmToStroops", () => {
  it("converts 1 XLM to 10,000,000 stroops", () => {
    expect(xlmToStroops("1.0000000")).toBe(10_000_000n);
  });

  it("converts 0.0000001 XLM to 1 stroop", () => {
    expect(xlmToStroops("0.0000001")).toBe(1n);
  });

  it("converts 0 XLM to 0 stroops", () => {
    expect(xlmToStroops("0")).toBe(0n);
  });

  it("converts 100,000 XLM to stroops correctly", () => {
    expect(xlmToStroops("100000")).toBe(1_000_000_000_000n);
  });

  it("converts string input with decimals correctly", () => {
    expect(xlmToStroops("1.5")).toBe(15_000_000n);
    expect(xlmToStroops("0.5")).toBe(5_000_000n);
  });

  it("converts number input correctly", () => {
    expect(xlmToStroops(1)).toBe(10_000_000n);
    expect(xlmToStroops(0)).toBe(0n);
  });

  it("rounds down fractional stroops to the nearest stroop", () => {
    // 0.00000015 XLM would be 1.5 stroops, should round down to 1
    expect(xlmToStroops("0.00000015")).toBe(1n);
  });
});

describe("stroopsToXlm / xlmToStroops round-trip", () => {
  it("round-trips correctly for whole XLM amounts", () => {
    const xlmAmounts = ["0", "1", "100", "10000", "100000"];

    for (const xlm of xlmAmounts) {
      const stroops = xlmToStroops(xlm);
      const backToXlm = stroopsToXlm(stroops);
      expect(backToXlm).toBe(new Decimal(xlm).toFixed(7));
    }
  });

  it("round-trips correctly for common stroop amounts", () => {
    const stroopAmounts = [0n, 1n, 10n, 100n, 1000n, 10_000_000n, 1_000_000_000_000n];

    for (const stroops of stroopAmounts) {
      const xlm = stroopsToXlm(stroops);
      const backToStroops = xlmToStroops(xlm);
      expect(backToStroops).toBe(stroops);
    }
  });

  it("round-trip is accurate for values that could be affected by floating point", () => {
    // These values are problematic with regular JS floating point math
    const testValues = ["0.1", "0.2", "0.3", "0.7", "1.0000001", "999999.9999999", "1234.5678901"];

    for (const xlm of testValues) {
      const stroops = xlmToStroops(xlm);
      const backToXlm = stroopsToXlm(stroops);
      expect(backToXlm).toBe(new Decimal(xlm).toFixed(7));
    }
  });
});
