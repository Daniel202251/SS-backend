import crypto from "crypto";
import { DataSource, EntityManager } from "typeorm";
import { Decimal } from "decimal.js";
import { InvestmentService } from "../../src/services/investment.service";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { InvestorAcknowledgement } from "../../src/models/InvestorAcknowledgement.model";
import { InvoiceStatus, InvestmentStatus } from "../../src/types/enums";

/**
 * Fake DataSource that serializes concurrent transactions through a sequential
 * promise chain, mirroring how pessimistic row locking works in a real database.
 * Two concurrent calls to `transaction()` will run one after the other, so the
 * second always sees the committed state of the first.
 */
function createSerializedFakeDataSource(invoice: Invoice) {
  const invoices = new Map<string, Invoice>([[invoice.id, invoice]]);
  const investments = new Map<string, Investment>();

  const manager = {
    createQueryBuilder: (_entity: unknown, _alias: string) => {
      let targetId: string | undefined;
      const builder = {
        setLock: () => builder,
        where: (_clause: string, params: { id: string }) => {
          targetId = params.id;
          return builder;
        },
        getOne: async () => (targetId ? (invoices.get(targetId) ?? null) : null),
      };
      return builder;
    },
    find: async (
      entity: unknown,
      options: { where: Record<string, unknown> | Record<string, unknown>[] }
    ) => {
      if (entity === Investment) {
        const clauses = Array.isArray(options.where) ? options.where : [options.where];
        return [...investments.values()].filter((inv) =>
          clauses.some((clause) =>
            Object.entries(clause).every(
              ([k, v]) => (inv as unknown as Record<string, unknown>)[k] === v
            )
          )
        );
      }
      return [];
    },
    create: (_entity: unknown, data: Partial<Investment>) =>
      ({ id: crypto.randomUUID(), status: InvestmentStatus.PENDING, ...data }) as Investment,
    save: async (entity: unknown, data: Investment | Invoice) => {
      if (entity === Investment) investments.set((data as Investment).id, data as Investment);
      else if (entity === Invoice) invoices.set((data as Invoice).id, data as Invoice);
      return data;
    },
  };

  // Serialize all transactions through a sequential chain
  let txChain: Promise<unknown> = Promise.resolve();

  const dataSource = {
    transaction: (callback: (em: typeof manager) => Promise<unknown>) => {
      const next = txChain.then(() => callback(manager));
      txChain = next.catch(() => {});
      return next;
    },
    getRepository: () => ({
      findOne: jest.fn().mockResolvedValue({ walletAddress: "test", termsVersion: "1", acknowledgedAt: new Date() }),
      find: jest.fn().mockResolvedValue([]),
    }),
  } as unknown as DataSource;

  // Issue #473 â€” the accreditation gate looks the investor's terms
  // acknowledgement up before creating the investment.
  (dataSource as unknown as { getRepository: (e: unknown) => unknown }).getRepository = (
    entity: unknown
  ) =>
    entity === InvestorAcknowledgement
      ? { findOne: async () => ({ acknowledgedAt: new Date() }) }
      : manager;

  return { dataSource, invoices, investments };
}

function createInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: crypto.randomUUID(),
    sellerId: crypto.randomUUID(),
    invoiceNumber: "INV-CONCURRENT-001",
    customerName: "Concurrent Test Customer",
    amount: "1000.0000",
    discountRate: "0.00",
    netAmount: "1000.0000",
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

const INVESTOR_A_WALLET = "GINVESTORA1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const INVESTOR_B_WALLET = "GINVESTORB1234567890ABCDEFGHIJKLMNOPQRSTUVWXY1";

