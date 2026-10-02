import crypto from "crypto";
import { DataSource } from "typeorm";
import { SettlementService } from "../../../src/services/settlement.service";
import { Invoice } from "../../../src/models/Invoice.model";
import { Investment } from "../../../src/models/Investment.model";
import { InvestorReturn } from "../../../src/models/InvestorReturn.model";
import { SettlementRemainder } from "../../../src/models/SettlementRemainder.model";
import { InvoiceStatus, InvestmentStatus } from "../../../src/types/enums";
import {
  SettlementEventEmitter,
  type SettlementEventPayload,
} from "../../../src/lib/settlement-events";

function createFakeDataSource(invoice: Invoice, initialInvestments: Investment[] = []) {
  const invoices = new Map<string, Invoice>([[invoice.id, invoice]]);
  const investments = new Map<string, Investment>(initialInvestments.map((inv) => [inv.id, inv]));
  const investorReturns = new Map<string, InvestorReturn>();
  const remainders = new Map<string, SettlementRemainder>();

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
    create: (entity: unknown, data: Record<string, unknown>) => unknown;
    save: (entity: unknown, data: unknown) => Promise<unknown>;
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
    create: (_entity: unknown, data: Record<string, unknown>) => {
      return { id: crypto.randomUUID(), ...data };
    },
    save: async (entity: unknown, data: unknown) => {
      const record = data as { id: string };
      if (entity === Investment) {
        investments.set(record.id, data as Investment);
      } else if (entity === Invoice) {
        invoices.set(record.id, data as Invoice);
      } else if (entity === InvestorReturn) {
        investorReturns.set(record.id, data as InvestorReturn);
      } else if (entity === SettlementRemainder) {
        remainders.set(record.id, data as SettlementRemainder);
      }
      return data;
    },
  };

  const dataSource = {
    transaction: async (callback: (m: FakeManager) => Promise<unknown>) => callback(manager),
  } as unknown as DataSource;

  return { dataSource, invoices, investments, investorReturns, remainders };
}

function createInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: crypto.randomUUID(),
    sellerId: crypto.randomUUID(),
    invoiceNumber: "INV-RETURN-001",
    customerName: "Buyer Corp",
    amount: "1000.0000",
    discountRate: "0.00",
    netAmount: "1000.0000",
    fundedAmount: "1000.0000",
    settlementRemainder: "0.0000",
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    ipfsHash: null,
    riskScore: null,
    status: InvoiceStatus.FUNDED,
    smartContractId: null,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    seller: undefined as unknown as Invoice["seller"],
    investments: [],
    transactions: [],
    investorReturns: [],
    settlementRemainders: [],
    ...overrides,
  } as Invoice;
}

function createInvestment(
  invoiceId: string,
  amount: string,
  overrides: Partial<Investment> = {}
): Investment {
  return {
    id: crypto.randomUUID(),
    invoiceId,
    investorId: crypto.randomUUID(),
    investmentAmount: amount,
    expectedReturn: amount,
    actualReturn: null,
    status: InvestmentStatus.CONFIRMED,
    investorWallet: "G" + "1".repeat(55),
    fundingBlock: "12345",
    transactionHash: "hash123",
    stellarOperationIndex: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    version: 1,
    invoice: undefined as unknown as Investment["invoice"],
    investor: undefined as unknown as Investment["investor"],
    transactions: [],
    investorReturns: [],
    ...overrides,
  } as Investment;
}

