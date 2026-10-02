import Decimal from "decimal.js";

const BASIS_POINTS_DIVISOR = new Decimal(10_000);
const MONEY_DECIMAL_PLACES = 2;

export function calculatePlatformFee(amount: Decimal, feeBps: number): Decimal {
  return amount
    .mul(feeBps)
    .div(BASIS_POINTS_DIVISOR)
    .toDecimalPlaces(MONEY_DECIMAL_PLACES, Decimal.ROUND_HALF_UP);
}
