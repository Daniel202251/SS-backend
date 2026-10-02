import crypto from "crypto";
import { Investment } from "../src/models/Investment.model";
import { Transaction } from "../src/models/Transaction.model";
import { OrchestrateInvestmentFundingService } from "../src/services/stellar/orchestrate-investment-funding.service";
import { InvestmentStatus, TransactionStatus, TransactionType } from "../src/types/enums";
import { ServiceError } from "../src/utils/service-error";

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

describe("OrchestrateInvestmentFundingService", () => {
  it("returns the existing non-Soroban path when the feature flag is disabled", async () => {
    const investment = createInvestment();
    const service = new OrchestrateInvestmentFundingService({
      investmentReader: {
        findById: async () => investment,
      },
      transactionRunner: {
        runInTransaction: jest.fn(),
      },
      sorobanEscrowClient: {
        prepareInvestmentFunding: jest.fn(),
      },
      config: {
        enabled: false,
        contractId: null,
        fundingMode: "wallet_xdr",
      },
    });

    await expect(service.orchestrateFunding(investment.id)).resolves.toMatchObject({
      mode: "disabled",
      investmentId: investment.id,
      invoiceId: investment.invoiceId,
      requiresReconciliation: false,
    });
  });

  it("prepares wallet-signing XDR and records a pending transaction when Soroban is enabled", async () => {
    const investment = createInvestment();
    const transactions = new Map<string, Transaction>();
    const prepareInvestmentFunding = jest.fn().mockResolvedValue({
      contractId: "CESCROW123",
      xdr: "AAAA-wallet-xdr",
      expiresAt: "2026-03-27T22:00:00.000Z",
    });
    const service = new OrchestrateInvestmentFundingService({
      investmentReader: {
        findById: async () => investment,
      },
      transactionRunner: {
        runInTransaction: async (callback) =>
          callback({
            findInvestmentByIdForUpdate: async () => investment,
            findTransactionByInvestmentIdForUpdate: async () =>
              transactions.get(investment.id) ?? null,
            saveTransaction: async (transaction) => {
              transactions.set(investment.id, transaction);
              return transaction;
            },
            createTransaction: (input) => createTransaction(input),
          }),
      },
      sorobanEscrowClient: {
        prepareInvestmentFunding,
      },
      config: {
        enabled: true,
        contractId: "CESCROW123",
        fundingMode: "wallet_xdr",
      },
    });

    const result = await service.orchestrateFunding(investment.id);

    expect(prepareInvestmentFunding).toHaveBeenCalledWith({
      investmentId: investment.id,
      invoiceId: investment.invoiceId,
      investorId: investment.investorId,
      amount: investment.investmentAmount,
    });
    expect(result).toMatchObject({
      mode: "wallet_xdr",
      investmentId: investment.id,
      invoiceId: investment.invoiceId,
      contractId: "CESCROW123",
      xdr: "AAAA-wallet-xdr",
      requiresReconciliation: true,
    });
    expect(transactions.get(investment.id)).toMatchObject({
      userId: investment.investorId,
      invoiceId: investment.invoiceId,
      investmentId: investment.id,
      status: TransactionStatus.PENDING,
      type: TransactionType.INVESTMENT,
    });
  });

  it("leaves the database untouched when Soroban draft preparation fails", async () => {
    const investment = createInvestment();
    const saveTransaction = jest.fn();
    const service = new OrchestrateInvestmentFundingService({
      investmentReader: {
        findById: async () => investment,
      },
      transactionRunner: {
        runInTransaction: jest.fn(async (callback) =>
          callback({
            findInvestmentByIdForUpdate: async () => investment,
            findTransactionByInvestmentIdForUpdate: async () => null,
            saveTransaction,
            createTransaction: (input) => createTransaction(input),
          })
        ),
      },
      sorobanEscrowClient: {
        prepareInvestmentFunding: jest
          .fn()
          .mockRejectedValue(new ServiceError("soroban_unavailable", "RPC unavailable", 503)),
      },
      config: {
        enabled: true,
        contractId: "CESCROW123",
        fundingMode: "wallet_xdr",
      },
    });

    await expect(service.orchestrateFunding(investment.id)).rejects.toMatchObject({
      code: "soroban_unavailable",
      statusCode: 503,
    });
    expect(saveTransaction).not.toHaveBeenCalled();
  });
});
