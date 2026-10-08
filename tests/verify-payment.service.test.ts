import crypto from "crypto";
import { Investment } from "../src/models/Investment.model";
import { Transaction } from "../src/models/Transaction.model";
import { VerifyPaymentService } from "../src/services/stellar/verify-payment.service";
import { InvestmentStatus, TransactionStatus, TransactionType } from "../src/types/enums";
import { ServiceError } from "../src/utils/service-error";

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

function createServiceContext() {
  const investment = createInvestment();
  const transactions = new Map<string, Transaction[]>();
  const investmentStore = new Map<string, Investment>([[investment.id, investment]]);
  const sleep = jest.fn(async () => undefined);
  const fetchImplementation = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();

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
          saveInvestment: async (lockedInvestment) => {
            investmentStore.set(lockedInvestment.id, lockedInvestment);
            return lockedInvestment;
          },
          saveTransaction: async (transaction) => {
            const current = transactions.get(transaction.investmentId ?? "") ?? [];
            if (!current.find((item) => item.id === transaction.id)) {
              current.push(transaction);
            }
            transactions.set(transaction.investmentId ?? "", current);
            return transaction;
          },
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
    sleep,
  });

  return {
    service,
    investment,
    transactions,
    fetchImplementation,
    sleep,
    investmentStore,
  };
}

describe("VerifyPaymentService", () => {
  it("verifies a Horizon payment and confirms the investment idempotently", async () => {
    const context = createServiceContext();
    const stellarTxHash = "abc123";

    context.fetchImplementation
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
          body: { successful: true },
        })
      )
      .mockResolvedValueOnce(
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
                  amount: "100.0000",
                  to: "GCFXROWPUBKEYEXAMPLE7KQJX2BQPJYVY5W7C2D4GMXQ3MNK4V2ZXNOPE",
                },
              ],
            },
          },
        })
      );

    const result = await context.service.verifyPayment({
      investmentId: context.investment.id,
      stellarTxHash,
    });

    expect(result.outcome).toBe("verified");
    expect(result.status).toBe(InvestmentStatus.CONFIRMED);
    expect(context.investmentStore.get(context.investment.id)?.transactionHash).toBe(stellarTxHash);

    const savedTransactions = context.transactions.get(context.investment.id) ?? [];
    expect(savedTransactions).toHaveLength(1);
    expect(savedTransactions[0].status).toBe(TransactionStatus.COMPLETED);
    expect(savedTransactions[0].stellarTxHash).toBe(stellarTxHash);

    expect(savedTransactions[0].invoiceId).toBe(context.investment.invoiceId);

    const secondResult = await context.service.verifyPayment({
      investmentId: context.investment.id,
      stellarTxHash,
      operationIndex: 0,
    });

    expect(secondResult.outcome).toBe("already_verified");
    expect(context.transactions.get(context.investment.id)).toHaveLength(1);
  });

  it("retries transient Horizon failures up to three attempts", async () => {
    const context = createServiceContext();

    context.fetchImplementation
      .mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 503,
          body: {},
        })
      )
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
          body: { successful: true },
        })
      )
      .mockResolvedValueOnce(
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
                  amount: "100.0000",
                  to: "GCFXROWPUBKEYEXAMPLE7KQJX2BQPJYVY5W7C2D4GMXQ3MNK4V2ZXNOPE",
                },
              ],
            },
          },
        })
      );

    const result = await context.service.verifyPayment({
      investmentId: context.investment.id,
      stellarTxHash: "retry-hash",
    });

    expect(result.outcome).toBe("verified");
    expect(context.fetchImplementation).toHaveBeenCalledTimes(3);
    expect(context.sleep).toHaveBeenCalledTimes(1);
    expect(context.sleep).toHaveBeenCalledWith(10);
  });

  it("returns stable service errors when Horizon cannot find the transaction", async () => {
    const context = createServiceContext();

    context.fetchImplementation.mockResolvedValueOnce(
      createMockResponse({
        ok: false,
        status: 404,
        body: {},
      })
    );

    await expect(
      context.service.verifyPayment({
        investmentId: context.investment.id,
        stellarTxHash: "missing-hash",
      })
    ).rejects.toMatchObject({
      code: "transaction_not_found",
      statusCode: 404,
    });
  });

  it("rejects payments that do not match the configured asset, amount, and destination", async () => {
    const context = createServiceContext();

    context.fetchImplementation
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
          body: { successful: true },
        })
      )
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
          body: {
            _embedded: {
              records: [
                {
                  type: "payment",
                  asset_code: "XLM",
                  amount: "99.0000",
                  to: "GBADDESTINATION",
                },
              ],
            },
          },
        })
      );

    await expect(
      context.service.verifyPayment({
        investmentId: context.investment.id,
        stellarTxHash: "bad-payment",
      })
    ).rejects.toMatchObject({
      code: "invalid_payment",
      statusCode: 422,
    });
  });
});
