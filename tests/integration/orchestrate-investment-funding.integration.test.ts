import crypto from "crypto";
import { Investment } from "../../src/models/Investment.model";
import { Transaction } from "../../src/models/Transaction.model";
import { OrchestrateInvestmentFundingService } from "../../src/services/stellar/orchestrate-investment-funding.service";
import { InvestmentStatus, TransactionStatus, TransactionType } from "../../src/types/enums";

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

describe("OrchestrateInvestmentFundingService integration", () => {
  it("passes the invoice ID and amount through to the Soroban wrapper and returns the tx hash", async () => {
    const investment = createInvestment({
      invoiceId: "invoice-123",
      investorId: "investor-456",
      investmentAmount: "250.0000",
    });

    const transactions = new Map<string, Transaction>();
    const prepareInvestmentFunding = jest.fn().mockResolvedValue({
      contractId: "CESCROW123",
      xdr: "AAAA-wallet-xdr",
      expiresAt: "2026-03-27T22:00:00.000Z",
      txHash: "tx-hash-123",
      ledger: 12345,
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
      invoiceId: "invoice-123",
      investorId: "investor-456",
      amount: "250.0000",
    });
    expect(result).toMatchObject({
      mode: "wallet_xdr",
      investmentId: investment.id,
      invoiceId: "invoice-123",
      transactionId: expect.any(String),
      txHash: "tx-hash-123",
      xdr: "AAAA-wallet-xdr",
      contractId: "CESCROW123",
      requiresReconciliation: true,
    });
    expect(transactions.get(investment.id)).toMatchObject({
      userId: "investor-456",
      invoiceId: "invoice-123",
      investmentId: investment.id,
      amount: "250.0000",
      status: TransactionStatus.PENDING,
      type: TransactionType.INVESTMENT,
    });
  });
});
