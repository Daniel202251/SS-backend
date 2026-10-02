import crypto from "crypto";
import {
  MarketplaceService,
  MarketplaceRepositoryContract,
} from "../../src/services/marketplace.service";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatus } from "../../src/types/enums";

/**
 * In-memory repository that implements case-insensitive search on
 * customer_name, mirroring the real TypeORM repository's LIKE filter.
 */
function createFakeMarketplaceRepository(invoices: Invoice[]): MarketplaceRepositoryContract {
  return {
    async findPublishedInvoices(filters) {
      const statuses =
        filters.status && filters.status.length > 0 ? filters.status : [InvoiceStatus.PUBLISHED];
      let matched = invoices.filter((invoice) => statuses.includes(invoice.status));

      if (filters.search) {
        const term = filters.search.toLowerCase();
        matched = matched.filter((inv) => inv.customerName.toLowerCase().includes(term));
      }

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
    status: InvoiceStatus.PUBLISHED,
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

describe("Invoice search: partial title match (case-insensitive)", () => {
  const alphaInvoice = createInvoice({ customerName: "Alpha Invoice" });
  const betaSupply = createInvoice({ customerName: "Beta Supply" });
  const alphaProject = createInvoice({ customerName: "Alpha project supplies" });

  const allInvoices = [alphaInvoice, betaSupply, alphaProject];

  let service: MarketplaceService;

  beforeEach(() => {
    service = new MarketplaceService({
      marketplaceRepository: createFakeMarketplaceRepository(allInvoices),
    });
  });

  it("returns two invoices when searching for 'alpha' (title match)", async () => {
    const result = await service.getPublishedInvoices({ search: "alpha" });
    expect(result.data).toHaveLength(2);
    const names = result.data.map((i) => i.customerName);
    expect(names).toContain("Alpha Invoice");
    expect(names).toContain("Alpha project supplies");
  });

  it("returns one invoice when searching for 'beta'", async () => {
    const result = await service.getPublishedInvoices({ search: "beta" });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].customerName).toBe("Beta Supply");
  });

  it("returns empty array for no-match search with 200-style response", async () => {
    const result = await service.getPublishedInvoices({ search: "zzznomatch" });
    expect(result.data).toHaveLength(0);
    expect(result.meta.total).toBe(0);
  });

  it("search is case-insensitive", async () => {
    const result = await service.getPublishedInvoices({ search: "ALPHA" });
    expect(result.data).toHaveLength(2);
  });

  it("returns all invoices when no search term is provided", async () => {
    const result = await service.getPublishedInvoices({});
    expect(result.data).toHaveLength(3);
  });
});
