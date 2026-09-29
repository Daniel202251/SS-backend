import crypto from "crypto";
import { DataSource } from "typeorm";
import { Decimal } from "decimal.js";
import { InvestmentService } from "../../src/services/investment.service";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { InvestorAcknowledgement } from "../../src/models/InvestorAcknowledgement.model";
import { InvoiceStatus, InvestmentStatus } from "../../src/types/enums";

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
    // Issue #473 â€” the accreditation gate looks the investor's terms
    // acknowledgement up before creating the investment.
    getRepository: (entity: unknown) =>
      entity === InvestorAcknowledgement
        ? { findOne: async () => ({ acknowledgedAt: new Date() }) }
        : manager,
  } as unknown as DataSource;

  return { dataSource, invoices, investments };
}

function createInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: crypto.randomUUID(),
    sellerId: crypto.randomUUID(),
    invoiceNumber: "INV-FRACTIONAL-001",
    customerName: "Customer A",
    amount: "10000.0000",
    discountRate: "0.00",
    netAmount: "10000.0000",
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

describe("Fractional investment integration: splitting funded amount across multiple investors", () => {
  it("transitions to funded after the third commitment with correct, rounding-free share percentages", async () => {
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
    const investorC = {
      id: crypto.randomUUID(),
      wallet: "GINVESTORC1234567890ABCDEFGHIJKLMNOPQRSTUVWXY",
    };

    const investmentA = await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorA.id,
      investmentAmount: "4000.0000",
      investorWallet: investorA.wallet,
    });
    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.PUBLISHED);

    const investmentB = await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorB.id,
      investmentAmount: "3000.0000",
      investorWallet: investorB.wallet,
    });
    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.PUBLISHED);

    const investmentC = await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorC.id,
      investmentAmount: "3000.0000",
      investorWallet: investorC.wallet,
    });

    // Invoice transitions to FUNDED only after the third commitment reaches face value.
    expect(invoices.get(invoice.id)?.status).toBe(InvoiceStatus.FUNDED);

    const allInvestments = [investmentA, investmentB, investmentC];
    expect(investments.size).toBe(3);

    const totalFunded = allInvestments.reduce(
      (sum, investment) => sum.plus(new Decimal(investment.investmentAmount)),
      new Decimal(0)
    );
    expect(totalFunded.toFixed(4)).toBe("10000.0000");

    const sharePercentages = allInvestments.map((investment) =>
      new Decimal(investment.investmentAmount).dividedBy(totalFunded).times(100)
    );

    expect(sharePercentages[0].toFixed(2)).toBe("40.00");
    expect(sharePercentages[1].toFixed(2)).toBe("30.00");
    expect(sharePercentages[2].toFixed(2)).toBe("30.00");

    const sumOfShares = sharePercentages.reduce((sum, share) => sum.plus(share), new Decimal(0));
    expect(sumOfShares.toFixed(10)).toBe("100.0000000000");
  });
});
