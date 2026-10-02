import crypto from "crypto";
import {
  MarketplaceService,
  MarketplaceRepositoryContract,
} from "../../src/services/marketplace.service";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatus } from "../../src/types/enums";

/**
 * In-memory stand-in for the TypeORM-backed marketplace repository.
 * Supports sorting by amount (face value) and due_date.
 */
function createFakeMarketplaceRepository(invoices: Invoice[]): MarketplaceRepositoryContract {
  return {
    async findPublishedInvoices(filters) {
      const statuses =
        filters.status && filters.status.length > 0 ? filters.status : [InvoiceStatus.PUBLISHED];
      let matched = invoices.filter((invoice) => statuses.includes(invoice.status));

      // Apply sorting
      const sortColumn = filters.sort || "amount";
      const sortOrder = filters.sortOrder || "DESC";

      matched = [...matched].sort((a, b) => {
        let comparison: number;

        if (sortColumn === "amount") {
          comparison = parseFloat(a.amount) - parseFloat(b.amount);
        } else if (sortColumn === "due_date") {
          comparison = a.dueDate.getTime() - b.dueDate.getTime();
        } else if (sortColumn === "discount_rate") {
          comparison = parseFloat(a.discountRate) - parseFloat(b.discountRate);
        } else if (sortColumn === "created_at") {
          comparison = a.createdAt.getTime() - b.createdAt.getTime();
        } else {
          comparison = 0;
        }

        return sortOrder === "DESC" ? -comparison : comparison;
      });

      return { invoices: matched, total: matched.length };
    },
  };
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
    ipfsHash: "QmTestHash",
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

describe("Marketplace sorting: default sort by face value descending", () => {
  const now = Date.now();

  // Seed 5 invoices with varying face values and distinct due dates
  const invoice5000 = createInvoice({
    amount: "5000.0000",
    status: InvoiceStatus.PUBLISHED,
    invoiceNumber: "INV-5000",
    dueDate: new Date(now + 10 * 24 * 60 * 60 * 1000), // 10 days
  });
  const invoice50000 = createInvoice({
    amount: "50000.0000",
    status: InvoiceStatus.PUBLISHED,
    invoiceNumber: "INV-50000",
    dueDate: new Date(now + 50 * 24 * 60 * 60 * 1000), // 50 days
  });
  const invoice1000 = createInvoice({
    amount: "1000.0000",
    status: InvoiceStatus.PUBLISHED,
    invoiceNumber: "INV-1000",
    dueDate: new Date(now + 5 * 24 * 60 * 60 * 1000), // 5 days
  });
  const invoice25000 = createInvoice({
    amount: "25000.0000",
    status: InvoiceStatus.PUBLISHED,
    invoiceNumber: "INV-25000",
    dueDate: new Date(now + 30 * 24 * 60 * 60 * 1000), // 30 days
  });
  const invoice10000 = createInvoice({
    amount: "10000.0000",
    status: InvoiceStatus.PUBLISHED,
    invoiceNumber: "INV-10000",
    dueDate: new Date(now + 20 * 24 * 60 * 60 * 1000), // 20 days
  });

  const allInvoices = [invoice5000, invoice50000, invoice1000, invoice25000, invoice10000];

  function createService(): MarketplaceService {
    return new MarketplaceService({
      marketplaceRepository: createFakeMarketplaceRepository(allInvoices),
    });
  }

  it("returns invoices sorted by face value descending by default", async () => {
    const marketplaceService = createService();

    const result = await marketplaceService.getPublishedInvoices();

    expect(result.data).toHaveLength(5);

    // Expected order: $50,000, $25,000, $10,000, $5,000, $1,000
    const amounts = result.data.map((invoice) => parseFloat(invoice.amount));
    expect(amounts).toEqual([50000, 25000, 10000, 5000, 1000]);
  });

  it("respects ?sort=faceValue:asc parameter override", async () => {
    const marketplaceService = createService();

    const result = await marketplaceService.getPublishedInvoices({
      sort: "amount",
      sortOrder: "ASC",
    });

    expect(result.data).toHaveLength(5);

    // Expected order: $1,000, $5,000, $10,000, $25,000, $50,000
    const amounts = result.data.map((invoice) => parseFloat(invoice.amount));
    expect(amounts).toEqual([1000, 5000, 10000, 25000, 50000]);
  });

  it("supports sorting by due_date ascending", async () => {
    const marketplaceService = createService();

    const result = await marketplaceService.getPublishedInvoices({
      sort: "due_date",
      sortOrder: "ASC",
    });

    expect(result.data).toHaveLength(5);

    // Verify due dates are in ascending order
    const dueDates = result.data.map((invoice) => invoice.dueDate.getTime());
    for (let i = 1; i < dueDates.length; i++) {
      expect(dueDates[i]).toBeGreaterThanOrEqual(dueDates[i - 1]);
    }
  });

  it("supports sorting by due_date descending", async () => {
    const marketplaceService = createService();

    const result = await marketplaceService.getPublishedInvoices({
      sort: "due_date",
      sortOrder: "DESC",
    });

    expect(result.data).toHaveLength(5);

    // Verify due dates are in descending order
    const dueDates = result.data.map((invoice) => invoice.dueDate.getTime());
    for (let i = 1; i < dueDates.length; i++) {
      expect(dueDates[i]).toBeLessThanOrEqual(dueDates[i - 1]);
    }
  });
});
