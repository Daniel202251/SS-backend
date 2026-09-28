import crypto from "crypto";
import { DataSource } from "typeorm";
import { Decimal } from "decimal.js";
import { InvestmentService } from "../../src/services/investment.service";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";

/**
 * Minimal in-memory TypeORM stand-in so this test exercises the real
 * InvestmentService funding logic end to end without a live database.
 */
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

function createFakeDataSource(invoice: Invoice) {
  const invoices = new Map<string, Invoice>([[invoice.id, invoice]]);
  const investments = new Map<string, Investment>();

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
        return { id: crypto.randomUUID(), status: InvestmentStatus.PENDING, ...data } as Investment;
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
    getRepository: () => ({
      findOne: jest.fn().mockResolvedValue({ walletAddress: "test", termsVersion: "1", acknowledgedAt: new Date() }),
      find: jest.fn().mockResolvedValue([]),
    }),
  } as unknown as DataSource;

  return { dataSource, invoices, investments };
}

function createInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: crypto.randomUUID(),
    sellerId: crypto.randomUUID(),
    invoiceNumber: "INV-OVERFLOW-001",
    customerName: "Customer A",
    amount: "5000.0000",
    discountRate: "0.00",
    netAmount: "5000.0000",
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

describe("Investment overflow integration: rejecting commitments exceeding invoice face value", () => {
  it("rejects a second commitment that would push total funded above face value, then accepts an exact completion", async () => {
    const invoice = createInvoice();
    const { dataSource, invoices, investments } = createFakeDataSource(invoice);
    const investmentService = new InvestmentService(dataSource);

    const investorA = {
      id: crypto.randomUUID(),
      wallet: "GINVESTORA1234567890ABCDEFGHIJKLMNOPQRSTUVWXY",
    };
    const investorB = {
      id: crypto.randomUUID(),
      wallet: "GINVESTORB1234567890ABCDEFGHIJKLMNOPQRSTUVWXY",
    };

    await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorA.id,
      investmentAmount: "4000.0000",
      investorWallet: investorA.wallet,
    });
    expect(investments.size).toBe(1);

    await expect(
      investmentService.createInvestment({
        invoiceId: invoice.id,
        investorId: investorB.id,
        investmentAmount: "2000.0000",
        investorWallet: investorB.wallet,
      })
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_CAPACITY",
      statusCode: 400,
    });

    // Total funded remains unchanged after the rejected commitment.
    expect(investments.size).toBe(1);
    const totalFundedAfterRejection = [...investments.values()].reduce(
      (sum, investment) => sum.plus(new Decimal(investment.investmentAmount)),
      new Decimal(0)
    );
    expect(totalFundedAfterRejection.toFixed(4)).toBe("4000.0000");
    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.PUBLISHED);

    // A commitment of exactly 1000 completes the invoice and is accepted.
    const completingInvestment = await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorB.id,
      investmentAmount: "1000.0000",
      investorWallet: investorB.wallet,
    });
    expect(completingInvestment).toBeDefined();
    expect(investments.size).toBe(2);
    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.FUNDED);
  });
});
