const STROOP_DECIMALS = 7;

/**
 * Converts an amount in stroops (1 XLM = 10,000,000 stroops) to a decimal
 * XLM string, using integer arithmetic throughout to avoid floating point
 * error on large balances.
 *
 * @param stroops  Amount in stroops
 * @param decimals Number of decimal places to display (default: 7, full stroop precision)
 */
export function stroopsToXlm(stroops: bigint, decimals: number = STROOP_DECIMALS): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;

  const divisor = 10n ** BigInt(STROOP_DECIMALS);
  const whole = abs / divisor;
  const remainderStroops = abs % divisor;

  // Pad the stroop remainder out to full precision, then round/truncate to
  // the requested number of decimal places.
  const fullFraction = remainderStroops.toString().padStart(STROOP_DECIMALS, "0");
  const fraction =
    decimals <= STROOP_DECIMALS
      ? fullFraction.slice(0, decimals)
      : fullFraction.padEnd(decimals, "0");

  const sign = negative ? "-" : "";
  return decimals > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}
