import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatus } from "../../src/types/enums";
import { AppError } from "../../src/utils/http-error";

describe("Invoice Model - Issue #324 Enhancements", () => {
  it("should evaluate status predicates correctly", () => {
    const invoice = new Invoice();
    invoice.status = InvoiceStatus.DRAFT;
    invoice.ipfsHash = "QmHash324";
    invoice.dueDate = new Date(Date.now() + 86400000);

    expect(invoice.isExpired()).toBe(false);
    expect(invoice.isPublishable()).toBe(true);
    expect(invoice.canBeCancelled()).toBe(true);
    expect(invoice.canBeRejected()).toBe(true);

    invoice.status = InvoiceStatus.PUBLISHED;
    expect(invoice.isFundable()).toBe(true);

    invoice.status = InvoiceStatus.FUNDED;
    expect(invoice.isSettlable()).toBe(true);
  });

  it("should execute batchUpdateStatus correctly", async () => {
    const inv1 = new Invoice();
    inv1.id = "inv-1";
    inv1.status = InvoiceStatus.PENDING;

    const inv2 = new Invoice();
    inv2.id = "inv-2";
    inv2.status = InvoiceStatus.DRAFT;

    const updated = await Invoice.batchUpdateStatus([inv1, inv2], InvoiceStatus.REJECTED, "Invalid document");

    expect(updated[0].status).toBe(InvoiceStatus.REJECTED);
    expect(updated[0].rejectionReason).toBe("Invalid document");
    expect(updated[1].status).toBe(InvoiceStatus.REJECTED);
    expect(updated[1].rejectionReason).toBe("Invalid document");
  });

  it("should throw AppError on invalid batch status transition", async () => {
    const inv = new Invoice();
    inv.id = "inv-settled";
    inv.status = InvoiceStatus.SETTLED;

    await expect(
      Invoice.batchUpdateStatus([inv], InvoiceStatus.REJECTED, "Cannot reject settled invoice")
    ).rejects.toThrow(AppError);
  });
});
