import { ServiceError } from "../utils/service-error";

const MIN_LEAD_TIME_MS = 24 * 60 * 60 * 1000;

export interface PublishableInvoice {
  dueDate: Date;
}

/**
 * Validates that an invoice is eligible to be published.
 *
 * The due date must be at least 24 hours in the future at the moment of
 * publishing, so investors always have a full day of runway before the
 * invoice is due.
 */
export function validateInvoiceForPublish(
  invoice: PublishableInvoice,
  now: Date = new Date()
): void {
  const leadTimeMs = invoice.dueDate.getTime() - now.getTime();

  if (leadTimeMs < MIN_LEAD_TIME_MS) {
    throw new ServiceError(
      "invalid_due_date",
      "dueDate must be at least 24 hours in the future",
      400,
      { field: "dueDate" }
    );
  }
}