describe("Concurrent investment: total committed amount must not exceed invoice capacity (issue #114)", () => {
  it("allows exactly one of two simultaneous investments when only one slot remains", async () => {
    // Invoice with 700 already committed; remaining capacity = 300.
    // Both requests ask for 200, so the first fits (900 total < 1000 netAmount) and the
    // second finds only 100 remaining â€” not enough â€” and fails with INSUFFICIENT_CAPACITY.
    // The invoice is NOT fully funded by the first request, so status stays PUBLISHED.
    const invoice = createInvoice();
    const { dataSource, investments } = createSerializedFakeDataSource(invoice);

    // Seed 700 already committed
    const existingInvestorId = crypto.randomUUID();
    const existingInvestment: Investment = {
      id: crypto.randomUUID(),
      invoiceId: invoice.id,
      investorId: existingInvestorId,
      investmentAmount: "700.0000",
      expectedReturn: "700.0000",
      status: InvestmentStatus.PENDING,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Investment;
    investments.set(existingInvestment.id, existingInvestment);

    const investmentService = new InvestmentService(dataSource);

    const investorA = { id: crypto.randomUUID(), wallet: INVESTOR_A_WALLET };
    const investorB = { id: crypto.randomUUID(), wallet: INVESTOR_B_WALLET };

    // Fire two simultaneous requests each for 200
    const results = await Promise.allSettled([
      investmentService.createInvestment({
        invoiceId: invoice.id,
        investorId: investorA.id,
        investmentAmount: "200.0000",
        investorWallet: investorA.wallet,
      }),
      investmentService.createInvestment({
        invoiceId: invoice.id,
        investorId: investorB.id,
        investmentAmount: "200.0000",
        investorWallet: investorB.wallet,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one succeeds
    expect(fulfilled).toHaveLength(1);

    // Exactly one fails with INSUFFICIENT_CAPACITY
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0] as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ code: "INSUFFICIENT_CAPACITY" });

    // Total committed = 700 (seeded) + 200 (one success) = 900; well under 1000
    const totalCommitted = [...investments.values()].reduce(
      (sum, inv) => sum.plus(new Decimal(inv.investmentAmount)),
      new Decimal(0)
    );
    expect(totalCommitted.toFixed(4)).toBe("900.0000");
  });

  it("leaves no partial records: the rejected request produces no investment row", async () => {
    const invoice = createInvoice({ netAmount: "500.0000", amount: "500.0000" });
    const { dataSource, investments } = createSerializedFakeDataSource(invoice);

    const investmentService = new InvestmentService(dataSource);
    const investorA = { id: crypto.randomUUID(), wallet: INVESTOR_A_WALLET };
    const investorB = { id: crypto.randomUUID(), wallet: INVESTOR_B_WALLET };

    // Both ask for 400 â€” only one fits (500 capacity)
    await Promise.allSettled([
      investmentService.createInvestment({
        invoiceId: invoice.id,
        investorId: investorA.id,
        investmentAmount: "400.0000",
        investorWallet: investorA.wallet,
      }),
      investmentService.createInvestment({
        invoiceId: invoice.id,
        investorId: investorB.id,
        investmentAmount: "400.0000",
        investorWallet: investorB.wallet,
      }),
    ]);

    // Only one investment record should exist
    expect(investments.size).toBe(1);
    const [saved] = [...investments.values()];
    expect(new Decimal(saved.investmentAmount).toFixed(4)).toBe("400.0000");
  });

  it("allows both concurrent investments through when their combined total exactly equals remaining capacity", async () => {
    // Two concurrent requests for 250 each against an empty 500-capacity invoice
    // sum to exactly 500 â€” neither individually exceeds capacity at submit time,
    // and since they're serialized, the second sees the first's 250 already
    // committed and still fits in the remaining 250. Total must land exactly at
    // capacity, both must succeed, and the invoice must transition to FUNDED.
    const invoice = createInvoice({ netAmount: "500.0000", amount: "500.0000" });
    const { dataSource, investments, invoices } = createSerializedFakeDataSource(invoice);

    const investmentService = new InvestmentService(dataSource);
    const investorA = { id: crypto.randomUUID(), wallet: INVESTOR_A_WALLET };
    const investorB = { id: crypto.randomUUID(), wallet: INVESTOR_B_WALLET };

    const results = await Promise.allSettled([
      investmentService.createInvestment({
        invoiceId: invoice.id,
        investorId: investorA.id,
        investmentAmount: "250.0000",
        investorWallet: investorA.wallet,
      }),
      investmentService.createInvestment({
        invoiceId: invoice.id,
        investorId: investorB.id,
        investmentAmount: "250.0000",
        investorWallet: investorB.wallet,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);

    const totalCommitted = [...investments.values()].reduce(
      (sum, inv) => sum.plus(new Decimal(inv.investmentAmount)),
      new Decimal(0)
    );
    expect(totalCommitted.toFixed(4)).toBe("500.0000");

    // Invoice should be fully funded, not left PUBLISHED with 0 remaining capacity.
    const updatedInvoice = invoices.get(invoice.id)!;
    expect(updatedInvoice.status).toBe(InvoiceStatus.FUNDED);
  });

  it("enforces capacity across three simultaneous investors: exactly enough succeed to fill capacity, the rest are rejected", async () => {
    // 1000 capacity, three concurrent requests for 400 each (1200 total demand).
    // Serialized execution means exactly two fit (400 + 400 = 800 <= 1000) and
    // the third's remaining capacity (200) is insufficient for its 400 request.
    const invoice = createInvoice({ netAmount: "1000.0000", amount: "1000.0000" });
    const { dataSource, investments } = createSerializedFakeDataSource(invoice);

    const investmentService = new InvestmentService(dataSource);
    const investors = [
      { id: crypto.randomUUID(), wallet: INVESTOR_A_WALLET },
      { id: crypto.randomUUID(), wallet: INVESTOR_B_WALLET },
      { id: crypto.randomUUID(), wallet: "GINVESTORC1234567890ABCDEFGHIJKLMNOPQRSTUVWX2" },
    ];

    const results = await Promise.allSettled(
      investors.map((investor) =>
        investmentService.createInvestment({
          invoiceId: invoice.id,
          investorId: investor.id,
          investmentAmount: "400.0000",
          investorWallet: investor.wallet,
        })
      )
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "INSUFFICIENT_CAPACITY",
    });

    // Total committed never exceeds the invoice's face value, and exactly two
    // investment rows exist â€” the rejected request left no partial record.
    expect(investments.size).toBe(2);
    const totalCommitted = [...investments.values()].reduce(
      (sum, inv) => sum.plus(new Decimal(inv.investmentAmount)),
      new Decimal(0)
    );
    expect(totalCommitted.toFixed(4)).toBe("800.0000");
    expect(totalCommitted.lte(new Decimal("1000.0000"))).toBe(true);
  });
});
