import { Decimal } from "decimal.js";

export interface InvoiceTermsInput {
  faceValue: string | number | Decimal;
  dueDate: Date | string;
  discountBps: number;
  platformFeeBps?: number;
  referenceDate?: Date | string;
}

export interface InvoiceTermsResult {
  faceValue: string;
  tenureDays: number;
  discountBps: number;
  platformFeeBps: number;
  discountAmount: string;
  platformFee: string;
  advanceAmount: string;
  investorReturn: string;
  apr: string;
}

/**
 * Calculates tenure in days between reference date and invoice due date.
 */
export function calculateTenureDays(
  dueDateInput: Date | string,
  referenceDateInput?: Date | string
): number {
  const due = typeof dueDateInput === "string" ? new Date(dueDateInput) : dueDateInput;
  const ref = referenceDateInput
    ? typeof referenceDateInput === "string"
      ? new Date(referenceDateInput)
      : referenceDateInput
    : new Date();

  if (isNaN(due.getTime()) || isNaN(ref.getTime())) {
    throw new Error("Invalid date provided for tenure calculation");
  }

  // Calculate difference in milliseconds and convert to integer days (rounding up)
  const diffMs = due.getTime() - ref.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  // Minimum tenure is 1 day to prevent division by zero in APR calculations
  return Math.max(1, diffDays);
}

/**
 * Pure calculation utility for invoice discounting terms, fees, net advance amount, and annualized APR.
 */
export function calculateInvoiceTerms(input: InvoiceTermsInput): InvoiceTermsResult {
  const {
    faceValue: rawFaceValue,
    dueDate,
    discountBps,
    platformFeeBps = 0,
    referenceDate,
  } = input;

  const faceValue = new Decimal(rawFaceValue);
  if (faceValue.isNegative() || faceValue.isZero()) {
    throw new Error("Face value must be a positive number greater than zero");
  }

  if (discountBps < 0 || discountBps > 10_000) {
    throw new Error("Discount BPS must be between 0 and 10,000");
  }

  if (platformFeeBps < 0 || platformFeeBps > 10_000) {
    throw new Error("Platform fee BPS must be between 0 and 10,000");
  }

  if (discountBps + platformFeeBps >= 10_000) {
    throw new Error("Total fee and discount deductions cannot exceed 100% of face value");
  }

  const tenureDays = calculateTenureDays(dueDate, referenceDate);

  const discountAmount = faceValue.times(discountBps).dividedBy(10_000);
  const platformFee = faceValue.times(platformFeeBps).dividedBy(10_000);
  const advanceAmount = faceValue.minus(discountAmount).minus(platformFee);

  // APR = (discountAmount / advanceAmount) * (365 / tenureDays) * 100
  let apr = new Decimal(0);
  if (advanceAmount.gt(0) && discountAmount.gt(0) && tenureDays > 0) {
    apr = discountAmount.dividedBy(advanceAmount).times(365).dividedBy(tenureDays).times(100);
  }

  return {
    faceValue: faceValue.toFixed(4),
    tenureDays,
    discountBps,
    platformFeeBps,
    discountAmount: discountAmount.toFixed(4),
    platformFee: platformFee.toFixed(4),
    advanceAmount: advanceAmount.toFixed(4),
    investorReturn: discountAmount.toFixed(4),
    apr: apr.toFixed(2),
  };
}
