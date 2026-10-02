import { InvoiceStatus } from "@/types/enums";

export function isValidInvoiceStateTransition(
  currentStatus: InvoiceStatus,
  targetStatus: InvoiceStatus
): boolean {
  const validTransitions: Record<InvoiceStatus, InvoiceStatus[]> = {
    [InvoiceStatus.DRAFT]: [InvoiceStatus.PUBLISHED, InvoiceStatus.CANCELLED],
    [InvoiceStatus.PENDING]: [
      InvoiceStatus.PUBLISHED,
      InvoiceStatus.CANCELLED,
      InvoiceStatus.REJECTED,
    ],
    [InvoiceStatus.PUBLISHED]: [InvoiceStatus.FUNDED, InvoiceStatus.CANCELLED, InvoiceStatus.FAILED],
    [InvoiceStatus.FUNDED]: [InvoiceStatus.SETTLED, InvoiceStatus.CANCELLED],
    [InvoiceStatus.SETTLED]: [InvoiceStatus.CANCELLED],
    [InvoiceStatus.CANCELLED]: [],
    [InvoiceStatus.REJECTED]: [],
    [InvoiceStatus.FAILED]: [],
  };

  if (!validTransitions[currentStatus]) {
    return false;
  }

  return validTransitions[currentStatus].includes(targetStatus);
}
