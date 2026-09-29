import crypto from "crypto";
import { DataSource } from "typeorm";
import { InvestmentService } from "../../src/services/investment.service";
import { SettlementService } from "../../src/services/settlement.service";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../../src/types/enums";
import { logger } from "../../src/observability/logger";
import { ServiceError } from "../../src/utils/service-error";

/**
 * Minimal in-memory TypeORM stand-in shared by InvestmentService and
 * SettlementService so this test exercises the real funding -> settlement
 * flow end to end without a live database.
 */
function createFakeDataSource(invoice: Invoice) {
  const invoices = new Map<string, Invoice>([[invoice.id, invoice]]);
  const investments = new Map<string, Investment>();

  type FakeManager = {
    createQueryBuilder: (
      entity: unknown,
      alias: string
    ) => {
      setLock: () => unknown;
      where: (clause: string, params: { id: string }) => unknown;
      getOne: () => Promise<Invoice | null>;
    };
    find: (
      entity: unknown,
      options: { where: Record<string, unknown> | Record<string, unknown>[] }
    ) => Promise<Investment[]>;
    create: (entity: unknown, data: Partial<Investment>) => Investment | Partial<Investment>;
    save: (entity: unknown, data: Investment | Invoice) => Promise<Investment | Invoice>;
  };

  const manager: FakeManager = {
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
        const whereClauses = Array.isArray(options.where) ? options.where : [options.where];
        return [...investments.values()].filter((investment) =>
          whereClauses.some((clause) =>
            Object.entries(clause).every(
              ([key, value]) => (investment as unknown as Record<string, unknown>)[key] === value
            )
          )
        );
      }
      return [];
    },
    create: (entity: unknown, data: Partial<Investment>) => {
      if (entity === Investment) {
        return { id: crypto.randomUUID(), ...data } as Investment;
      }
      return data;
    },
    save: async (entity: unknown, data: Investment | Invoice) => {
      if (entity === Investment) {
        investments.set((data as Investment).id, data as Investment);
      } else if (entity === Invoice) {
        invoices.set((data as Invoice).id, data as Invoice);
      }
      return data;
    },
  };

  const dataSource = {
    transaction: async (callback: (manager: FakeManager) => Promise<unknown>) => callback(manager),
  } as unknown as DataSource;

  return { dataSource, invoices, investments };
}

function createInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: crypto.randomUUID(),
    sellerId: crypto.randomUUID(),
    invoiceNumber: "INV-SETTLE-001",
    customerName: "Customer A",
    amount: "6000.0000",
    discountRate: "0.00",
    netAmount: "6000.0000",
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

// ── Helper: mark investment as confirmed in the fake store ──────────────────

function confirmInvestment(investments: Map<string, Investment>, investment: Investment) {
  const stored = investments.get(investment.id)!;
  stored.status = InvestmentStatus.CONFIRMED;
  investments.set(investment.id, stored);
}

// ── Helper: fund an invoice fully with N investors ──────────────────────────
// REFACTORED: Added robust error handling and logging for edge cases and failures.

