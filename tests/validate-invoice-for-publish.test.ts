import {
  MIN_FACE_VALUE_XLM,
  validateInvoiceForPublish,
} from "../src/lib/validate-invoice-for-publish";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceStatus } from "../src/types/enums";

function futureDate(hoursFromNow: number): Date {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
}

function createInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "invoice-1",
    sellerId: "seller-1",
    invoiceNumber: "INV-001",
    customerName: "Customer A",
    amount: "1000.0000",
    discountRate: "5.00",
    netAmount: "950.0000",
    dueDate: futureDate(48),
    ipfsHash: "QmTestHash",
    riskScore: null,
    status: InvoiceStatus.DRAFT,
    smartContractId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    seller: overrides.seller as Invoice["seller"],
    investments: overrides.investments ?? [],
    transactions: overrides.transactions ?? [],
    ...overrides,
  } as Invoice;
}

describe("validateInvoiceForPublish", () => {
  it("returns an empty array when all checks pass", () => {
    const invoice = createInvoice();
    expect(validateInvoiceForPublish(invoice)).toEqual([]);
  });

  it("returns a validation error for zero face value", () => {
    const invoice = createInvoice({ amount: "0.0000" });
    const errors = validateInvoiceForPublish(invoice);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "amount", code: "FACE_VALUE_TOO_LOW" });
  });

  it("returns a validation error for a below-minimum face value", () => {
    const invoice = createInvoice({ amount: "99.9999" });
    const errors = validateInvoiceForPublish(invoice);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      field: "amount",
      code: "FACE_VALUE_TOO_LOW",
      message: `Invoice face value must be at least ${MIN_FACE_VALUE_XLM.toFixed(4)} XLM.`,
    });
  });

  it("returns no validation errors at the exact minimum face value", () => {
    const invoice = createInvoice({ amount: MIN_FACE_VALUE_XLM.toFixed(4) });
    expect(validateInvoiceForPublish(invoice)).toEqual([]);
  });

  it("returns no validation errors above the minimum face value", () => {
    const invoice = createInvoice({ amount: "100.0001" });
    expect(validateInvoiceForPublish(invoice)).toEqual([]);
  });

  it("returns a validation error for a due date in the past", () => {
    const invoice = createInvoice({ dueDate: futureDate(-1) });
    const errors = validateInvoiceForPublish(invoice);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "dueDate", code: "DUE_DATE_IN_PAST" });
  });

  it("returns a validation error for a due date less than 24 hours away", () => {
    const invoice = createInvoice({ dueDate: futureDate(1) });
    const errors = validateInvoiceForPublish(invoice);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "dueDate", code: "DUE_DATE_TOO_SOON" });
  });

  it("returns a validation error when no document is attached", () => {
    const invoice = createInvoice({ ipfsHash: null });
    const errors = validateInvoiceForPublish(invoice);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "ipfsHash", code: "MISSING_DOCUMENT" });
  });

  it("returns all errors when multiple fields are invalid, not just the first", () => {
    const invoice = createInvoice({
      amount: "0.0000",
      dueDate: futureDate(-5),
      ipfsHash: null,
    });
    const errors = validateInvoiceForPublish(invoice);
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(["FACE_VALUE_TOO_LOW", "DUE_DATE_IN_PAST", "MISSING_DOCUMENT"])
    );
  });

  it("returns all three errors simultaneously for a fully invalid invoice and is deterministic", () => {
    // Create an invoice that fails all validations
    const fullyInvalidInvoice = createInvoice({
      amount: "0.0000", // faceValue: 0
      dueDate: futureDate(-5), // dueDate in the past
      ipfsHash: null, // no attached documents
    });

    // First call: should return all errors
    const errors = validateInvoiceForPublish(fullyInvalidInvoice);

    // Assert exactly three errors are returned in a single call
    expect(errors).toHaveLength(3);

    // Assert each error identifies the correct field
    const errorFields = errors.map((e) => e.field);
    expect(errorFields).toContain("amount");
    expect(errorFields).toContain("dueDate");
    expect(errorFields).toContain("ipfsHash");

    // Assert each error has the correct error code
    const errorCodes = errors.map((e) => e.code);
    expect(errorCodes).toContain("FACE_VALUE_TOO_LOW");
    expect(errorCodes).toContain("DUE_DATE_IN_PAST");
    expect(errorCodes).toContain("MISSING_DOCUMENT");

    // Second call with the same invoice: should return the same errors (deterministic)
    const errorsAgain = validateInvoiceForPublish(fullyInvalidInvoice);
    expect(errorsAgain).toEqual(errors);
  });
});
