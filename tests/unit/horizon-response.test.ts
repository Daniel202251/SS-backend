import {
  HorizonValidationError,
  normalizeHorizonPayment,
  normalizeHorizonTransaction,
} from "../../src/utils/horizon-response";

describe("Horizon response normalization", () => {
  it("normalizes optional memo variants without throwing", () => {
    expect(normalizeHorizonTransaction({ successful: true, memo_type: "text" })).toMatchObject({
      successful: true,
      memo: null,
      memoType: "text",
    });
    expect(
      normalizeHorizonPayment({ type: "payment", amount: "5", to: "GABC", asset_code: "USDC" })
    ).toMatchObject({
      destination: "GABC",
      assetCode: "USDC",
      assetIssuer: null,
    });
  });

  it("returns typed validation errors for malformed required fields", () => {
    expect(() => normalizeHorizonTransaction({})).toThrow(HorizonValidationError);
    expect(() => normalizeHorizonPayment({ type: "payment", amount: 5 })).toThrow(
      HorizonValidationError
    );
  });
});