async function fullyFundInvoice(
  dataSource: DataSource,
  investments: Map<string, Investment>,
  invoice: Invoice,
  shares: Array<{ amount: string; wallet: string }>
) {
  const investmentService = new InvestmentService(dataSource);
  const created = [];

  try {
    for (const share of shares) {
      try {
        const inv = await investmentService.createInvestment({
          invoiceId: invoice.id,
          investorId: crypto.randomUUID(),
          investmentAmount: share.amount,
          investorWallet: share.wallet,
        });
        confirmInvestment(investments, inv);
        created.push(inv);
      } catch (error) {
        logger.error("Failed to create or confirm investment", {
          invoiceId: invoice.id,
          share: share.amount,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    return created;
  } catch (error) {
    logger.error("fullyFundInvoice failed", {
      invoiceId: invoice.id,
      shareCount: shares.length,
      successCount: created.length,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ── Helper: locate a specific structured log call ──────────────────────────
//
// `fullyFundInvoice` emits its own "Invoice lifecycle state transition." log
// (published -> funded, reason "fully_funded") before settlement runs, so a
// bare `.find(([msg]) => msg === "...transition.")` would match the funding
// event instead of the settlement one. Match on the metadata too.

type LogCall = [string, Record<string, unknown>?];

function findLogCall(
  infoSpy: jest.SpyInstance,
  message: string,
  predicate: (meta: Record<string, unknown>) => boolean = () => true
): LogCall | undefined {
  return (infoSpy.mock.calls as LogCall[]).find(
    ([loggedMessage, meta]) =>
      loggedMessage === message && predicate((meta ?? {}) as Record<string, unknown>)
  );
}

function findSettlementTransitionLog(infoSpy: jest.SpyInstance): LogCall | undefined {
  return findLogCall(
    infoSpy,
    "Invoice lifecycle state transition.",
    (meta) => meta.reason === "admin_settled"
  );
}

function findSettlementCompletionLog(infoSpy: jest.SpyInstance): LogCall | undefined {
  return findLogCall(infoSpy, "Settlement flow completed.");
}

// ═══════════════════════════════════════════════════════════════════════════
// Settlement integration: rejecting settlement of non-fully-funded invoices
// ═══════════════════════════════════════════════════════════════════════════

describe("Settlement integration: rejecting settlement of non-fully-funded invoices (#88)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should reject settlement of a published invoice (no investments)", async () => {
    const invoice = createInvoice({ status: InvoiceStatus.PUBLISHED });
    const { dataSource } = createFakeDataSource(invoice);

    const settlementService = new SettlementService(dataSource);

    await expect(
      settlementService.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "6000.0000",
        actorWallet: "GADMIN",
      })
    ).rejects.toThrow(/Cannot settle an invoice with status published/);
  });

  it("should reject settlement of a partially funded invoice", async () => {
    const invoice = createInvoice({ status: InvoiceStatus.PUBLISHED });
    const { dataSource, investments } = createFakeDataSource(invoice);

    const investmentService = new InvestmentService(dataSource);
    const settlementService = new SettlementService(dataSource);

    // Fund only 50%
    const investorAId = crypto.randomUUID();
    const investmentA = await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorAId,
      investmentAmount: "3000.0000",
      investorWallet: "GINVESTORA",
    });

    // Mark confirmed but invoice is not fully funded
    const stored = investments.get(investmentA.id)!;
    stored.status = InvestmentStatus.CONFIRMED;
    investments.set(investmentA.id, stored);

    // Manually set status to PUBLISHED (not FUNDED) since only partial funding
    invoice.status = InvoiceStatus.PUBLISHED;

    await expect(
      settlementService.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "6000.0000",
        actorWallet: "GADMIN",
      })
    ).rejects.toThrow(/Cannot settle an invoice with status published/);
  });

  it("should succeed when invoice is fully funded", async () => {
    const invoice = createInvoice({ status: InvoiceStatus.PUBLISHED });
    const { dataSource, invoices, investments } = createFakeDataSource(invoice);

    const investmentService = new InvestmentService(dataSource);
    const settlementService = new SettlementService(dataSource);

    const investorAId = crypto.randomUUID();
    const investorBId = crypto.randomUUID();

    const investmentA = await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorAId,
      investmentAmount: "4000.0000",
      investorWallet: "GINVESTORA",
    });

    const investmentB = await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorBId,
      investmentAmount: "2000.0000",
      investorWallet: "GINVESTORB",
    });

    for (const investment of [investmentA, investmentB]) {
      const stored = investments.get(investment.id)!;
      stored.status = InvestmentStatus.CONFIRMED;
      investments.set(investment.id, stored);
    }

    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.FUNDED);

    const result = await settlementService.settleInvoice({
      invoiceId: invoice.id,
      proceeds: "6600.0000",
      actorWallet: "GADMIN",
    });

    expect(result.status).toBe(InvoiceStatus.SETTLED);
    expect(result.settlements).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Settlement integration: funding multiple investors then settling
