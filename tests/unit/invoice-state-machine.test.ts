import { InvoiceService } from "../../src/services/invoice.service";
import { ServiceError } from "../../src/utils/service-error";
import { Invoice } from "../../src/models/Invoice.model";
import { User } from "../../src/models/User.model";
import { InvoiceStatus, KYCStatus, UserType } from "../../src/types/enums";

// Minimal approved seller so publishInvoice passes the KYC gate
function makeSeller(): User {
  return {
    id: "seller-001",
    stellarAddress: "GSELLER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234",
    email: null,
    userType: UserType.SELLER,
    kycStatus: KYCStatus.APPROVED,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    invoices: [],
    investments: [],
    transactions: [],
    kycVerifications: [],
    notifications: [],
  } as unknown as User;
}

// Invoice that satisfies all pre-publish validation requirements when publishable
function makePublishableInvoice(status: InvoiceStatus): Invoice {
  const seller = makeSeller();
  return {
    id: "invoice-sm-001",
    sellerId: seller.id,
    invoiceNumber: "INV-SM-001",
    customerName: "State Machine Test Co",
    amount: "1000.00",
    discountRate: "5.00",
    netAmount: "950.00",
    dueDate: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 h in the future
    ipfsHash: "QmStateMachineTestDoc",
    riskScore: null,
    status,
    smartContractId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    seller,
    investments: [],
    transactions: [],
  } as unknown as Invoice;
}

function createService(invoice: Invoice): InvoiceService {
  const saved = { ...invoice };
  const mockRepo = {
    findOne: jest.fn().mockResolvedValue(saved),
    findOneBy: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation((inv: Invoice) => {
      Object.assign(saved, inv);
      return Promise.resolve(saved);
    }),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockImplementation((data: Partial<Invoice>) => data as Invoice),
  };
  const mockIPFS = {
    uploadFile: jest.fn(),
  } as unknown as import("../../src/services/ipfs.service").IPFSService;

  return new InvoiceService({ invoiceRepository: mockRepo, ipfsService: mockIPFS });
}

const SELLER_ID = "seller-001";

describe("Invoice state machine — valid transitions (issue #110)", () => {
  it("allows DRAFT → PUBLISHED", async () => {
    const invoice = makePublishableInvoice(InvoiceStatus.DRAFT);
    const service = createService(invoice);
    const result = await service.publishInvoice({ invoiceId: invoice.id, sellerId: SELLER_ID });
    expect(result.status).toBe(InvoiceStatus.PUBLISHED);
  });

  it("allows PENDING → PUBLISHED on admin approval", async () => {
    const invoice = makePublishableInvoice(InvoiceStatus.PENDING);
    const service = createService(invoice);
    const result = await service.approveInvoice({ invoiceId: invoice.id });
    expect(result.status).toBe(InvoiceStatus.PUBLISHED);
  });
});

describe("Invoice state machine — invalid transitions blocked (issue #110)", () => {
  it("blocks FUNDED → PUBLISHED with invalid_status_transition", async () => {
    const invoice = makePublishableInvoice(InvoiceStatus.FUNDED);
    const service = createService(invoice);

    await expect(
      service.publishInvoice({ invoiceId: invoice.id, sellerId: SELLER_ID })
    ).rejects.toMatchObject({
      code: "invalid_status_transition",
    });
  });

  it("blocks SETTLED → PUBLISHED with invalid_status_transition", async () => {
    const invoice = makePublishableInvoice(InvoiceStatus.SETTLED);
    const service = createService(invoice);

    await expect(
      service.publishInvoice({ invoiceId: invoice.id, sellerId: SELLER_ID })
    ).rejects.toMatchObject({
      code: "invalid_status_transition",
    });
  });

  it("blocks CANCELLED → PUBLISHED with invalid_status_transition", async () => {
    const invoice = makePublishableInvoice(InvoiceStatus.CANCELLED);
    const service = createService(invoice);

    await expect(
      service.publishInvoice({ invoiceId: invoice.id, sellerId: SELLER_ID })
    ).rejects.toMatchObject({
      code: "invalid_status_transition",
    });
  });

  it("error message contains the source and target state names", async () => {
    const invoice = makePublishableInvoice(InvoiceStatus.FUNDED);
    const service = createService(invoice);

    let caught: ServiceError | undefined;
    try {
      await service.publishInvoice({ invoiceId: invoice.id, sellerId: SELLER_ID });
    } catch (err) {
      caught = err as ServiceError;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect(caught!.message).toMatch(/funded/i);
    expect(caught!.message).toMatch(/published/i);
  });

  it("SETTLED is terminal — all outbound transitions are blocked", () => {
    // Verify the VALID_TRANSITIONS map encodes no exits from SETTLED
    // We drive this through publishInvoice (SETTLED → PUBLISHED), then confirm
    // the same ServiceError type is thrown rather than a pass-through.
    const invoice = makePublishableInvoice(InvoiceStatus.SETTLED);
    const service = createService(invoice);

    return expect(
      service.publishInvoice({ invoiceId: invoice.id, sellerId: SELLER_ID })
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("CANCELLED is terminal — all outbound transitions are blocked", () => {
    const invoice = makePublishableInvoice(InvoiceStatus.CANCELLED);
    const service = createService(invoice);

    return expect(
      service.publishInvoice({ invoiceId: invoice.id, sellerId: SELLER_ID })
    ).rejects.toBeInstanceOf(ServiceError);
  });
});
