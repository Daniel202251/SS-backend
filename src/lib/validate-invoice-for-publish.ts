import { Decimal } from "decimal.js";
import type { Invoice } from "../models/Invoice.model";

export interface ValidationError {
  field: string;
  code: string;
  message: string;
}

/**
 * Minimum runway between publishing and the funding deadline.
 *
 * Investors need a full day to evaluate and fund an invoice, so a deadline
 * closer than this is rejected even though it is still in the future.
 */
export const MIN_LEAD_TIME_MS = 24 * 60 * 60 * 1000;
export const MIN_FACE_VALUE_XLM = new Decimal("100");

/**
 * Validates an invoice's funding deadline against the server clock.
 *
 * Three outcomes, and the two failures are reported separately because they
 * mean different things to the seller: a deadline that has already passed is a
 * stale invoice, while one inside the 24-hour window is simply too tight and
 * can be fixed by pushing the date out.
 *
 * - `DUE_DATE_IN_PAST` — the deadline is at or before `now`, or unparseable
 * - `DUE_DATE_TOO_SOON` — the deadline is in the future but under
 *   {@link MIN_LEAD_TIME_MS} away
 * - `null` — the deadline is at least {@link MIN_LEAD_TIME_MS} away
 *
 * `now` defaults to the server clock. It is a parameter so tests can pin it;
 * callers must never pass a client-supplied timestamp, or a seller could
 * publish an expired invoice by lying about the time.
 */
export function validateFundingDeadline(
  dueDate: Date | string,
  now: Date = new Date()
): ValidationError | null {
  const deadline = new Date(dueDate);

  if (Number.isNaN(deadline.getTime())) {
    return {
      field: "dueDate",
      code: "DUE_DATE_IN_PAST",
      message: "Invoice funding deadline is missing or not a valid date.",
    };
  }

  const leadTimeMs = deadline.getTime() - now.getTime();

  if (leadTimeMs <= 0) {
    return {
      field: "dueDate",
      code: "DUE_DATE_IN_PAST",
      message: "Invoice funding deadline is in the past.",
    };
  }

  if (leadTimeMs < MIN_LEAD_TIME_MS) {
    return {
      field: "dueDate",
      code: "DUE_DATE_TOO_SOON",
      message: "Invoice funding deadline must be at least 24 hours in the future.",
    };
  }

  return null;
}

/**
 * Validates that an invoice meets the minimum field requirements
 * required for the draft -> published lifecycle transition.
 *
 * `now` is threaded through to {@link validateFundingDeadline} for tests only;
 * production callers use the default server clock.
 */
export function validateInvoiceForPublish(
  invoice: Invoice,
  now: Date = new Date()
): ValidationError[] {
  const errors: ValidationError[] = [];

  const faceValue = new Decimal(invoice.amount);
  if (faceValue.lessThan(MIN_FACE_VALUE_XLM)) {
    errors.push({
      field: "amount",
      code: "FACE_VALUE_TOO_LOW",
      message: `Invoice face value must be at least ${MIN_FACE_VALUE_XLM.toFixed(4)} XLM.`,
    });
  }

  const deadlineError = validateFundingDeadline(invoice.dueDate, now);
  if (deadlineError) {
    errors.push(deadlineError);
  }

  if (!invoice.ipfsHash) {
    errors.push({
      field: "ipfsHash",
      code: "MISSING_DOCUMENT",
      message: "Invoice must have at least one document attached before it can be published.",
    });
  }

  return errors;
}
