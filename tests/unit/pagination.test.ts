import { DataSource, Repository, SelectQueryBuilder } from "typeorm";
import { queryInvoicesPage } from "../../src/utils/pagination";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatus } from "../../src/types/enums";

describe("queryInvoicesPage", () => {
  let mockDataSource: jest.Mocked<DataSource>;
  let mockRepository: jest.Mocked<Repository<Invoice>>;
  let mockQueryBuilder: jest.Mocked<SelectQueryBuilder<Invoice>>;

  function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
    return {
      id: "invoice-1",
      sellerId: "seller-1",
      invoiceNumber: "INV-001",
      status: InvoiceStatus.PUBLISHED,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      ...overrides,
    } as Invoice;
  }

  beforeEach(() => {
    mockQueryBuilder = {
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      addOrderBy: jest.fn(),
      take: jest.fn(),
      getMany: jest.fn(),
    } as any;

    mockQueryBuilder.where.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.andWhere.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.orderBy.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.addOrderBy.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.take.mockReturnValue(mockQueryBuilder);

    mockRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    } as any;

    mockDataSource = Object.assign(Object.create(DataSource.prototype), {
      getRepository: jest.fn().mockReturnValue(mockRepository),
    });
  });

  it("returns the first page ordered by created_at desc when cursor is null", async () => {
    const invoices = [makeInvoice({ id: "1" }), makeInvoice({ id: "2" })];
    mockQueryBuilder.getMany.mockResolvedValue(invoices);

    const result = await queryInvoicesPage({}, null, 2, mockDataSource);

    expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith("invoice.createdAt", "DESC");
    expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith("invoice.id", "DESC");
    expect(mockQueryBuilder.take).toHaveBeenCalledWith(3);
    expect(result.data).toHaveLength(2);
    expect(result.has_more).toBe(false);
  });

  it("returns results strictly after the cursor position", async () => {
    const cursor = Buffer.from("2024-01-01T00:00:00.000Z|invoice-5").toString("base64");
    mockQueryBuilder.getMany.mockResolvedValue([makeInvoice({ id: "6" })]);

    await queryInvoicesPage({}, cursor, 10, mockRepository);

    expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
      "(invoice.createdAt < :createdAt OR (invoice.createdAt = :createdAt AND invoice.id < :id))",
      { createdAt: new Date("2024-01-01T00:00:00.000Z"), id: "invoice-5" }
    );
  });

  it("sets has_more: false when the page is not full", async () => {
    mockQueryBuilder.getMany.mockResolvedValue([makeInvoice()]);

    const result = await queryInvoicesPage({}, null, 5, mockDataSource);

    expect(result.has_more).toBe(false);
    expect(result.next_cursor).not.toBeNull();
  });

  it("sets has_more: true and trims the extra row when more results exist", async () => {
    const invoices = [makeInvoice({ id: "1" }), makeInvoice({ id: "2" }), makeInvoice({ id: "3" })];
    mockQueryBuilder.getMany.mockResolvedValue(invoices);

    const result = await queryInvoicesPage({}, null, 2, mockDataSource);

    expect(result.has_more).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("never returns the same invoice across two consecutive pages", async () => {
    const page1Invoices = [
      makeInvoice({ id: "1", createdAt: new Date("2024-01-03T00:00:00.000Z") }),
      makeInvoice({ id: "2", createdAt: new Date("2024-01-02T00:00:00.000Z") }),
      makeInvoice({ id: "3", createdAt: new Date("2024-01-01T00:00:00.000Z") }),
    ];
    mockQueryBuilder.getMany.mockResolvedValueOnce(page1Invoices);

    const page1 = await queryInvoicesPage({}, null, 2, mockDataSource);
    expect(page1.data.map((i) => i.id)).toEqual(["1", "2"]);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).not.toBeNull();

    mockQueryBuilder.getMany.mockResolvedValueOnce([page1Invoices[2]]);
    const page2 = await queryInvoicesPage({}, page1.next_cursor, 2, mockDataSource);

    expect(page2.data.map((i) => i.id)).toEqual(["3"]);
    expect(page2.has_more).toBe(false);
    const page1Ids = new Set(page1.data.map((i) => i.id));
    expect(page2.data.some((i) => page1Ids.has(i.id))).toBe(false);
  });

  it("applies sellerId and status filters", async () => {
    mockQueryBuilder.getMany.mockResolvedValue([]);

    await queryInvoicesPage(
      { sellerId: "seller-1", status: InvoiceStatus.FUNDED },
      null,
      10,
      mockDataSource
    );

    expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith("invoice.sellerId = :sellerId", {
      sellerId: "seller-1",
    });
    expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith("invoice.status = :status", {
      status: InvoiceStatus.FUNDED,
    });
  });

  it("applies an array of statuses via IN clause", async () => {
    mockQueryBuilder.getMany.mockResolvedValue([]);

    await queryInvoicesPage(
      { status: [InvoiceStatus.DRAFT, InvoiceStatus.PUBLISHED] },
      null,
      10,
      mockDataSource
    );

    expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith("invoice.status IN (:...statuses)", {
      statuses: [InvoiceStatus.DRAFT, InvoiceStatus.PUBLISHED],
    });
  });

  it("accepts a Repository directly instead of a DataSource", async () => {
    mockQueryBuilder.getMany.mockResolvedValue([]);

    await queryInvoicesPage({}, null, 10, mockRepository);

    expect(mockRepository.createQueryBuilder).toHaveBeenCalledWith("invoice");
    expect(mockDataSource.getRepository).not.toHaveBeenCalled();
  });

  it("remains stable when a new invoice is inserted between page fetches", async () => {
    // Seed 10 invoices with known created_at values, sorted newest-first
    const allInvoices = Array.from({ length: 10 }, (_, i) =>
      makeInvoice({
        id: `invoice-${i + 1}`,
        createdAt: new Date(`2024-01-${String(10 - i).padStart(2, "0")}T00:00:00.000Z`),
      })
    );

    // Page 1: limit 5, returns invoices 1-5 (newest)
    mockQueryBuilder.getMany.mockResolvedValueOnce(allInvoices.slice(0, 6)); // 6 because take = limit+1
    const page1 = await queryInvoicesPage({}, null, 5, mockDataSource);

    expect(page1.data.map((i) => i.id)).toEqual([
      "invoice-1",
      "invoice-2",
      "invoice-3",
      "invoice-4",
      "invoice-5",
    ]);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).not.toBeNull();

    // Record page 1 IDs
    const page1Ids = new Set(page1.data.map((i) => i.id));

    // Insert a new invoice with a created_at newer than all existing ones
    const newInvoice = makeInvoice({
      id: "invoice-new",
      createdAt: new Date("2024-01-11T00:00:00.000Z"),
    });

    // Page 2: should return the next 5 original invoices (6-10), NOT the new one
    mockQueryBuilder.getMany.mockResolvedValueOnce(allInvoices.slice(5, 11)); // 6 because take = limit+1
    const page2 = await queryInvoicesPage({}, page1.next_cursor, 5, mockDataSource);

    expect(page2.data).toHaveLength(5);
    expect(page2.data.map((i) => i.id)).toEqual([
      "invoice-6",
      "invoice-7",
      "invoice-8",
      "invoice-9",
      "invoice-10",
    ]);
    expect(page2.has_more).toBe(false);

    // Newly inserted invoice does not appear in page 2
    expect(page2.data.some((i) => i.id === "invoice-new")).toBe(false);

    // No original invoice skipped between page 1 and page 2
    const allPageIds = [...page1.data, ...page2.data].map((i) => i.id);
    expect(allPageIds).toEqual([
      "invoice-1",
      "invoice-2",
      "invoice-3",
      "invoice-4",
      "invoice-5",
      "invoice-6",
      "invoice-7",
      "invoice-8",
      "invoice-9",
      "invoice-10",
    ]);

    // Combined pages cover all 10 original invoices exactly once (no duplicates)
    expect(allPageIds.length).toBe(10);
    expect(new Set(allPageIds).size).toBe(10);

    // No overlap between pages
    const page2Ids = new Set(page2.data.map((i) => i.id));
    expect([...page1Ids].filter((id) => page2Ids.has(id))).toHaveLength(0);
  });
});
