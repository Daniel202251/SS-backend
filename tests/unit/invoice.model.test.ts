import { Invoice } from "@/models/Invoice.model";
import { InvoiceStatus } from "@/types/enums";
import { AppError } from "@/utils/http-error";

describe("Invoice Model", () => {
  describe("Invoice.calculateNetAmount", () => {
    it("calculates net amount accurately with standard inputs", () => {
      const net = Invoice.calculateNetAmount("1000.0000", "5.00");
      expect(net).toBe("950.0000");
    });

    it("calculates net amount accurately with zero discount rate", () => {
      const net = Invoice.calculateNetAmount("500.5000", "0.00");
      expect(net).toBe("500.5000");
    });

    it("calculates net amount accurately with 100% discount rate", () => {
      const net = Invoice.calculateNetAmount("1000.0000", "100.00");
      expect(net).toBe("0.0000");
    });

    it("calculates net amount precisely for values where floating point arithmetic rounds wrong", () => {
      // 29.8401 * (1 - 0/100) = 29.8401
      const net = Invoice.calculateNetAmount("29.8401", "0.00");
      expect(net).toBe("29.8401");

      const net2 = Invoice.calculateNetAmount("100.0000", "33.33");
      expect(net2).toBe("66.6700");
    });

    it("accepts numeric values as inputs", () => {
      const net = Invoice.calculateNetAmount(250, 10);
      expect(net).toBe("225.0000");
    });

    it("throws AppError 400 when amount is negative", () => {
      expect(() => Invoice.calculateNetAmount("-100.0000", "5.00")).toThrow(AppError);
      try {
        Invoice.calculateNetAmount("-100.0000", "5.00");
      } catch (err) {
        const appErr = err as AppError;
        expect(appErr.statusCode).toBe(400);
        expect(appErr.code).toBe("INVALID_AMOUNT_OR_DISCOUNT");
      }
    });

    it("throws AppError 400 when discount rate is negative", () => {
      expect(() => Invoice.calculateNetAmount("100.0000", "-5.00")).toThrow(AppError);
    });

    it("throws AppError 400 when discount rate exceeds 100%", () => {
      expect(() => Invoice.calculateNetAmount("100.0000", "105.00")).toThrow(AppError);
    });

    it("throws AppError 400 for non-numeric input strings", () => {
      expect(() => Invoice.calculateNetAmount("abc", "5.00")).toThrow(AppError);
      expect(() => Invoice.calculateNetAmount("100.00", "xyz")).toThrow(AppError);
    });
  });

  describe("Invoice.sanitizeAndNormalize", () => {
    it("trims strings and normalizes whitespace", () => {
      const invoice = new Invoice();
      invoice.invoiceNumber = "  INV-2026-001  ";
      invoice.customerName = "   Acme Corp Inc.   ";
      invoice.ipfsHash = "   QmHash12345   ";
      invoice.smartContractId = "  CA1234567890   ";
      invoice.rejectionReason = "  Invalid document signature  ";

      Invoice.sanitizeAndNormalize(invoice);

      expect(invoice.invoiceNumber).toBe("INV-2026-001");
      expect(invoice.customerName).toBe("Acme Corp Inc.");
      expect(invoice.ipfsHash).toBe("QmHash12345");
      expect(invoice.smartContractId).toBe("CA1234567890");
      expect(invoice.rejectionReason).toBe("Invalid document signature");
    });

    it("normalizes empty string fields to null for nullable properties", () => {
      const invoice = new Invoice();
      invoice.ipfsHash = "   ";
      invoice.smartContractId = "   ";
      invoice.rejectionReason = "   ";

      Invoice.sanitizeAndNormalize(invoice);

      expect(invoice.ipfsHash).toBeNull();
      expect(invoice.smartContractId).toBeNull();
      expect(invoice.rejectionReason).toBeNull();
    });

    it("auto-calculates netAmount if amount and discountRate are present", () => {
      const invoice = new Invoice();
      invoice.amount = "2000.0000";
      invoice.discountRate = "10.00";
      invoice.netAmount = "0";

      Invoice.sanitizeAndNormalize(invoice);

      expect(invoice.netAmount).toBe("1800.0000");
    });
  });

  describe("State machine transitions (Invoice.isValidTransition & Invoice.transitionTo)", () => {
    it("correctly identifies valid transitions from DRAFT", () => {
      expect(Invoice.isValidTransition(InvoiceStatus.DRAFT, InvoiceStatus.PUBLISHED)).toBe(true);
      expect(Invoice.isValidTransition(InvoiceStatus.DRAFT, InvoiceStatus.CANCELLED)).toBe(true);
      expect(Invoice.isValidTransition(InvoiceStatus.DRAFT, InvoiceStatus.REJECTED)).toBe(true);
      expect(Invoice.isValidTransition(InvoiceStatus.DRAFT, InvoiceStatus.FUNDED)).toBe(false);
      expect(Invoice.isValidTransition(InvoiceStatus.DRAFT, InvoiceStatus.SETTLED)).toBe(false);
    });

    it("correctly identifies valid transitions from PENDING", () => {
      expect(Invoice.isValidTransition(InvoiceStatus.PENDING, InvoiceStatus.PUBLISHED)).toBe(true);
      expect(Invoice.isValidTransition(InvoiceStatus.PENDING, InvoiceStatus.CANCELLED)).toBe(true);
      expect(Invoice.isValidTransition(InvoiceStatus.PENDING, InvoiceStatus.REJECTED)).toBe(true);
      expect(Invoice.isValidTransition(InvoiceStatus.PENDING, InvoiceStatus.FUNDED)).toBe(false);
    });

    it("correctly identifies valid transitions from PUBLISHED", () => {
      expect(Invoice.isValidTransition(InvoiceStatus.PUBLISHED, InvoiceStatus.FUNDED)).toBe(true);
      expect(Invoice.isValidTransition(InvoiceStatus.PUBLISHED, InvoiceStatus.CANCELLED)).toBe(true);
      expect(Invoice.isValidTransition(InvoiceStatus.PUBLISHED, InvoiceStatus.DRAFT)).toBe(false);
      expect(Invoice.isValidTransition(InvoiceStatus.PUBLISHED, InvoiceStatus.REJECTED)).toBe(false);
    });

    it("correctly identifies valid transitions from FUNDED", () => {
      expect(Invoice.isValidTransition(InvoiceStatus.FUNDED, InvoiceStatus.SETTLED)).toBe(true);
      expect(Invoice.isValidTransition(InvoiceStatus.FUNDED, InvoiceStatus.CANCELLED)).toBe(true);
      expect(Invoice.isValidTransition(InvoiceStatus.FUNDED, InvoiceStatus.PUBLISHED)).toBe(false);
    });

    it("correctly identifies valid transitions from SETTLED (terminal except cancel)", () => {
      expect(Invoice.isValidTransition(InvoiceStatus.SETTLED, InvoiceStatus.CANCELLED)).toBe(true);
      expect(Invoice.isValidTransition(InvoiceStatus.SETTLED, InvoiceStatus.DRAFT)).toBe(false);
      expect(Invoice.isValidTransition(InvoiceStatus.SETTLED, InvoiceStatus.PUBLISHED)).toBe(false);
      expect(Invoice.isValidTransition(InvoiceStatus.SETTLED, InvoiceStatus.FUNDED)).toBe(false);
    });

    it("correctly identifies terminal state for CANCELLED and REJECTED", () => {
      expect(Invoice.isValidTransition(InvoiceStatus.CANCELLED, InvoiceStatus.DRAFT)).toBe(false);
      expect(Invoice.isValidTransition(InvoiceStatus.CANCELLED, InvoiceStatus.PUBLISHED)).toBe(false);

      expect(Invoice.isValidTransition(InvoiceStatus.REJECTED, InvoiceStatus.DRAFT)).toBe(false);
      expect(Invoice.isValidTransition(InvoiceStatus.REJECTED, InvoiceStatus.PUBLISHED)).toBe(false);
    });

    it("executes Invoice.transitionTo successfully on valid transition", () => {
      const invoice = new Invoice();
      invoice.status = InvoiceStatus.DRAFT;

      Invoice.transitionTo(invoice, InvoiceStatus.PUBLISHED);
      expect(invoice.status).toBe(InvoiceStatus.PUBLISHED);
    });

    it("records rejectionReason when transitioning to REJECTED", () => {
      const invoice = new Invoice();
      invoice.status = InvoiceStatus.PENDING;

      Invoice.transitionTo(invoice, InvoiceStatus.REJECTED, "Risk score exceeds maximum allowable limit");
      expect(invoice.status).toBe(InvoiceStatus.REJECTED);
      expect(invoice.rejectionReason).toBe("Risk score exceeds maximum allowable limit");
    });

    it("throws AppError 400 when attempting an invalid transition", () => {
      const invoice = new Invoice();
      invoice.status = InvoiceStatus.FUNDED;

      expect(() => Invoice.transitionTo(invoice, InvoiceStatus.PUBLISHED)).toThrow(AppError);
      try {
        Invoice.transitionTo(invoice, InvoiceStatus.PUBLISHED);
      } catch (err) {
        const appErr = err as AppError;
        expect(appErr.statusCode).toBe(400);
        expect(appErr.code).toBe("INVALID_STATUS_TRANSITION");
      }
    });
  });

  describe("Invoice.isPublishable verification", () => {
    const validFutureDate = new Date(Date.now() + 48 * 60 * 60 * 1000);

    it("returns publishable: true for a valid draft invoice", () => {
      const invoice = new Invoice();
      invoice.status = InvoiceStatus.DRAFT;
      invoice.amount = "5000.0000";
      invoice.customerName = "Global Logistics Ltd";
      invoice.dueDate = validFutureDate;
      invoice.ipfsHash = "QmValidDocumentHash123";

      const check = Invoice.isPublishable(invoice);
      expect(check.publishable).toBe(true);
      expect(check.errors).toHaveLength(0);
    });

    it("returns errors when amount is 0 or negative", () => {
      const invoice = new Invoice();
      invoice.status = InvoiceStatus.DRAFT;
      invoice.amount = "0";
      invoice.customerName = "Customer";
      invoice.dueDate = validFutureDate;
      invoice.ipfsHash = "QmHash";

      const check = Invoice.isPublishable(invoice);
      expect(check.publishable).toBe(false);
      expect(check.errors).toContain("Invoice amount must be greater than zero");
    });

    it("returns errors when dueDate is less than 24 hours in the future", () => {
      const invoice = new Invoice();
      invoice.status = InvoiceStatus.DRAFT;
      invoice.amount = "1000.0000";
      invoice.customerName = "Customer";
      invoice.dueDate = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours from now
      invoice.ipfsHash = "QmHash";

      const check = Invoice.isPublishable(invoice);
      expect(check.publishable).toBe(false);
      expect(check.errors.some((e) => e.includes("at least 24 hours"))).toBe(true);
    });

    it("returns errors when IPFS document is missing", () => {
      const invoice = new Invoice();
      invoice.status = InvoiceStatus.DRAFT;
      invoice.amount = "1000.0000";
      invoice.customerName = "Customer";
      invoice.dueDate = validFutureDate;
      invoice.ipfsHash = null;

      const check = Invoice.isPublishable(invoice);
      expect(check.publishable).toBe(false);
      expect(check.errors).toContain("Invoice document IPFS hash is required");
    });
  });

  describe("Invoice.isOverdue & Invoice.getFundingRunwayHours", () => {
    it("identifies past due dates as overdue", () => {
      const invoice = new Invoice();
      invoice.dueDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(Invoice.isOverdue(invoice)).toBe(true);
    });

    it("identifies future due dates as not overdue", () => {
      const invoice = new Invoice();
      invoice.dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      expect(Invoice.isOverdue(invoice)).toBe(false);
    });

    it("computes funding runway in hours accurately", () => {
      const invoice = new Invoice();
      const reference = new Date("2026-01-01T00:00:00.000Z");
      invoice.dueDate = new Date("2026-01-03T12:00:00.000Z"); // 60 hours later

      expect(Invoice.getFundingRunwayHours(invoice, reference)).toBe(60);
    });
  });

  describe("Invoice.create factory & Invoice.toDTO", () => {
    it("creates an instance and normalizes inputs", () => {
      const invoice = Invoice.create({
        sellerId: "seller-123",
        invoiceNumber: "  INV-FACTORY-001  ",
        customerName: "  Test Factory Client  ",
        amount: "1000.0000",
        discountRate: "5.00",
        dueDate: new Date("2026-12-31"),
      });

      expect(invoice).toBeInstanceOf(Invoice);
      expect(invoice.invoiceNumber).toBe("INV-FACTORY-001");
      expect(invoice.customerName).toBe("Test Factory Client");
      expect(invoice.netAmount).toBe("950.0000");
    });

    it("serializes to DTO correctly", () => {
      const invoice = Invoice.create({
        id: "inv-uuid-123",
        sellerId: "seller-uuid-456",
        invoiceNumber: "INV-001",
        customerName: "Client ABC",
        amount: "1000.0000",
        discountRate: "5.00",
        dueDate: new Date("2026-12-31"),
        status: InvoiceStatus.DRAFT,
      });

      const dto = Invoice.toDTO(invoice);
      expect(dto.id).toBe("inv-uuid-123");
      expect(dto.sellerId).toBe("seller-uuid-456");
      expect(dto.invoiceNumber).toBe("INV-001");
      expect(dto.netAmount).toBe("950.0000");
      expect(dto.status).toBe(InvoiceStatus.DRAFT);
    });
  });
});
