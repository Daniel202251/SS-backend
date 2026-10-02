import crypto from "crypto";
import {
  MarketplaceService,
  MarketplaceRepositoryContract,
} from "../../src/services/marketplace.service";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatus } from "../../src/types/enums";

/**
 * In-memory stand-in for the TypeORM-backed marketplace repository. Mirrors
 * the real repository's status filtering (defaulting to PUBLISHED, or the
 * exact statuses requested) so this test exercises the real
 * MarketplaceService filtering logic end to end without a live database.
 */
function createFakeMarketplaceRepository(invoices: Invoice[]): MarketplaceRepositoryContract {
  return {
    async findPublishedInvoices(filters) {
      const statuses =
        filters.status && filters.status.length > 0 ? filters.status : [InvoiceStatus.PUBLISHED];
      const matched = invoices.filter((invoice) => statuses.includes(invoice.status));
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

describe("Marketplace listing integration: filtering invoices by status", () => {
  const draftInvoice = createInvoice({ status: InvoiceStatus.DRAFT });
  const publishedInvoiceA = createInvoice({ status: InvoiceStatus.PUBLISHED });
  const publishedInvoiceB = createInvoice({ status: InvoiceStatus.PUBLISHED });
  const fundedInvoice = createInvoice({ status: InvoiceStatus.FUNDED });
  const settledInvoice = createInvoice({ status: InvoiceStatus.SETTLED });

  const allInvoices = [
    draftInvoice,
    publishedInvoiceA,
    publishedInvoiceB,
    fundedInvoice,
    settledInvoice,
  ];

  function createService(): MarketplaceService {
    return new MarketplaceService({
      marketplaceRepository: createFakeMarketplaceRepository(allInvoices),
    });
  }

  it("returns only published invoices by default", async () => {
    const marketplaceService = createService();

    const result = await marketplaceService.getPublishedInvoices();

    expect(result.data).toHaveLength(2);
    expect(result.data.map((invoice) => invoice.id).sort()).toEqual(
      [publishedInvoiceA.id, publishedInvoiceB.id].sort()
    );
    expect(result.data.every((invoice) => invoice.status === InvoiceStatus.PUBLISHED)).toBe(true);
  });

  it("returns only funded invoices when filtered by status=funded", async () => {
    const marketplaceService = createService();

    const result = await marketplaceService.getPublishedInvoices({
      status: [InvoiceStatus.FUNDED],
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe(fundedInvoice.id);
  });

  it("returns only settled invoices when filtered by status=settled", async () => {
    const marketplaceService = createService();

    const result = await marketplaceService.getPublishedInvoices({
      status: [InvoiceStatus.SETTLED],
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe(settledInvoice.id);
  });

  it("never includes draft invoices, regardless of the filter applied", async () => {
    const marketplaceService = createService();

    const results = await Promise.all([
      marketplaceService.getPublishedInvoices(),
      marketplaceService.getPublishedInvoices({ status: [InvoiceStatus.FUNDED] }),
      marketplaceService.getPublishedInvoices({ status: [InvoiceStatus.SETTLED] }),
    ]);

    for (const result of results) {
      expect(result.data.some((invoice) => invoice.id === draftInvoice.id)).toBe(false);
    }
  });
});
