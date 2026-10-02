import crypto from "crypto";
import { Investment } from "../src/models/Investment.model";
import { Transaction } from "../src/models/Transaction.model";
import { VerifyPaymentService } from "../src/services/stellar/verify-payment.service";
import { InvestmentStatus, TransactionStatus, TransactionType } from "../src/types/enums";

interface MockResponseInit {
  ok: boolean;
  status: number;
  body: unknown;
}

function createMockResponse({ ok, status, body }: MockResponseInit): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function createInvestment(overrides: Partial<Investment> = {}): Investment {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    invoiceId: overrides.invoiceId ?? crypto.randomUUID(),
    investorId: overrides.investorId ?? crypto.randomUUID(),
    investmentAmount: overrides.investmentAmount ?? "100.0000",
    expectedReturn: overrides.expectedReturn ?? "105.0000",
    actualReturn: overrides.actualReturn ?? null,
    status: overrides.status ?? InvestmentStatus.PENDING,
    transactionHash: overrides.transactionHash ?? null,
    stellarOperationIndex: overrides.stellarOperationIndex ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
    deletedAt: overrides.deletedAt ?? null,
    invoice: overrides.invoice as Investment["invoice"],
    investor: overrides.investor as Investment["investor"],
    transactions: overrides.transactions ?? [],
  } as unknown as Investment;
}

function createTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    userId: overrides.userId ?? crypto.randomUUID(),
    invoiceId: overrides.invoiceId ?? null,
    investmentId: overrides.investmentId ?? null,
    type: overrides.type ?? TransactionType.INVESTMENT,
    amount: overrides.amount ?? "100.0000",
    stellarTxHash: overrides.stellarTxHash ?? null,
    stellarOperationIndex: overrides.stellarOperationIndex ?? null,
    status: overrides.status ?? TransactionStatus.PENDING,
    timestamp: overrides.timestamp ?? new Date(),
    user: overrides.user as Transaction["user"],
    invoice: overrides.invoice as Transaction["invoice"],
    investment: overrides.investment as Transaction["investment"],
  } as unknown as Transaction;
}

function successfulHorizonResponses(amount: string) {
  return [
    createMockResponse({ ok: true, status: 200, body: { successful: true } }),
    createMockResponse({
      ok: true,
      status: 200,
      body: {
        _embedded: {
          records: [
            {
              type: "payment",
              asset_code: "USDC",
              asset_issuer: "GDUKMGUGDZQK6YHZZ7KQJX2BQPJYVY5W7C2D4GMXQ3MNK4V2ZXN5R4OT",
              amount,
              to: "GCFXROWPUBKEYEXAMPLE7KQJX2BQPJYVY5W7C2D4GMXQ3MNK4V2ZXNOPE",
            },
          ],
        },
      },
    }),
  ];
}

function createServiceContext(invoiceId: string) {
  const investmentStore = new Map<string, Investment>();
  const transactions = new Map<string, Transaction[]>();
  const fetchImplementation = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();

  const saveInvestment = jest.fn(async (investment: Investment) => {
    investmentStore.set(investment.id, investment);
    return investment;
  });

  const saveTransaction = jest.fn(async (transaction: Transaction) => {
    const current = transactions.get(transaction.investmentId ?? "") ?? [];
    if (!current.find((item) => item.id === transaction.id)) {
      current.push(transaction);
    }
    transactions.set(transaction.investmentId ?? "", current);
    return transaction;
  });

  function addInvestment(overrides: Partial<Investment> = {}): Investment {
    const investment = createInvestment({ invoiceId, ...overrides });
    investmentStore.set(investment.id, investment);
    return investment;
  }

  const service = new VerifyPaymentService({
    investmentReader: {
      findById: async (investmentId) => investmentStore.get(investmentId) ?? null,
    },
    transactionRunner: {
      runInTransaction: async (callback) =>
        callback({
          findInvestmentByIdForUpdate: async (investmentId) =>
            investmentStore.get(investmentId) ?? null,
          findTransactionsByInvestmentIdForUpdate: async (investmentId) =>
            transactions.get(investmentId) ?? [],
          saveInvestment,
          saveTransaction,
          createTransaction: (input) => createTransaction(input),
        }),
    },
    config: {
      horizonUrl: "https://horizon-testnet.stellar.org",
      usdcAssetCode: "USDC",
      usdcAssetIssuer: "GDUKMGUGDZQK6YHZZ7KQJX2BQPJYVY5W7C2D4GMXQ3MNK4V2ZXN5R4OT",
      escrowPublicKey: "GCFXROWPUBKEYEXAMPLE7KQJX2BQPJYVY5W7C2D4GMXQ3MNK4V2ZXNOPE",
      allowedAmountDelta: "0.0001",
      retryAttempts: 3,
      retryBaseDelayMs: 10,
    },
    fetchImplementation,
    sleep: jest.fn(async () => undefined),
  });

  return {
    service,
    addInvestment,
    investmentStore,
    transactions,
    fetchImplementation,
    saveInvestment,
    saveTransaction,
  };
}

