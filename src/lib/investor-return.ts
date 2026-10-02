/**
 * Computes an investor's pro-rata share of settled proceeds using pure
 * integer arithmetic. Division truncates toward zero, which for
 * non-negative bigint operands is equivalent to flooring — the investor
 * never receives more than their exact proportional share.
 */
export function computeInvestorReturn(
  investedAmount: bigint,
  totalFunded: bigint,
  settledProceeds: bigint
): bigint {
  if (totalFunded <= 0n) {
    throw new RangeError("totalFunded must be greater than zero");
  }
  if (investedAmount < 0n) {
    throw new RangeError("investedAmount must not be negative");
  }
  if (settledProceeds < 0n) {
    throw new RangeError("settledProceeds must not be negative");
  }

  return (investedAmount * settledProceeds) / totalFunded;
}
