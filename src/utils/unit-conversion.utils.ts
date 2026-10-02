import Decimal from "decimal.js";
import { stroopsToXlm as stellarStroopsToXlm } from "../lib/stellar-format";

const STROOP_DIVISOR = new Decimal(10_000_000);

/**
 * Converts an amount in stroops (1 XLM = 10,000,000 stroops) to a human-readable
 * XLM/USDC decimal string, using integer arithmetic throughout to avoid
 * floating-point error.
 *
 * @param stroops - Amount in stroops (as bigint or string representation of a bigint)
 * @returns A decimal string with 7 decimal places of stroop precision
 *
 * @example
 * stroopsToXlm(10_000_000n)   // "1.0000000"
 * stroopsToXlm(1n)            // "0.0000001"
 * stroopsToXlm(0n)            // "0.0000000"
 * stroopsToXlm("10000000")    // "1.0000000"
 */
export function stroopsToXlm(stroops: bigint | string): string {
  return stellarStroopsToXlm(typeof stroops === "string" ? BigInt(stroops) : stroops);
}

/**
 * Converts a human-readable XLM/USDC decimal amount to stroops (1 XLM = 10,000,000 stroops),
 * using Decimal.js for precise arithmetic before converting to bigint.
 *
 * @param xlm - Amount in XLM/USDC (as string or number)
 * @returns The equivalent amount in stroops as a bigint
 *
 * @example
 * xlmToStroops("1.0000000")   // 10_000_000n
 * xlmToStroops("0.0000001")   // 1n
 * xlmToStroops("0")           // 0n
 * xlmToStroops(1)             // 10_000_000n
 */
export function xlmToStroops(xlm: string | number): bigint {
  const dec = new Decimal(xlm);
  if (dec.isNaN()) {
    throw new TypeError(`Invalid XLM amount: ${xlm}`);
  }
  return BigInt(dec.times(STROOP_DIVISOR).toFixed(0, Decimal.ROUND_DOWN));
}