describe("VerifyPaymentService idempotency (transaction hash as dedup key)", () => {
  it("creates the investment record on the first call with a new transaction hash", async () => {
    const invoiceId = crypto.randomUUID();
    const context = createServiceContext(invoiceId);
    const investment = context.addInvestment();

    context.fetchImplementation
      .mockResolvedValueOnce(successfulHorizonResponses("100.0000")[0])
      .mockResolvedValueOnce(successfulHorizonResponses("100.0000")[1]);

    const result = await context.service.verifyPayment({
      investmentId: investment.id,
      stellarTxHash: "hash-a",
    });

    expect(result.outcome).toBe("verified");
    expect(result.status).toBe(InvestmentStatus.CONFIRMED);
    expect(context.investmentStore.get(investment.id)?.transactionHash).toBe("hash-a");
    expect(context.transactions.get(investment.id)).toHaveLength(1);
    expect(context.saveInvestment).toHaveBeenCalledTimes(1);
    expect(context.saveTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns success without creating a duplicate record on a repeated call with the same hash", async () => {
    const invoiceId = crypto.randomUUID();
    const context = createServiceContext(invoiceId);
    const investment = context.addInvestment();
    const stellarTxHash = "duplicate-hash";

    context.fetchImplementation
      .mockResolvedValueOnce(successfulHorizonResponses("100.0000")[0])
      .mockResolvedValueOnce(successfulHorizonResponses("100.0000")[1]);

    const firstResult = await context.service.verifyPayment({
      investmentId: investment.id,
      stellarTxHash,
    });

    expect(firstResult.outcome).toBe("verified");
    expect(context.transactions.get(investment.id)).toHaveLength(1);
    expect(context.saveTransaction).toHaveBeenCalledTimes(1);
    expect(context.saveInvestment).toHaveBeenCalledTimes(1);

    context.saveTransaction.mockClear();
    context.saveInvestment.mockClear();

    const secondResult = await context.service.verifyPayment({
      investmentId: investment.id,
      stellarTxHash,
      operationIndex: firstResult.operationIndex,
    });

    expect(secondResult.outcome).toBe("already_verified");
    expect(secondResult.status).toBe(InvestmentStatus.CONFIRMED);

    // Deduplication happens before any write: no additional record created.
    expect(context.transactions.get(investment.id)).toHaveLength(1);
    expect(context.saveTransaction).not.toHaveBeenCalled();
    expect(context.saveInvestment).not.toHaveBeenCalled();

    // The dedup path also never re-hits Horizon for a fully confirmed investment.
    expect(context.fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("creates two independent records for two different transaction hashes on the same invoice", async () => {
    const invoiceId = crypto.randomUUID();
    const context = createServiceContext(invoiceId);
    const investmentA = context.addInvestment();
    const investmentB = context.addInvestment();

    context.fetchImplementation
      .mockResolvedValueOnce(successfulHorizonResponses("100.0000")[0])
      .mockResolvedValueOnce(successfulHorizonResponses("100.0000")[1])
      .mockResolvedValueOnce(successfulHorizonResponses("100.0000")[0])
      .mockResolvedValueOnce(successfulHorizonResponses("100.0000")[1]);

    const resultA = await context.service.verifyPayment({
      investmentId: investmentA.id,
      stellarTxHash: "hash-a",
    });
    const resultB = await context.service.verifyPayment({
      investmentId: investmentB.id,
      stellarTxHash: "hash-b",
    });

    expect(resultA.outcome).toBe("verified");
    expect(resultB.outcome).toBe("verified");
    expect(context.investmentStore.get(investmentA.id)?.transactionHash).toBe("hash-a");
    expect(context.investmentStore.get(investmentB.id)?.transactionHash).toBe("hash-b");
    expect(context.transactions.get(investmentA.id)).toHaveLength(1);
    expect(context.transactions.get(investmentB.id)).toHaveLength(1);
    expect(context.transactions.get(investmentA.id)?.[0].id).not.toBe(
      context.transactions.get(investmentB.id)?.[0].id
    );
  });
});
