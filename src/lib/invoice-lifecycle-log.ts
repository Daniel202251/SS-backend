import type { AppLogger } from "../observability/logger";
import { truncateWalletAddress } from "./kyc";
import type { InvoiceStatus } from "../types/enums";

export type InvoiceTransitionReason =
  | "seller_submitted"
  | "seller_published"
  | "seller_batch_published"
  | "seller_cancelled"
  | "admin_approved"
  | "admin_cancelled"
  | "fully_funded"
  | "admin_settled"
  | "admin_rejected"
  | "invoice_expired";

export interface InvoiceTransitionLogInput {
  invoiceId: string;
  fromState: InvoiceStatus;
  toState: InvoiceStatus;
  actorWallet: string;
  reason: InvoiceTransitionReason;
}

/**
 * Emits the invoice lifecycle audit log. Callers must invoke this only
 * after the state-change database write has succeeded.
 */
export function logInvoiceTransition(logger: AppLogger, input: InvoiceTransitionLogInput): void {
  logger.info("Invoice lifecycle state transition.", {
    invoice_id: input.invoiceId,
    from_state: input.fromState,
    to_state: input.toState,
    actor_wallet: truncateWalletAddress(input.actorWallet),
    reason: input.reason,
    transitioned_at: new Date().toISOString(),
  });
}
