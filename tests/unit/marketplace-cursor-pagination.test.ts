import crypto from "crypto";
import {
  MarketplaceService,
  MarketplaceRepositoryContract,
  CursorPaginationOptions,
  MarketplaceFilters,
} from "../../src/services/marketplace.service";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatus } from "../../src/types/enums";
import { paginateQuery } from "../../src/utils/query-pagination.utils";

jest.mock("../../src/utils/query-pagination.utils", () => ({
  paginateQuery: jest.fn(),
}));

const mockedPaginateQuery = paginateQuery as jest.MockedFunction<typeof paginateQuery>;

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: crypto.randomUUID(),
    sellerId: crypto.randomUUID(),
    invoiceNumber: "INV-001",
    customerName: "Acme Corp",
    amount: "1000.0000",
    discountRate: "5.00",
    netAmount: "950.0000",
    dueDate: new Date("2026-01-01T00:00:00.000Z"),
    ipfsHash: "QmTest",
    riskScore: null,
    status: InvoiceStatus.PUBLISHED,
    smartContractId: null,
    createdAt: new Date("2025-06-01T00:00:00.000Z"),
    updatedAt: new Date("2025-06-01T00:00:00.000Z"),
    deletedAt: null,
    seller: undefined as unknown as Invoice["seller"],
    investments: [],
    transactions: [],
    ...overrides,
  } as Invoice;
}

describe("MarketplaceService.getPublishedInvoicesByCursor", () => {
  let repo: {
    findPublishedInvoices: jest.Mock;
    findPublishedInvoicesByCursor: jest.Mock;
  };
  let service: MarketplaceService;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = {
      findPublishedInvoices: jest.fn(),
      findPublishedInvoicesByCursor: jest.fn(),
    };
    service = new MarketplaceService({
      marketplaceRepository: repo as unknown as MarketplaceRepositoryContract,
    });
  });

  it("delegates to the repository's cursor method and maps invoices to PublicInvoice DTOs", async () => {
    const invoice = makeInvoice();
    repo.findPublishedInvoicesByCursor.mockResolvedValue({
      invoices: [invoice],
      nextCursor: "opaque-cursor",
      hasMore: true,
    });

    const options: CursorPaginationOptions = { sortField: "amount", limit: 10 };
    const result = await service.getPublishedInvoicesByCursor({}, options);

    expect(repo.findPublishedInvoicesByCursor).toHaveBeenCalledWith(
      expect.objectContaining({ status: [InvoiceStatus.PUBLISHED] }),
      expect.objectContaining({ sortField: "amount", order: "DESC", limit: 10, cursor: null })
    );

    expect(result.data).toEqual([
      {
        id: invoice.id,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customerName,
        sellerName: invoice.customerName,
        amount: invoice.amount,
        faceValue: invoice.amount,
        fundingTarget: invoice.netAmount || invoice.amount,
        amountRaised: invoice.fundedAmount || "0",
        fundedAmount: invoice.fundedAmount || "0",
        discountRate: invoice.discountRate,
        yieldBps: Math.round(parseFloat(invoice.discountRate || "0") * 100),
        fundingPercentage: parseFloat(invoice.netAmount || invoice.amount || "0") > 0
          ? Math.min(100, Math.round((parseFloat(invoice.fundedAmount || "0") / parseFloat(invoice.netAmount || invoice.amount || "0")) * 10000) / 100)
          : 0,
        netAmount: invoice.netAmount,
        dueDate: invoice.dueDate,
        fundingDeadline: invoice.dueDate,
        status: invoice.status,
        createdAt: invoice.createdAt,
      },
    ]);
    expect(result.nextCursor).toBe("opaque-cursor");
    expect(result.hasMore).toBe(true);
  });

  it("clamps limit to a maximum of 100", async () => {
    repo.findPublishedInvoicesByCursor.mockResolvedValue({
      invoices: [],
      nextCursor: null,
      hasMore: false,
    });

    await service.getPublishedInvoicesByCursor({}, { sortField: "due_date", limit: 500 });

    expect(repo.findPublishedInvoicesByCursor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 100 })
    );
  });

  it("clamps limit to a minimum of 1", async () => {
    repo.findPublishedInvoicesByCursor.mockResolvedValue({
      invoices: [],
      nextCursor: null,
      hasMore: false,
    });

    await service.getPublishedInvoicesByCursor({}, { sortField: "due_date", limit: -5 });

    expect(repo.findPublishedInvoicesByCursor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 1 })
    );
  });

  it("passes through a supplied cursor and custom filters unchanged", async () => {
    repo.findPublishedInvoicesByCursor.mockResolvedValue({
      invoices: [],
      nextCursor: null,
      hasMore: false,
    });

    const filters: MarketplaceFilters = { search: "acme", minAmount: 100 };
    await service.getPublishedInvoicesByCursor(filters, {
      sortField: "created_at",
      order: "ASC",
      limit: 20,
      cursor: "prior-cursor",
    });

    expect(repo.findPublishedInvoicesByCursor).toHaveBeenCalledWith(
      expect.objectContaining({ search: "acme", minAmount: 100 }),
      expect.objectContaining({
        sortField: "created_at",
        order: "ASC",
        limit: 20,
        cursor: "prior-cursor",
      })
    );
  });

  it("throws a clear error when the injected repository does not implement the cursor method", async () => {
    const legacyRepo: MarketplaceRepositoryContract = {
      findPublishedInvoices: jest.fn(),
      // findPublishedInvoicesByCursor intentionally omitted
    };
    const legacyService = new MarketplaceService({ marketplaceRepository: legacyRepo });

    await expect(
      legacyService.getPublishedInvoicesByCursor({}, { sortField: "amount", limit: 10 })
    ).rejects.toThrow(/does not implement findPublishedInvoicesByCursor/);
  });
});

describe("TypeORMMarketplaceRepository.findPublishedInvoicesByCursor (via createMarketplaceService)", () => {
  it("maps each public sort field name to the Invoice entity's camelCase cursor property", async () => {
    // Exercised indirectly: paginateQuery is mocked, so we only assert the
    // `cursorField` argument it was called with for each public sort name.
    mockedPaginateQuery.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });

    const { createMarketplaceService } = await import("../../src/services/marketplace.service");
    const { DataSource } = await import("typeorm");

    const fakeQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
    };
    const fakeRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(fakeQueryBuilder),
    };
    const fakeDataSource = {
      getRepository: jest.fn().mockReturnValue(fakeRepository),
    } as unknown as InstanceType<typeof DataSource>;

    const service = createMarketplaceService(fakeDataSource);

    const cases: Array<[CursorPaginationOptions["sortField"], string]> = [
      ["due_date", "invoice.dueDate"],
      ["discount_rate", "invoice.discountRate"],
      ["amount", "invoice.amount"],
      ["created_at", "invoice.createdAt"],
    ];

    for (const [sortField, expectedCursorField] of cases) {
      mockedPaginateQuery.mockClear();
      await service.getPublishedInvoicesByCursor({}, { sortField, limit: 10 });
      expect(mockedPaginateQuery).toHaveBeenCalledWith(
        expect.objectContaining({ cursorField: expectedCursorField })
      );
    }
  });
});
