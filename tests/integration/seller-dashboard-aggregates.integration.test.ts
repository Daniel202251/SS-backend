import crypto from "crypto";
import { InvoiceService, InvoiceServiceDependencies } from "../../src/services/invoice.service";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatus } from "../../src/types/enums";
import type { IPFSService } from "../../src/services/ipfs.service";

/**
 * Build a fake InvoiceService with in-memory repositories so the test
 * exercises the real `getInvoicesBySellerId` method end to end.
 */
function createFakeInvoiceService() {
  const invoices = new Map<string, Invoice>();

  const fakeInvoiceRepository: InvoiceServiceDependencies["invoiceRepository"] = {
    findOne: async () => null,
    findOneBy: async () => null,
    find: async ({ where }: any) => {
      const { sellerId, status } = (Array.isArray(where) ? where[0] : where) || {};
      return [...invoices.values()].filter((inv) => {
        if (inv.sellerId !== sellerId) return false;
        if (status && inv.status !== status) return false;
        return true;
      });
    },
    save: async (invoice: Invoice) => {
      invoices.set(invoice.id, invoice);
      return invoice;
    },
    count: async ({ where }: any) => {
      const { sellerId, status } = (Array.isArray(where) ? where[0] : where) || {};
      return [...invoices.values()].filter((inv) => {
        if (inv.sellerId !== sellerId) return false;
        if (status && inv.status !== status) return false;
        return true;
      }).length;
    },
    create: (data: Partial<Invoice>) => data as Invoice,
  };

  const fakeIPFSService: IPFSService = {
    uploadFile: jest.fn(),
  } as unknown as IPFSService;

  const invoiceService = new InvoiceService({
    invoiceRepository: fakeInvoiceRepository,
    ipfsService: fakeIPFSService,
  });

  return { invoiceService, invoices };
}

function createInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: crypto.randomUUID(),
    sellerId: crypto.randomUUID(),
    invoiceNumber: `INV-${crypto.randomUUID().slice(0, 8)}`,
    customerName: "Customer",
    amount: "1000.0000",
    discountRate: "5.00",
    netAmount: "950.0000",
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    ipfsHash: null,
    riskScore: null,
    status: InvoiceStatus.DRAFT,
    smartContractId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    seller: undefined as unknown as Invoice["seller"],
    investments: [],
    transactions: [],
    ...overrides,
  } as Invoice;
}

describe("Seller dashboard: aggregates scoped to authenticated seller only", () => {
  it("returns only seller A's invoices with no cross-contamination from seller B", async () => {
    const { invoiceService, invoices } = createFakeInvoiceService();

    const sellerAId = crypto.randomUUID();
    const sellerBId = crypto.randomUUID();

    // Seed seller A: 1 published (2000) and 1 settled (3000)
    const sellerAInvoices = [
      createInvoice({
        sellerId: sellerAId,
        invoiceNumber: "INV-A-001",
        amount: "2000.0000",
        netAmount: "2000.0000",
        status: InvoiceStatus.PUBLISHED,
      }),
      createInvoice({
        sellerId: sellerAId,
        invoiceNumber: "INV-A-002",
        amount: "3000.0000",
        netAmount: "3000.0000",
        status: InvoiceStatus.SETTLED,
      }),
    ];
    for (const inv of sellerAInvoices) {
      invoices.set(inv.id, inv);
    }

    // Seed seller B: 1 published (5000) and 1 funded (4000)
    const sellerBInvoices = [
      createInvoice({
        sellerId: sellerBId,
        invoiceNumber: "INV-B-001",
        amount: "5000.0000",
        netAmount: "5000.0000",
        status: InvoiceStatus.PUBLISHED,
      }),
      createInvoice({
        sellerId: sellerBId,
        invoiceNumber: "INV-B-002",
        amount: "4000.0000",
        netAmount: "4000.0000",
        status: InvoiceStatus.FUNDED,
      }),
    ];
    for (const inv of sellerBInvoices) {
      invoices.set(inv.id, inv);
    }

    // Call seller dashboard as seller A
    const sellerAResult = await invoiceService.getInvoicesBySellerId({
      sellerId: sellerAId,
      take: 20,
    });

    // Assert seller A totals contain only seller A's invoices
    expect(sellerAResult.total).toBe(2);
    expect(sellerAResult.invoices).toHaveLength(2);
    expect(sellerAResult.invoices.every((inv) => inv.sellerId === sellerAId)).toBe(true);

    // Assert seller A published total is 2000
    const sellerAPublished = sellerAResult.invoices.filter(
      (inv) => inv.status === InvoiceStatus.PUBLISHED
    );
    expect(sellerAPublished).toHaveLength(1);
    expect(sellerAPublished[0].amount).toBe("2000.0000");

    // Assert seller A settled total is 3000
    const sellerASettled = sellerAResult.invoices.filter(
      (inv) => inv.status === InvoiceStatus.SETTLED
    );
    expect(sellerASettled).toHaveLength(1);
    expect(sellerASettled[0].amount).toBe("3000.0000");

    // No seller B invoices in seller A's result
    const sellerBInvoiceNumbers = ["INV-B-001", "INV-B-002"];
    expect(
      sellerAResult.invoices.some((inv) => sellerBInvoiceNumbers.includes(inv.invoiceNumber))
    ).toBe(false);

    // Call seller dashboard as seller B
    const sellerBResult = await invoiceService.getInvoicesBySellerId({
      sellerId: sellerBId,
      take: 20,
    });

    // Assert seller B totals contain only seller B's invoices
    expect(sellerBResult.total).toBe(2);
    expect(sellerBResult.invoices).toHaveLength(2);
    expect(sellerBResult.invoices.every((inv) => inv.sellerId === sellerBId)).toBe(true);

    // Assert seller B published total is 5000
    const sellerBPublished = sellerBResult.invoices.filter(
      (inv) => inv.status === InvoiceStatus.PUBLISHED
    );
    expect(sellerBPublished).toHaveLength(1);
    expect(sellerBPublished[0].amount).toBe("5000.0000");

    // Assert seller B funded total is 4000
    const sellerBFunded = sellerBResult.invoices.filter(
      (inv) => inv.status === InvoiceStatus.FUNDED
    );
    expect(sellerBFunded).toHaveLength(1);
    expect(sellerBFunded[0].amount).toBe("4000.0000");

    // No seller A invoices in seller B's result
    const sellerAInvoiceNumbers = ["INV-A-001", "INV-A-002"];
    expect(
      sellerBResult.invoices.some((inv) => sellerAInvoiceNumbers.includes(inv.invoiceNumber))
    ).toBe(false);
  });
});
