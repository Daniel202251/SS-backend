import { DataSource } from "typeorm";
import { Invoice } from "../../src/models/Invoice.model";
import { User } from "../../src/models/User.model";
import { Investment } from "../../src/models/Investment.model";
import { Transaction } from "../../src/models/Transaction.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { Notification } from "../../src/models/Notification.model";
import { AuthChallenge } from "../../src/models/AuthChallenge.model";
import {
  InvoiceSearchService,
  type InvoiceSearchHit,
} from "../../src/services/invoice-search.service";
import {
  INVOICE_SEARCH_INDEX_SQL,
  INVOICE_SEARCH_VECTOR_SQL,
} from "../../src/migrations/1733000000000-AddInvoiceFullTextSearch";
import { InvoiceStatus, KYCStatus, UserType } from "../../src/types/enums";

/**
 * Full-text invoice search against real Postgres (tsvector / GIN cannot be
 * faked in memory). Skips when DATABASE_URL is not set, like the other
 * Postgres-backed suites.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

/** Own schema so parallel suites sharing this database cannot drop or lock our tables. */
const TEST_SCHEMA = "fts_integration_test";

describeIfDb("Invoice full-text search (Postgres)", () => {
  let dataSource: DataSource;
  let service: InvoiceSearchService;
  let sellerId: string;
  let counter = 0;

  beforeAll(async () => {
    const admin = new DataSource({ type: "postgres", url: databaseUrl });
    await admin.initialize();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await admin.destroy();

    dataSource = new DataSource({
      type: "postgres",
      url: databaseUrl,
      extra: { options: `-c search_path=${TEST_SCHEMA},public` },
      entities: [User, Invoice, Investment, Transaction, KYCVerification, Notification, AuthChallenge],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    // synchronize does not know about the generated search column.
    await dataSource.query(INVOICE_SEARCH_VECTOR_SQL);
    await dataSource.query(INVOICE_SEARCH_INDEX_SQL);

    const users = dataSource.getRepository(User);
    const seller = await users.save(
      users.create({
        stellarAddress: "GSELLERFTS".padEnd(56, "A"),
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      })
    );
    sellerId = seller.id;
    service = new InvoiceSearchService(dataSource);
  }, 30000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "invoices"`);
  });

  async function seed(overrides: Partial<Invoice>): Promise<Invoice> {
    counter += 1;
    const repo = dataSource.getRepository(Invoice);
    return repo.save(
      repo.create({
        sellerId,
        invoiceNumber: `FTS-${counter}-${Date.now()}`,
        customerName: "Customer",
        amount: "1000.0000",
        discountRate: "5.00",
        netAmount: "950.0000",
        dueDate: new Date("2026-12-01"),
        status: InvoiceStatus.PUBLISHED,
        ...overrides,
      })
    );
  }

  const ids = (hits: InvoiceSearchHit[]) => hits.map((h) => h.id);

  it("matches issuer name and description, ranking issuer-name matches first", async () => {
    const inDescription = await seed({
      issuerName: "Northwind Traders",
      description: "Freight services for Acme warehouses",
    });
    const inIssuer = await seed({ issuerName: "Acme Logistics", description: "Pallet shipping" });
    await seed({ issuerName: "Globex", description: "Consulting" });

    const { items } = await service.search({ q: "acme" });

    expect(ids(items)).toEqual([inIssuer.id, inDescription.id]);
    expect(items[0].rank).toBeGreaterThan(items[1].rank!);
  });

  it("stems words, so 'shipped' finds 'shipping'", async () => {
    const hit = await seed({ issuerName: "Oceanic", description: "Container shipping to Lagos" });

    const { items } = await service.search({ q: "shipped" });

    expect(ids(items)).toEqual([hit.id]);
  });

  it("combines the text query with every filter", async () => {
    const match = await seed({
      issuerName: "Acme",
      amount: "2500.0000",
      dueDate: new Date("2026-11-15"),
      status: InvoiceStatus.FUNDED,
    });
    await seed({ issuerName: "Acme", amount: "50.0000", status: InvoiceStatus.FUNDED });
    await seed({ issuerName: "Acme", amount: "2500.0000", dueDate: new Date("2027-03-01"), status: InvoiceStatus.FUNDED });
    await seed({ issuerName: "Acme", amount: "2500.0000", status: InvoiceStatus.PUBLISHED });
    await seed({ issuerName: "Acme", amount: "2500.0000", status: InvoiceStatus.DRAFT });

    const { items } = await service.search({
      q: "acme",
      status: [InvoiceStatus.FUNDED],
      minAmount: "1000",
      maxAmount: "3000",
      dueAfter: new Date("2026-11-01"),
      dueBefore: new Date("2026-12-31"),
    });

    expect(ids(items)).toEqual([match.id]);
  });

  it("returns filtered results without ranking when the query is empty", async () => {
    const older = await seed({ issuerName: "A", amount: "700.0000" });
    const newer = await seed({ issuerName: "B", amount: "800.0000" });
    await seed({ issuerName: "C", amount: "10.0000" });

    const { items } = await service.search({ q: "  ", minAmount: "500" });

    expect(ids(items)).toEqual([newer.id, older.id]);
    expect(items.every((hit) => hit.rank === undefined)).toBe(true);
  });

  it("never returns draft or in-review invoices by default", async () => {
    await seed({ issuerName: "Acme", status: InvoiceStatus.DRAFT });
    await seed({ issuerName: "Acme", status: InvoiceStatus.PENDING });

    expect((await service.search({ q: "acme" })).items).toHaveLength(0);
  });

  it.each([
    ["ranked", "acme"],
    ["unranked", undefined],
  ])("pages through %s results with the cursor without gaps or repeats", async (_label, q) => {
    const seeded: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      // Equal ranks for half the rows exercise the (created_at, id) tie-break.
      const invoice = await seed({
        issuerName: i % 2 ? "Acme Acme Supplies" : "Acme Supplies",
        description: "Office goods",
      });
      seeded.push(invoice.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.search({ q, limit: 3, cursor });
      seen.push(...ids(page.items));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(seeded));
  });

  it("answers within 300ms on an indexed table", async () => {
    await dataSource.query(
      `INSERT INTO "invoices" ("seller_id", "invoice_number", "customer_name", "amount", "discount_rate",
         "net_amount", "due_date", "status", "issuer_name", "description", "version")
       SELECT $1, 'BULK-' || g, 'Customer', 1000, 5, 950, DATE '2026-12-01', 'published',
              'Issuer ' || g, 'Invoice for freight batch ' || g, 1
       FROM generate_series(1, 20000) AS g`,
      [sellerId]
    );
    await seed({ issuerName: "Acme Logistics", description: "Rare widget order" });
    await dataSource.query(`ANALYZE "invoices"`);

    const startedAt = performance.now();
    const { items } = await service.search({ q: "widget", minAmount: "100" });
    const elapsed = performance.now() - startedAt;

    expect(items).toHaveLength(1);
    expect(elapsed).toBeLessThan(300);
  }, 60000);
});