// ═══════════════════════════════════════════════════════════════════════════

describe("Settlement integration: funding multiple investors then settling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("distributes proceeds pro-rata to each investor and marks the invoice settled", async () => {
    const invoice = createInvoice();
    const { dataSource, invoices, investments } = createFakeDataSource(invoice);

    const investmentService = new InvestmentService(dataSource);
    const settlementService = new SettlementService(dataSource);

    const investorAId = crypto.randomUUID();
    const investorBId = crypto.randomUUID();

    const investmentA = await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorAId,
      investmentAmount: "4000.0000",
      investorWallet: "GINVESTORA1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });

    const investmentB = await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorBId,
      investmentAmount: "2000.0000",
      investorWallet: "GINVESTORB1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });

    for (const investment of [investmentA, investmentB]) {
      const stored = investments.get(investment.id)!;
      stored.status = InvestmentStatus.CONFIRMED;
      investments.set(investment.id, stored);
    }

    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.FUNDED);

    const result = await settlementService.settleInvoice({
      invoiceId: invoice.id,
      proceeds: "6600.0000",
      actorWallet: "GADMINWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });

    const returnByInvestor = new Map(
      result.settlements.map((settlement) => [settlement.investorId, settlement.actualReturn])
    );

    expect(returnByInvestor.get(investorAId)).toBe("4400.0000");
    expect(returnByInvestor.get(investorBId)).toBe("2200.0000");

    expect(result.status).toBe(InvoiceStatus.SETTLED);
    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.SETTLED);

    const sumOfReturns = result.settlements.reduce(
      (sum, settlement) => sum + Number(settlement.actualReturn),
      0
    );
    expect(sumOfReturns).toBeCloseTo(6600, 4);
  });

  it("logs settlement completion with the correct invoice_id, total_proceeds, and investor_count", async () => {
    const infoSpy = jest.spyOn(logger, "info");

    const invoice = createInvoice();
    const { dataSource, investments } = createFakeDataSource(invoice);

    const investmentService = new InvestmentService(dataSource);
    const settlementService = new SettlementService(dataSource);

    const investorAId = crypto.randomUUID();
    const investorBId = crypto.randomUUID();

    const investmentA = await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorAId,
      investmentAmount: "4000.0000",
      investorWallet: "GINVESTORA1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });
    const investmentB = await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorBId,
      investmentAmount: "2000.0000",
      investorWallet: "GINVESTORB1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });

    for (const investment of [investmentA, investmentB]) {
      const stored = investments.get(investment.id)!;
      stored.status = InvestmentStatus.CONFIRMED;
      investments.set(investment.id, stored);
    }

    await settlementService.settleInvoice({
      invoiceId: invoice.id,
      proceeds: "6600.0000",
      actorWallet: "GADMINWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });

    const completionCall = infoSpy.mock.calls.find(
      ([message]) => message === "Settlement flow completed."
    );
    expect(completionCall).toBeDefined();

    const metadata = completionCall?.[1] as Record<string, unknown>;
    expect(metadata.invoice_id).toBe(invoice.id);
    expect(metadata.total_proceeds).toBe("6600.0000000");
    expect(metadata.investor_count).toBe(2);
    expect(metadata.settled_at).toEqual(expect.any(String));
  });

  it("does not log settlement completion when settlement fails", async () => {
    const infoSpy = jest.spyOn(logger, "info");

    // Invoice is still PUBLISHED (never funded), so settlement must fail
    // before any investor returns are recorded.
    const invoice = createInvoice({ status: InvoiceStatus.PUBLISHED });
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    await expect(
      settlementService.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "6600.0000",
        actorWallet: "GADMINWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      })
    ).rejects.toThrow();

    const completionCall = infoSpy.mock.calls.find(
      ([message]) => message === "Settlement flow completed."
    );
    expect(completionCall).toBeUndefined();
    expect(findSettlementCompletionLog(infoSpy)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Settlement integration: single investor 100% share
// ═══════════════════════════════════════════════════════════════════════════

describe("Settlement integration: single investor 100% share", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the full proceeds to the only investor", async () => {
    const invoice = createInvoice();
    const { dataSource, invoices, investments } = createFakeDataSource(invoice);

    const investmentService = new InvestmentService(dataSource);
    const settlementService = new SettlementService(dataSource);

    const investorId = crypto.randomUUID();
    const investment = await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId,
      investmentAmount: "6000.0000",
      investorWallet: "GINVESTOR100000000000000000000000000000000000000000000000",
    });

    const stored = investments.get(investment.id)!;
    stored.status = InvestmentStatus.CONFIRMED;
    investments.set(investment.id, stored);

    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.FUNDED);

    const result = await settlementService.settleInvoice({
      invoiceId: invoice.id,
      proceeds: "3300.0000",
      actorWallet: "GADMINWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });

    expect(result.status).toBe(InvoiceStatus.SETTLED);
    expect(result.settlements).toHaveLength(1);
    expect(result.settlements[0]?.actualReturn).toBe("3300.0000");
    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.SETTLED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Settlement integration: edge cases and error handling
// ═══════════════════════════════════════════════════════════════════════════

describe("Settlement integration: edge cases and input validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects settlement of a non-existent invoice with 404", async () => {
    const invoice = createInvoice();
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    await expect(
      settlementService.settleInvoice({
        invoiceId: crypto.randomUUID(),
        proceeds: "6000.0000",
        actorWallet: "GADMIN",
      })
    ).rejects.toThrow(/Invoice not found/);
  });

  it("rejects settlement with zero proceeds", async () => {
    const invoice = createInvoice({ status: InvoiceStatus.FUNDED });
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    await expect(
      settlementService.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "0.0000",
        actorWallet: "GADMIN",
      })
    ).rejects.toThrow(/Settlement proceeds must be greater than zero/);
  });

  it("rejects settlement with negative proceeds", async () => {
    const invoice = createInvoice({ status: InvoiceStatus.FUNDED });
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    await expect(
      settlementService.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "-100.0000",
        actorWallet: "GADMIN",
      })
    ).rejects.toThrow(/Settlement proceeds must be greater than zero/);
  });

  it("rejects settlement of an already settled invoice", async () => {
    const invoice = createInvoice({ status: InvoiceStatus.SETTLED });
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    await expect(
      settlementService.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "6000.0000",
        actorWallet: "GADMIN",
      })
    ).rejects.toThrow(/Cannot settle an invoice with status settled/);
  });

  it("rejects settlement of a cancelled invoice", async () => {
    const invoice = createInvoice({ status: InvoiceStatus.CANCELLED });
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    await expect(
      settlementService.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "6000.0000",
        actorWallet: "GADMIN",
      })
    ).rejects.toThrow(/Cannot settle an invoice with status cancelled/);
  });

  it("rejects settlement of a draft invoice", async () => {
    const invoice = createInvoice({ status: InvoiceStatus.DRAFT });
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    await expect(
      settlementService.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "6000.0000",
        actorWallet: "GADMIN",
      })
    ).rejects.toThrow(/Cannot settle an invoice with status draft/);
  });

  it("rejects settlement when invoice is funded but has no confirmed investments", async () => {
    const invoice = createInvoice({ status: InvoiceStatus.FUNDED });
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    await expect(
      settlementService.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "6000.0000",
        actorWallet: "GADMIN",
      })
    ).rejects.toThrow(/Invoice has no confirmed investments to settle/);
  });

  // These four cases previously drove the assertion through a
  // try/await/fail("...")/catch block. jest-circus (Jest's default test
  // runner since v27, and the only runner installed here — jest-jasmine2
  // is absent from node_modules) does not implement the global fail()
  // helper at runtime, even though @types/jest still declares its type for
  // backward compatibility. Had settleInvoice ever regressed to resolve
  // instead of reject here, that fail() call would have thrown
  // "fail is not defined" instead of a clear assertion failure, masking
  // exactly the regression these tests exist to catch. `.rejects` reports
  // a clean, standard Jest failure if the promise unexpectedly resolves,
  // with no dependency on that helper.
  it("throws ServiceError with INVALID_PROCEEDS code for zero proceeds", async () => {
    const invoice = createInvoice({ status: InvoiceStatus.FUNDED });
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    const settlement = settlementService.settleInvoice({
      invoiceId: invoice.id,
      proceeds: "0.0000",
      actorWallet: "GADMIN",
    });

    await expect(settlement).rejects.toBeInstanceOf(ServiceError);
    await expect(settlement).rejects.toMatchObject({ code: "INVALID_PROCEEDS", statusCode: 400 });
  });

  it("throws ServiceError with INVOICE_NOT_FOUND code for missing invoice", async () => {
    const invoice = createInvoice();
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    const settlement = settlementService.settleInvoice({
      invoiceId: crypto.randomUUID(),
      proceeds: "6000.0000",
      actorWallet: "GADMIN",
    });

    await expect(settlement).rejects.toBeInstanceOf(ServiceError);
    await expect(settlement).rejects.toMatchObject({ code: "INVOICE_NOT_FOUND", statusCode: 404 });
  });

  it("throws ServiceError with INVALID_INVOICE_STATUS code for wrong status", async () => {
    const invoice = createInvoice({ status: InvoiceStatus.PUBLISHED });
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    const settlement = settlementService.settleInvoice({
      invoiceId: invoice.id,
      proceeds: "6000.0000",
      actorWallet: "GADMIN",
    });

    await expect(settlement).rejects.toBeInstanceOf(ServiceError);
    await expect(settlement).rejects.toMatchObject({ code: "INVALID_INVOICE_STATUS" });
  });

  it("throws ServiceError with NO_CONFIRMED_INVESTMENTS code when no investments confirmed", async () => {
    const invoice = createInvoice({ status: InvoiceStatus.FUNDED });
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    const settlement = settlementService.settleInvoice({
      invoiceId: invoice.id,
      proceeds: "6000.0000",
      actorWallet: "GADMIN",
    });

    await expect(settlement).rejects.toBeInstanceOf(ServiceError);
    await expect(settlement).rejects.toMatchObject({ code: "NO_CONFIRMED_INVESTMENTS" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Settlement integration: pro-rata distribution edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Settlement integration: pro-rata distribution edge cases", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("handles uneven three-way split correctly", async () => {
    const invoice = createInvoice({ amount: "10000.0000", netAmount: "10000.0000" });
    const { dataSource, invoices, investments } = createFakeDataSource(invoice);

    const shares = [
      { amount: "5000.0000", wallet: "GINVESTOR1" + "A".repeat(54) },
      { amount: "3000.0000", wallet: "GINVESTOR2" + "B".repeat(54) },
      { amount: "2000.0000", wallet: "GINVESTOR3" + "C".repeat(54) },
    ];

    const createdInvestments = await fullyFundInvoice(dataSource, investments, invoice, shares);
    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.FUNDED);

    const settlementService = new SettlementService(dataSource);
    const result = await settlementService.settleInvoice({
      invoiceId: invoice.id,
      proceeds: "10000.0000",
      actorWallet: "GADMINWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });

    expect(result.status).toBe(InvoiceStatus.SETTLED);
    expect(result.settlements).toHaveLength(3);

    const returnByInvestor = new Map(
      result.settlements.map((s) => [s.investorId, Number(s.actualReturn)])
    );

    // 50% -> 5000, 30% -> 3000, 20% -> 2000
    const investorIds = createdInvestments.map((inv) => inv.investorId);
    expect(returnByInvestor.get(investorIds[0])).toBe(5000);
    expect(returnByInvestor.get(investorIds[1])).toBe(3000);
    expect(returnByInvestor.get(investorIds[2])).toBe(2000);

    const totalReturn = [...returnByInvestor.values()].reduce((a, b) => a + b, 0);
    expect(totalReturn).toBeCloseTo(10000, 4);
  });

  it("distributes correctly when proceeds exceed the funded amount", async () => {
    const invoice = createInvoice({ amount: "6000.0000", netAmount: "6000.0000" });
    const { dataSource, invoices, investments } = createFakeDataSource(invoice);

    const shares = [
      { amount: "4000.0000", wallet: "GINVESTOR_A" + "X".repeat(53) },
      { amount: "2000.0000", wallet: "GINVESTOR_B" + "Y".repeat(53) },
    ];

    const createdInvestments = await fullyFundInvoice(dataSource, investments, invoice, shares);
    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.FUNDED);

    const settlementService = new SettlementService(dataSource);
    const result = await settlementService.settleInvoice({
      invoiceId: invoice.id,
      proceeds: "9000.0000",
      actorWallet: "GADMINWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });

    const returnByInvestor = new Map(
      result.settlements.map((s) => [s.investorId, Number(s.actualReturn)])
    );

    // 4000/6000 * 9000 = 6000, 2000/6000 * 9000 = 3000
    const investorIds = createdInvestments.map((inv) => inv.investorId);
    expect(returnByInvestor.get(investorIds[0])).toBe(6000);
    expect(returnByInvestor.get(investorIds[1])).toBe(3000);

    const totalReturn = [...returnByInvestor.values()].reduce((a, b) => a + b, 0);
    expect(totalReturn).toBeCloseTo(9000, 4);
  });

  it("distributes correctly when proceeds are less than the funded amount", async () => {
    const invoice = createInvoice({ amount: "6000.0000", netAmount: "6000.0000" });
    const { dataSource, invoices, investments } = createFakeDataSource(invoice);

    const shares = [
      { amount: "3000.0000", wallet: "GINVESTOR_LOW1" + "A".repeat(50) },
      { amount: "3000.0000", wallet: "GINVESTOR_LOW2" + "B".repeat(50) },
    ];

    const createdInvestments = await fullyFundInvoice(dataSource, investments, invoice, shares);
    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.FUNDED);

    const settlementService = new SettlementService(dataSource);
    const result = await settlementService.settleInvoice({
      invoiceId: invoice.id,
      proceeds: "2000.0000",
      actorWallet: "GADMINWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });

    const returnByInvestor = new Map(
      result.settlements.map((s) => [s.investorId, Number(s.actualReturn)])
    );

    // Equal shares: each gets 1000
    const investorIds = createdInvestments.map((inv) => inv.investorId);
    expect(returnByInvestor.get(investorIds[0])).toBe(1000);
    expect(returnByInvestor.get(investorIds[1])).toBe(1000);
  });

  it("preserves settlement result structure with all required fields", async () => {
    const invoice = createInvoice();
    const { dataSource, invoices, investments } = createFakeDataSource(invoice);

    const shares = [{ amount: "6000.0000", wallet: "GINVESTOR_FULL" + "Z".repeat(50) }];

    const createdInvestments = await fullyFundInvoice(dataSource, investments, invoice, shares);
    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.FUNDED);

    const settlementService = new SettlementService(dataSource);
    const result = await settlementService.settleInvoice({
      invoiceId: invoice.id,
      proceeds: "7200.0000",
      actorWallet: "GADMINWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });

    expect(result).toHaveProperty("invoiceId", invoice.id);
    expect(result).toHaveProperty("status", InvoiceStatus.SETTLED);
    expect(result).toHaveProperty("proceeds", "7200.0000");
    expect(result).toHaveProperty("settlements");
    expect(Array.isArray(result.settlements)).toBe(true);

    const settlement = result.settlements[0];
    expect(settlement).toHaveProperty("investmentId");
    expect(settlement).toHaveProperty("investorId");
    expect(settlement).toHaveProperty("investmentAmount", "6000.0000");
    expect(settlement).toHaveProperty("actualReturn", "7200.0000");
  });

  it("logs lifecycle transition from funded to settled on success", async () => {
    const infoSpy = jest.spyOn(logger, "info");

    const invoice = createInvoice();
    const { dataSource, investments } = createFakeDataSource(invoice);

    await fullyFundInvoice(dataSource, investments, invoice, [
      { amount: "6000.0000", wallet: "GINVESTOR_LOG" + "L".repeat(50) },
    ]);

    const settlementService = new SettlementService(dataSource);
    await settlementService.settleInvoice({
      invoiceId: invoice.id,
      proceeds: "6000.0000",
      actorWallet: "GADMINWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });

    const lifecycleCall = findSettlementTransitionLog(infoSpy);
    expect(lifecycleCall).toBeDefined();

    const metadata = lifecycleCall?.[1] as Record<string, unknown>;
    expect(metadata.invoice_id).toBe(invoice.id);
    expect(metadata.from_state).toBe(InvoiceStatus.FUNDED);
    expect(metadata.to_state).toBe(InvoiceStatus.SETTLED);
    expect(metadata.reason).toBe("admin_settled");
    expect(metadata.transitioned_at).toEqual(expect.any(String));
  });

  it("does not log lifecycle transition when settlement fails due to wrong status", async () => {
    const infoSpy = jest.spyOn(logger, "info");

    const invoice = createInvoice({ status: InvoiceStatus.PUBLISHED });
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    await expect(
      settlementService.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "6000.0000",
        actorWallet: "GADMIN",
      })
    ).rejects.toThrow();

    expect(findSettlementTransitionLog(infoSpy)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Settlement integration: logging verification
// ═══════════════════════════════════════════════════════════════════════════

describe("Settlement integration: logging verification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("logs both lifecycle transition and settlement completion on successful settlement", async () => {
    const infoSpy = jest.spyOn(logger, "info");

    const invoice = createInvoice();
    const { dataSource, investments } = createFakeDataSource(invoice);

    await fullyFundInvoice(dataSource, investments, invoice, [
      { amount: "4000.0000", wallet: "GINVESTOR_LOG1" + "M".repeat(49) },
      { amount: "2000.0000", wallet: "GINVESTOR_LOG2" + "N".repeat(49) },
    ]);

    const settlementService = new SettlementService(dataSource);
    await settlementService.settleInvoice({
      invoiceId: invoice.id,
      proceeds: "6600.0000",
      actorWallet: "GADMINWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });

    const lifecycleCall = findSettlementTransitionLog(infoSpy);
    const completionCall = findSettlementCompletionLog(infoSpy);

    expect(lifecycleCall).toBeDefined();
    expect(completionCall).toBeDefined();

    const lifecycleMeta = lifecycleCall?.[1] as Record<string, unknown>;
    expect(lifecycleMeta.from_state).toBe(InvoiceStatus.FUNDED);
    expect(lifecycleMeta.to_state).toBe(InvoiceStatus.SETTLED);

    const completionMeta = completionCall?.[1] as Record<string, unknown>;
    expect(completionMeta.investor_count).toBe(2);
    expect(completionMeta.total_proceeds).toBe("6600.0000000");
  });

  it("does not log settlement-related info logs when invoice not found", async () => {
    const infoSpy = jest.spyOn(logger, "info");

    const invoice = createInvoice();
    const { dataSource } = createFakeDataSource(invoice);
    const settlementService = new SettlementService(dataSource);

    await expect(
      settlementService.settleInvoice({
        invoiceId: crypto.randomUUID(),
        proceeds: "6000.0000",
        actorWallet: "GADMIN",
      })
    ).rejects.toThrow(/Invoice not found/);

    expect(findSettlementTransitionLog(infoSpy)).toBeUndefined();
    expect(findSettlementCompletionLog(infoSpy)).toBeUndefined();
  });
});
