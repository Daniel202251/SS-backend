import type { AppLogger } from "../observability/logger";
import { stroopsToXlm } from "./stellar-format";

export interface SettlementCompletionLogInput {
  invoiceId: string;
  /** Total settled proceeds expressed in stroops, formatted to XLM via stroopsToXlm before logging. */
  totalProceedsStroops: bigint;
  investorCount: number;
}

/**
 * Emits the settlement flow completion audit log. Callers must invoke this
 * only after every investor's return has been recorded and the invoice
 * status has been updated to settled — never on a partial or failed
 * settlement, which error logging handles instead.
 */
export function logSettlementCompletion(
  logger: AppLogger,
  input: SettlementCompletionLogInput
): void {
  logger.info("Settlement flow completed.", {
    invoice_id: input.invoiceId,
    total_proceeds: stroopsToXlm(input.totalProceedsStroops),
    investor_count: input.investorCount,
    settled_at: new Date().toISOString(),
  });
}
