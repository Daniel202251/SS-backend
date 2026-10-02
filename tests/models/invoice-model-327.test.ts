import { Invoice } from "../../src/models/Invoice.model";
import { AppError } from "../../src/utils/http-error";

describe("Invoice Model - Issue #327 Enhancements", () => {
  it("should calculate net amount precisely using Decimal math on lifecycle hooks", () => {
    const invoice = new Invoice();
    invoice.amount = "29.99";
    invoice.discountRate = "0.5";
    invoice.invoiceNumber = "INV-327-01";
    invoice.customerName = " Acme Corp ";

    invoice.calculateAndFormatAmounts();

    expect(invoice.customerName).toBe("Acme Corp");
    expect(invoice.amount).toBe("29.9900");
    expect(invoice.discountRate).toBe("0.50");
    expect(invoice.netAmount).toBe("29.8401");
  });

  it("should throw AppError on negative invoice amount during lifecycle hook", () => {
    const invoice = new Invoice();
    invoice.amount = "-100.00";
    invoice.discountRate = "5.00";

    expect(() => invoice.calculateAndFormatAmounts()).toThrow(AppError);
  });

  it("should throw AppError on discount rate > 100", () => {
    const invoice = new Invoice();
    invoice.amount = "100.00";
    invoice.discountRate = "150.00";

    expect(() => invoice.calculateAndFormatAmounts()).toThrow(AppError);
  });

  it("should validate publish readiness", () => {
    const invoice = new Invoice();
    invoice.ipfsHash = null;
    invoice.dueDate = new Date(Date.now() + 86400000);

    expect(() => invoice.validateForPublish()).toThrow(AppError);

    invoice.ipfsHash = "QmTestHash327";
    expect(() => invoice.validateForPublish()).not.toThrow();
  });

  it("should process batch of invoices safely", async () => {
    const inv1 = new Invoice();
    inv1.amount = "100.00";
    inv1.discountRate = "10.00";

    const inv2 = new Invoice();
    inv2.amount = "500.00";
    inv2.discountRate = "5.00";

    const processed = await Invoice.processBatch([inv1, inv2]);
    expect(processed[0].netAmount).toBe("90.0000");
    expect(processed[1].netAmount).toBe("475.0000");
  });
});
