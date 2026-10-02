import crypto from "crypto";
import { Investment } from "../src/models/Investment.model";
import { Transaction } from "../src/models/Transaction.model";
import { OrchestrateInvestmentFundingService } from "../src/services/stellar/orchestrate-investment-funding.service";
import { InvestmentStatus, TransactionStatus, TransactionType } from "../src/types/enums";
import type { AppLogger } from "../src/observability/logger";

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

function createMockLogger(): jest.Mocked<AppLogger> {
  const logger: jest.Mocked<AppLogger> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

describe("OrchestrateInvestmentFundingService structured escrow logging", () => {
  it("logs a debug entry before submission and an info entry after confirmation", async () => {
    const investment = createInvestment();
    const logger = createMockLogger();
    const transactions = new Map<string, Transaction>();

    const service = new OrchestrateInvestmentFundingService({
      investmentReader: { findById: async () => investment },
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
        prepareInvestmentFunding: jest.fn().mockResolvedValue({
          contractId: "CESCROW123",
          xdr: "AAAA-wallet-xdr",
          expiresAt: "2026-03-27T22:00:00.000Z",
          txHash: "escrow-tx-hash",
          ledger: 555111,
        }),
      },
      config: { enabled: true, contractId: "CESCROW123", fundingMode: "wallet_xdr" },
      logger,
    });

    await service.orchestrateFunding(investment.id);

    expect(logger.debug).toHaveBeenCalledWith(
      "Submitting Soroban escrow transaction.",
      expect.objectContaining({
        contract_id: "CESCROW123",
        function_name: "prepare_investment_funding",
        invoice_id: investment.invoiceId,
        submitted_at: expect.any(String),
      })
    );

    expect(logger.info).toHaveBeenCalledWith(
      "Soroban escrow transaction confirmed.",
      expect.objectContaining({
        contract_id: "CESCROW123",
        function_name: "prepare_investment_funding",
        invoice_id: investment.invoiceId,
        tx_hash: "escrow-tx-hash",
        ledger: 555111,
        confirmed_at: expect.any(String),
      })
    );

    const [, debugMetadata] = logger.debug.mock.calls[0];
    const [, infoMetadata] = logger.info.mock.calls[0];
    for (const metadata of [debugMetadata, infoMetadata]) {
      const serialized = JSON.stringify(metadata);
      expect(serialized).not.toMatch(/investmentAmount|amount/i);
      expect(serialized).not.toContain(investment.investorId);
    }
  });

  it("logs a warn entry with the failure reason when escrow submission fails, and never logs info", async () => {
    const investment = createInvestment();
    const logger = createMockLogger();

    const service = new OrchestrateInvestmentFundingService({
      investmentReader: { findById: async () => investment },
      transactionRunner: { runInTransaction: jest.fn() },
      sorobanEscrowClient: {
        prepareInvestmentFunding: jest.fn().mockRejectedValue(new Error("RPC unavailable")),
      },
      config: { enabled: true, contractId: "CESCROW123", fundingMode: "wallet_xdr" },
      logger,
    });

    await expect(service.orchestrateFunding(investment.id)).rejects.toThrow("RPC unavailable");

    expect(logger.warn).toHaveBeenCalledWith(
      "Soroban escrow transaction submission failed.",
      expect.objectContaining({
        contract_id: "CESCROW123",
        function_name: "prepare_investment_funding",
        invoice_id: investment.invoiceId,
        submitted_at: expect.any(String),
        error_reason: "RPC unavailable",
      })
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});
