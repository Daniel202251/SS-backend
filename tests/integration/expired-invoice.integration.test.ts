import crypto from "crypto";
import { DataSource, EntityManager } from "typeorm";
import { InvestmentService } from "../../src/services/investment.service";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { InvestorAcknowledgement } from "../../src/models/InvestorAcknowledgement.model";
import { InvoiceStatus, InvestmentStatus } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";

function createFakeDataSource(invoice: Invoice) {
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
    find: async () => [] as Investment[],
    create: (_entity: unknown, data: Partial<Investment>) =>
      ({ id: crypto.randomUUID(), status: InvestmentStatus.PENDING, ...data }) as Investment,
    save: async (_entity: unknown, data: Investment | Invoice) => {
      if ((data as Investment).investmentAmount !== undefined) {
        investments.set((data as Investment).id, data as Investment);
      }
      return data;
    },
  };

  const dataSource = {
    transaction: (callback: (em: typeof manager) => Promise<unknown>) => callback(manager),
    // Issue #473 â€” the accreditation gate looks the investor's terms
    // acknowledgement up before creating the investment.
    getRepository: (entity: unknown) =>
      entity === InvestorAcknowledgement
        ? { findOne: async () => ({ acknowledgedAt: new Date() }) }
        : manager,
  } as unknown as DataSource;

  return { dataSource, investments };
}

function createInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: crypto.randomUUID(),
    sellerId: crypto.randomUUID(),
    invoiceNumber: "INV-EXPIRED-001",
    customerName: "Expiry Test Customer",
    amount: "1000.0000",
    discountRate: "0.00",
    netAmount: "1000.0000",
    dueDate: new Date(Date.now() - 24 * 60 * 60 * 1000), // yesterday â€” expired
    ipfsHash: "QmExpiredHash",
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

const INVESTOR_WALLET = "GINVESTOREXPIRY1234567890ABCDEFGHIJKLMNOPQRSTUVW";

describe("Expired invoice rejects new investment commitments (issue #109)", () => {
  it("throws invoice_expired with status 422 when dueDate is in the past", async () => {
    const invoice = createInvoice();
    const { dataSource } = createFakeDataSource(invoice);
    const investmentService = new InvestmentService(dataSource);

    await expect(
      investmentService.createInvestment({
        invoiceId: invoice.id,
        investorId: crypto.randomUUID(),
        investmentAmount: "100.0000",
        investorWallet: INVESTOR_WALLET,
      })
    ).rejects.toMatchObject({
      code: "invoice_expired",
      statusCode: 422,
    });
  });

  it("creates no investment record when the invoice is expired", async () => {
    const invoice = createInvoice();
    const { dataSource, investments } = createFakeDataSource(invoice);
    const investmentService = new InvestmentService(dataSource);

    await expect(
      investmentService.createInvestment({
        invoiceId: invoice.id,
        investorId: crypto.randomUUID(),
        investmentAmount: "100.0000",
        investorWallet: INVESTOR_WALLET,
      })
    ).rejects.toBeInstanceOf(ServiceError);

    expect(investments.size).toBe(0);
  });

  it("leaves the invoice status unchanged after rejection", async () => {
    const invoice = createInvoice();
    const { dataSource } = createFakeDataSource(invoice);
    const investmentService = new InvestmentService(dataSource);

    try {
      await investmentService.createInvestment({
        invoiceId: invoice.id,
        investorId: crypto.randomUUID(),
        investmentAmount: "100.0000",
        investorWallet: INVESTOR_WALLET,
      });
    } catch {
      // expected
    }

    expect(invoice.status).toBe(InvoiceStatus.PUBLISHED);
  });

  it("allows investment on a published invoice with a future due date", async () => {
    const futureInvoice = createInvoice({
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const { dataSource, investments } = createFakeDataSource(futureInvoice);
    const investmentService = new InvestmentService(dataSource);

    await expect(
      investmentService.createInvestment({
        invoiceId: futureInvoice.id,
        investorId: crypto.randomUUID(),
        investmentAmount: "100.0000",
        investorWallet: INVESTOR_WALLET,
      })
    ).resolves.toMatchObject({ status: InvestmentStatus.PENDING });

    expect(investments.size).toBe(1);
  });
});