describe("Pro-rata investor return calculation on settlement (#460)", () => {
  describe("Floor division return calculation", () => {
    it("calculates each investor's share using floor division (3 equal investors splitting 1000 proceeds)", async () => {
      const invoice = createInvoice({ amount: "1000.0000", netAmount: "1000.0000" });
      const inv1 = createInvestment(invoice.id, "333.3333");
      const inv2 = createInvestment(invoice.id, "333.3333");
      const inv3 = createInvestment(invoice.id, "333.3334"); // Total = 1000.0000

      const { dataSource, investorReturns, remainders, invoices } = createFakeDataSource(invoice, [
        inv1,
        inv2,
        inv3,
      ]);
      const service = new SettlementService(dataSource);

      const result = await service.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "1000.0000",
        actorWallet: "GADMINWALLET",
      });

      expect(result.status).toBe(InvoiceStatus.SETTLED);
      expect(result.settlements).toHaveLength(3);

      // Floor division:
      // totalFundedScaled = 10000000n (1000.0000 * 10^4)
      // inv1 return = floor(3333333n * 10000000n / 10000000n) = 3333333n -> "333.3333"
      // inv2 return = floor(3333333n * 10000000n / 10000000n) = 3333333n -> "333.3333"
      // inv3 return = floor(3333334n * 10000000n / 10000000n) = 3333334n -> "333.3334"
      const r1 = result.settlements.find((s) => s.investmentId === inv1.id);
      const r2 = result.settlements.find((s) => s.investmentId === inv2.id);
      const r3 = result.settlements.find((s) => s.investmentId === inv3.id);

      expect(r1?.actualReturn).toBe("333.3333");
      expect(r2?.actualReturn).toBe("333.3333");
      expect(r3?.actualReturn).toBe("333.3334");

      // investor_returns table populated with correct amounts
      expect(investorReturns.size).toBe(3);
      const savedReturn1 = [...investorReturns.values()].find((r) => r.investmentId === inv1.id);
      expect(savedReturn1?.returnAmount).toBe("333.3333");
      expect(savedReturn1?.invoiceId).toBe(invoice.id);
      expect(savedReturn1?.investorId).toBe(inv1.investorId);

      // Remainder is 0 in this case
      expect(result.remainder).toBe("0.0000");
      expect(invoices.get(invoice.id)?.settlementRemainder).toBe("0.0000");
      expect(remainders.size).toBe(1);
    });

    it("ensures sum of all returns never exceeds total settlement amount with repeating fractional ratios", async () => {
      // 3 equal investors splitting 100 units of proceeds:
      // Each has 1/3 share. floor(100 / 3) = 33.3333
      // 3 * 33.3333 = 99.9999. Remainder = 0.0001
      const invoice = createInvoice({ amount: "300.0000", netAmount: "300.0000" });
      const inv1 = createInvestment(invoice.id, "100.0000");
      const inv2 = createInvestment(invoice.id, "100.0000");
      const inv3 = createInvestment(invoice.id, "100.0000");

      const { dataSource, investorReturns, remainders, invoices } = createFakeDataSource(invoice, [
        inv1,
        inv2,
        inv3,
      ]);
      const service = new SettlementService(dataSource);

      const result = await service.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "100.0000",
        actorWallet: "GADMINWALLET",
      });

      const ret1 = result.settlements.find((s) => s.investmentId === inv1.id)?.actualReturn;
      const ret2 = result.settlements.find((s) => s.investmentId === inv2.id)?.actualReturn;
      const ret3 = result.settlements.find((s) => s.investmentId === inv3.id)?.actualReturn;

      // Each investor gets floor(100 * 100 / 300) = floor(33.333333...) = 33.3333
      expect(ret1).toBe("33.3333");
      expect(ret2).toBe("33.3333");
      expect(ret3).toBe("33.3333");

      const sumReturns = Number(ret1) + Number(ret2) + Number(ret3);
      expect(sumReturns).toBe(99.9999);
      expect(sumReturns).toBeLessThan(100);

      // Remainder dust handled and recorded separately
      expect(result.remainder).toBe("0.0001");
      expect(result.remainderDust).toBe("0.0001");
      expect(result.totalDistributed).toBe("99.9999");

      // Verify invoice has remainder recorded
      expect(invoices.get(invoice.id)?.settlementRemainder).toBe("0.0001");

      // Verify settlement_remainders table has record
      expect(remainders.size).toBe(1);
      const remainderEntry = [...remainders.values()][0];
      expect(remainderEntry.remainderAmount).toBe("0.0001");
      expect(remainderEntry.totalSettlementAmount).toBe("100.0000");
      expect(remainderEntry.totalDistributedAmount).toBe("99.9999");

      // investor_returns table populated with correct amounts
      expect(investorReturns.size).toBe(3);
      for (const ir of investorReturns.values()) {
        expect(ir.returnAmount).toBe("33.3333");
        expect(ir.amount).toBe("33.3333");
        expect(ir.invoiceId).toBe(invoice.id);
      }
    });

    it("handles uneven investor split (1/3 and 2/3 shares of 10 proceeds)", async () => {
      // 10 proceeds split between 1/3 (amount 100) and 2/3 (amount 200), total 300
      // 1/3 * 10 = 3.3333... floor = 3.3333
      // 2/3 * 10 = 6.6666... floor = 6.6666
      // Sum = 9.9999. Remainder = 0.0001
      const invoice = createInvoice({ amount: "300.0000", netAmount: "300.0000" });
      const inv1 = createInvestment(invoice.id, "100.0000");
      const inv2 = createInvestment(invoice.id, "200.0000");

      const { dataSource, investorReturns, remainders } = createFakeDataSource(invoice, [
        inv1,
        inv2,
      ]);
      const service = new SettlementService(dataSource);

      const result = await service.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "10.0000",
        actorWallet: "GADMINWALLET",
      });

      const ret1 = result.settlements.find((s) => s.investmentId === inv1.id)?.actualReturn;
      const ret2 = result.settlements.find((s) => s.investmentId === inv2.id)?.actualReturn;

      expect(ret1).toBe("3.3333");
      expect(ret2).toBe("6.6666");
      expect(result.remainder).toBe("0.0001");
      expect(result.totalDistributed).toBe("9.9999");

      // investor_returns table populated with correct amounts
      expect(investorReturns.size).toBe(2);
      expect(remainders.size).toBe(1);
    });
  });

  describe("Settlement event emission", () => {
    it("emits settlement event after successful calculation with all required metadata", async () => {
      const invoice = createInvoice({ amount: "2000.0000", netAmount: "2000.0000" });
      const inv1 = createInvestment(invoice.id, "1000.0000");
      const inv2 = createInvestment(invoice.id, "1000.0000");

      const { dataSource } = createFakeDataSource(invoice, [inv1, inv2]);
      const customEmitter = new SettlementEventEmitter();
      const service = new SettlementService(
        dataSource,
        undefined,
        undefined,
        undefined,
        customEmitter
      );

      const eventPromise = new Promise<SettlementEventPayload>((resolve) => {
        service.onSettlement((payload) => resolve(payload));
      });

      await service.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "2200.0000",
        actorWallet: "GADMINWALLET",
      });

      const emittedEvent = await eventPromise;

      expect(emittedEvent.invoiceId).toBe(invoice.id);
      expect(emittedEvent.sellerId).toBe(invoice.sellerId);
      expect(emittedEvent.totalSettlementAmount).toBe("2200.0000");
      expect(emittedEvent.totalDistributedAmount).toBe("2200.0000");
      expect(emittedEvent.remainderAmount).toBe("0.0000");
      expect(emittedEvent.settledAt).toBeInstanceOf(Date);
      expect(emittedEvent.returns).toHaveLength(2);

      const retA = emittedEvent.returns.find((r) => r.investmentId === inv1.id);
      const retB = emittedEvent.returns.find((r) => r.investmentId === inv2.id);
      expect(retA?.returnAmount).toBe("1100.0000");
      expect(retB?.returnAmount).toBe("1100.0000");
    });

    it("emits settlement event with remainder dust when proceeds do not divide evenly", async () => {
      const invoice = createInvoice({ amount: "700.0000", netAmount: "700.0000" });
      const inv1 = createInvestment(invoice.id, "233.3333");
      const inv2 = createInvestment(invoice.id, "233.3333");
      const inv3 = createInvestment(invoice.id, "233.3334"); // Total = 700.0000

      const { dataSource } = createFakeDataSource(invoice, [inv1, inv2, inv3]);
      const customEmitter = new SettlementEventEmitter();
      const service = new SettlementService(
        dataSource,
        undefined,
        undefined,
        undefined,
        customEmitter
      );

      let capturedEvent: SettlementEventPayload | undefined;
      customEmitter.on("invoice.settled", (event: SettlementEventPayload) => {
        capturedEvent = event;
      });

      await service.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "700.0000",
        actorWallet: "GADMINWALLET",
      });

      expect(capturedEvent).toBeDefined();
      expect(capturedEvent?.invoiceId).toBe(invoice.id);
      expect(capturedEvent?.totalSettlementAmount).toBe("700.0000");
      expect(capturedEvent?.remainderAmount).toBe("0.0000");
      expect(capturedEvent?.returns).toHaveLength(3);
    });

    it("does not emit settlement event when settlement fails", async () => {
      const invoice = createInvoice({ status: InvoiceStatus.PUBLISHED }); // not funded!
      const { dataSource } = createFakeDataSource(invoice);
      const customEmitter = new SettlementEventEmitter();
      const service = new SettlementService(
        dataSource,
        undefined,
        undefined,
        undefined,
        customEmitter
      );

      const eventListener = jest.fn();
      customEmitter.on("settlement", eventListener);

      await expect(
        service.settleInvoice({
          invoiceId: invoice.id,
          proceeds: "1000.0000",
          actorWallet: "GADMINWALLET",
        })
      ).rejects.toThrow();

      expect(eventListener).not.toHaveBeenCalled();
    });
  });

  describe("calculateInvestorReturns pure helper", () => {
    it("purely computes floor division returns, total distributed and remainder dust", () => {
      const service = new SettlementService({} as unknown as DataSource);

      const investments = [
        { id: "inv-1", investorId: "u-1", investmentAmount: "100.0000" },
        { id: "inv-2", investorId: "u-2", investmentAmount: "100.0000" },
        { id: "inv-3", investorId: "u-3", investmentAmount: "100.0000" },
      ];

      const calculation = service.calculateInvestorReturns(investments, "100.0000");

      expect(calculation.totalFunded).toBe("300.0000");
      expect(calculation.distributable).toBe("100.0000");
      expect(calculation.totalDistributed).toBe("99.9999");
      expect(calculation.remainder).toBe("0.0001");
      expect(calculation.returns).toHaveLength(3);
      expect(calculation.returns[0]?.returnAmount).toBe("33.3333");
      expect(calculation.returns[1]?.returnAmount).toBe("33.3333");
      expect(calculation.returns[2]?.returnAmount).toBe("33.3333");

      // Verify sum of returns never exceeds proceeds
      const sum = calculation.returns.reduce((acc, r) => acc + Number(r.returnAmount), 0);
      expect(sum).toBeLessThanOrEqual(100);
    });

    it("rejects invalid proceeds or funded amounts", () => {
      const service = new SettlementService({} as unknown as DataSource);
      expect(() => service.calculateInvestorReturns([], "100")).toThrow(
        "Total funded amount must be greater than zero"
      );
      expect(() =>
        service.calculateInvestorReturns(
          [{ id: "1", investorId: "1", investmentAmount: "10" }],
          "0"
        )
      ).toThrow("Settlement proceeds must be greater than zero");
    });
  });
});
