import { VerifyPaymentService, PaymentVerificationInput } from "../../../../src/services/stellar/verify-payment.service";
import { ServiceError } from "../../../../src/utils/service-error";
import { InvestmentStatus, TransactionStatus, TransactionType } from "../../../../src/types/enums";
import type { Investment } from "../../../../src/models/Investment.model";
import type { Transaction } from "../../../../src/models/Transaction.model";
import type { PaymentVerificationConfig } from "../../../../src/config/stellar";

describe("VerifyPaymentService", () => {
  const TEST_TX_HASH = "abc123def456";
  const TEST_INVESTMENT_ID = "inv-001";
  const TEST_ESCROW_KEY = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
  const TEST_USDC_ISSUER = "CBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

  const mockConfig: PaymentVerificationConfig = {
    horizonUrl: "https://horizon-testnet.stellar.org",
    usdcAssetCode: "USDC",
    usdcAssetIssuer: TEST_USDC_ISSUER,
    escrowPublicKey: TEST_ESCROW_KEY,
    allowedAmountDelta: "0.0001",
    retryAttempts: 3,
    retryBaseDelayMs: 10,
  };

  const createMockInvestment = (overrides: Partial<Investment> = {}): Investment => ({
    id: TEST_INVESTMENT_ID,
    invoiceId: "invoice-001",
    investorId: "user-001",
    investmentAmount: "500.0000",
    expectedReturn: "550.0000",
    actualReturn: null,
    status: InvestmentStatus.PENDING,
    transactionHash: null,
    stellarOperationIndex: null,
    ...overrides,
  } as Investment);

  const createMockTransaction = (overrides: Partial<Transaction> = {}): Transaction => ({
    id: "tx-001",
    userId: "user-001",
    investmentId: TEST_INVESTMENT_ID,
    invoiceId: "invoice-001",
    type: TransactionType.INVESTMENT,
    amount: "500.0000",
    status: TransactionStatus.PENDING,
    stellarTxHash: null,
    stellarOperationIndex: null,
    ...overrides,
  } as Transaction);

  const createMockFetch = (responses: Response[]): jest.MockedFunction<typeof fetch> => {
    let callIndex = 0;
    const mockFetch = jest.fn().mockImplementation(() => {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex += 1;
      return Promise.resolve(response);
    });
    return mockFetch as unknown as jest.MockedFunction<typeof fetch>;
  };

  const createJsonResponse = (data: unknown, status = 200): Response => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
    } as Response;
  };

  const createMockInvestmentReader = (investment: Investment | null) => ({
    findById: jest.fn().mockResolvedValue(investment),
  });

  const createMockTransactionRunner = (
    investment: Investment | null,
    transactions: Transaction[],
  ) => ({
    runInTransaction: jest.fn().mockImplementation(async (callback: any) => {
      return callback({
        findInvestmentByIdForUpdate: jest.fn().mockResolvedValue(investment),
        findTransactionsByInvestmentIdForUpdate: jest.fn().mockResolvedValue(transactions),
        saveInvestment: jest.fn().mockImplementation((inv: Investment) => Promise.resolve({
          ...inv,
          id: inv.id || "saved-inv",
        })),
        saveTransaction: jest.fn().mockImplementation((tx: Transaction) => Promise.resolve({
          ...tx,
          id: tx.id || "saved-tx",
        })),
        createTransaction: jest.fn().mockImplementation((input: Partial<Transaction>) => ({
          id: "",
          userId: "",
          investmentId: null,
          invoiceId: null,
          type: TransactionType.INVESTMENT,
          amount: "0",
          status: TransactionStatus.PENDING,
          stellarTxHash: null,
          stellarOperationIndex: null,
          ...input,
        })),
      });
    }),
  });

  const createService = (options: {
    investment?: Investment | null;
    lockedInvestment?: Investment | null;
    transactions?: Transaction[];
    fetchResponses?: Response[];
    sleepFn?: (ms: number) => Promise<void>;
  } = {}) => {
    const {
      investment = createMockInvestment(),
      lockedInvestment,
      transactions = [],
      fetchResponses = [],
      sleepFn = jest.fn().mockResolvedValue(undefined),
    } = options;

    const resolvedLocked = lockedInvestment !== undefined
      ? lockedInvestment
      : (investment ?? createMockInvestment());

    const fetchImpl = createMockFetch(fetchResponses);
    const reader = createMockInvestmentReader(investment);
    const runner = createMockTransactionRunner(resolvedLocked, transactions);

    const service = new VerifyPaymentService({
      investmentReader: reader,
      transactionRunner: runner,
      config: mockConfig,
      fetchImplementation: fetchImpl,
      sleep: sleepFn,
    });

    return { service, fetchMock: fetchImpl, reader, runner, sleepFn };
  };

  describe("verifyPayment", () => {
    it("should throw investment_not_found when investment does not exist", async () => {
      const { service } = createService({ investment: null });

      await expect(service.verifyPayment({
        investmentId: "nonexistent",
        stellarTxHash: TEST_TX_HASH,
      })).rejects.toMatchObject({
        code: "investment_not_found",
        statusCode: 404,
      });
    });

    it("should return already_verified when investment is confirmed with same tx", async () => {
      const investment = createMockInvestment({
        status: InvestmentStatus.CONFIRMED,
        transactionHash: TEST_TX_HASH,
        stellarOperationIndex: 1,
      });

      const { service } = createService({ investment });

      const result = await service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
        operationIndex: 1,
      });

      expect(result.outcome).toBe("already_verified");
      expect(result.investmentId).toBe(TEST_INVESTMENT_ID);
    });

    it("should throw reconciliation_conflict when investment confirmed with different tx", async () => {
      const investment = createMockInvestment({
        status: InvestmentStatus.CONFIRMED,
        transactionHash: "different-hash",
        stellarOperationIndex: 1,
      });

      const { service } = createService({ investment });

      await expect(service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      })).rejects.toMatchObject({
        code: "reconciliation_conflict",
        statusCode: 409,
      });
    });

    it("should verify payment successfully with matching operation", async () => {
      const investment = createMockInvestment();
      const lockedInvestment = createMockInvestment();

      const { service, fetchMock } = createService({
        investment,
        lockedInvestment,
        transactions: [],
        fetchResponses: [
          createJsonResponse({ successful: true }),
          createJsonResponse({
            _embedded: {
              records: [
                {
                  type: "payment",
                  asset_code: "USDC",
                  asset_issuer: TEST_USDC_ISSUER,
                  amount: "500.0000000",
                  to: TEST_ESCROW_KEY,
                },
              ],
            },
          }),
        ],
      });

      const result = await service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      });

      expect(result.outcome).toBe("verified");
      expect(result.investmentId).toBe(TEST_INVESTMENT_ID);
      expect(result.status).toBe(InvestmentStatus.CONFIRMED);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("fetchAndValidatePayment - transaction validation", () => {
    it("should throw transaction_not_found on 404 response", async () => {
      const investment = createMockInvestment();

      const { service } = createService({
        investment,
        fetchResponses: [
          createJsonResponse({}, 404),
          createJsonResponse({}, 404),
          createJsonResponse({}, 404),
        ],
      });

      await expect(service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: "nonexistent-hash",
      })).rejects.toMatchObject({
        code: "transaction_not_found",
        statusCode: 404,
      });
    });

    it("should throw invalid_payment when transaction was not successful", async () => {
      const investment = createMockInvestment();

      const { service } = createService({
        investment,
        fetchResponses: [
          createJsonResponse({ successful: false }),
        ],
      });

      await expect(service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      })).rejects.toMatchObject({
        code: "invalid_payment",
        statusCode: 422,
      });
    });

    it("should throw invalid_payment when no payment operation matches", async () => {
      const investment = createMockInvestment();

      const { service } = createService({
        investment,
        fetchResponses: [
          createJsonResponse({ successful: true }),
          createJsonResponse({
            _embedded: {
              records: [
                {
                  type: "payment",
                  asset_code: "USDC",
                  asset_issuer: TEST_USDC_ISSUER,
                  amount: "999.0000000",
                  to: TEST_ESCROW_KEY,
                },
              ],
            },
          }),
        ],
      });

      await expect(service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      })).rejects.toMatchObject({
        code: "invalid_payment",
        statusCode: 422,
      });
    });

    it("should throw invalid_payment when multiple payments match without operationIndex", async () => {
      const investment = createMockInvestment();

      const { service } = createService({
        investment,
        fetchResponses: [
          createJsonResponse({ successful: true }),
          createJsonResponse({
            _embedded: {
              records: [
                {
                  type: "payment",
                  asset_code: "USDC",
                  asset_issuer: TEST_USDC_ISSUER,
                  amount: "500.0000000",
                  to: TEST_ESCROW_KEY,
                },
                {
                  type: "payment",
                  asset_code: "USDC",
                  asset_issuer: TEST_USDC_ISSUER,
                  amount: "500.0000000",
                  to: TEST_ESCROW_KEY,
                },
              ],
            },
          }),
        ],
      });

      await expect(service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      })).rejects.toMatchObject({
        code: "invalid_payment",
        statusCode: 422,
      });
    });
  });

  describe("amount delta comparison", () => {
    it("should accept payment within allowed delta", async () => {
      const investment = createMockInvestment({ investmentAmount: "500.0000" });
      const lockedInvestment = createMockInvestment({ investmentAmount: "500.0000" });

      const { service } = createService({
        investment,
        lockedInvestment,
        transactions: [],
        fetchResponses: [
          createJsonResponse({ successful: true }),
          createJsonResponse({
            _embedded: {
              records: [
                {
                  type: "payment",
                  asset_code: "USDC",
                  asset_issuer: TEST_USDC_ISSUER,
                  amount: "500.0000500",
                  to: TEST_ESCROW_KEY,
                },
              ],
            },
          }),
        ],
      });

      const result = await service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      });

      expect(result.outcome).toBe("verified");
    });

    it("should reject payment outside allowed delta", async () => {
      const investment = createMockInvestment({ investmentAmount: "500.0000" });

      const { service } = createService({
        investment,
        fetchResponses: [
          createJsonResponse({ successful: true }),
          createJsonResponse({
            _embedded: {
              records: [
                {
                  type: "payment",
                  asset_code: "USDC",
                  asset_issuer: TEST_USDC_ISSUER,
                  amount: "500.1000000",
                  to: TEST_ESCROW_KEY,
                },
              ],
            },
          }),
        ],
      });

      await expect(service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      })).rejects.toMatchObject({
        code: "invalid_payment",
        statusCode: 422,
      });
    });

    it("should accept payment at exact boundary of delta", async () => {
      const investment = createMockInvestment({ investmentAmount: "500.0000" });
      const lockedInvestment = createMockInvestment({ investmentAmount: "500.0000" });

      const { service } = createService({
        investment,
        lockedInvestment,
        transactions: [],
        fetchResponses: [
          createJsonResponse({ successful: true }),
          createJsonResponse({
            _embedded: {
              records: [
                {
                  type: "payment",
                  asset_code: "USDC",
                  asset_issuer: TEST_USDC_ISSUER,
                  amount: "500.0001000",
                  to: TEST_ESCROW_KEY,
                },
              ],
            },
          }),
        ],
      });

      const result = await service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      });

      expect(result.outcome).toBe("verified");
    });
  });

  describe("retry behavior", () => {
    it("should retry on 503 and succeed on subsequent attempt", async () => {
      const investment = createMockInvestment();
      const lockedInvestment = createMockInvestment();

      const { service, fetchMock, sleepFn } = createService({
        investment,
        lockedInvestment,
        transactions: [],
        fetchResponses: [
          createJsonResponse({}, 503),
          createJsonResponse({ successful: true }),
          createJsonResponse({
            _embedded: {
              records: [
                {
                  type: "payment",
                  asset_code: "USDC",
                  asset_issuer: TEST_USDC_ISSUER,
                  amount: "500.0000000",
                  to: TEST_ESCROW_KEY,
                },
              ],
            },
          }),
        ],
        sleepFn: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      });

      expect(result.outcome).toBe("verified");
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleepFn).toHaveBeenCalledTimes(1);
      expect(sleepFn).toHaveBeenCalledWith(mockConfig.retryBaseDelayMs);
    });

    it("should retry on network timeout and succeed", async () => {
      const investment = createMockInvestment();
      const lockedInvestment = createMockInvestment();

      let callCount = 0;
      const mockFetch = jest.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.reject(new Error("socket timeout"));
        }
        if (callCount === 2) {
          return Promise.resolve(createJsonResponse({ successful: true }));
        }
        return Promise.resolve(createJsonResponse({
          _embedded: {
            records: [
              {
                type: "payment",
                asset_code: "USDC",
                asset_issuer: TEST_USDC_ISSUER,
                amount: "500.0000000",
                to: TEST_ESCROW_KEY,
              },
            ],
          },
        }));
      }) as unknown as jest.MockedFunction<typeof fetch>;

      const reader = createMockInvestmentReader(investment);
      const runner = createMockTransactionRunner(lockedInvestment, []);

      const service = new VerifyPaymentService({
        investmentReader: reader,
        transactionRunner: runner,
        config: mockConfig,
        fetchImplementation: mockFetch,
        sleep: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      });

      expect(result.outcome).toBe("verified");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should throw horizon_unavailable after exhausting retries", async () => {
      const investment = createMockInvestment();

      const { service, fetchMock } = createService({
        investment,
        fetchResponses: [
          createJsonResponse({}, 503),
          createJsonResponse({}, 503),
          createJsonResponse({}, 503),
        ],
        sleepFn: jest.fn().mockResolvedValue(undefined),
      });

      await expect(service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      })).rejects.toMatchObject({
        code: "horizon_unavailable",
        statusCode: 503,
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("should not retry on non-retryable error (400)", async () => {
      const investment = createMockInvestment();

      const { service, fetchMock } = createService({
        investment,
        fetchResponses: [
          createJsonResponse({}, 400),
        ],
      });

      await expect(service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      })).rejects.toMatchObject({
        code: "horizon_request_failed",
        statusCode: 502,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should retry on 429 rate limit", async () => {
      const investment = createMockInvestment();
      const lockedInvestment = createMockInvestment();

      const { service, fetchMock } = createService({
        investment,
        lockedInvestment,
        transactions: [],
        fetchResponses: [
          createJsonResponse({}, 429),
          createJsonResponse({ successful: true }),
          createJsonResponse({
            _embedded: {
              records: [
                {
                  type: "payment",
                  asset_code: "USDC",
                  asset_issuer: TEST_USDC_ISSUER,
                  amount: "500.0000000",
                  to: TEST_ESCROW_KEY,
                },
              ],
            },
          }),
        ],
        sleepFn: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      });

      expect(result.outcome).toBe("verified");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("transaction state transitions", () => {
    it("should throw reconciliation_conflict when multiple transactions linked", async () => {
      const investment = createMockInvestment();
      const lockedInvestment = createMockInvestment();

      const { service } = createService({
        investment,
        lockedInvestment,
        transactions: [createMockTransaction(), createMockTransaction({ id: "tx-002" })],
        fetchResponses: [
          createJsonResponse({ successful: true }),
          createJsonResponse({
            _embedded: {
              records: [
                {
                  type: "payment",
                  asset_code: "USDC",
                  asset_issuer: TEST_USDC_ISSUER,
                  amount: "500.0000000",
                  to: TEST_ESCROW_KEY,
                },
              ],
            },
          }),
        ],
      });

      await expect(service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      })).rejects.toMatchObject({
        code: "reconciliation_conflict",
        statusCode: 409,
      });
    });

    it("should throw reconciliation_conflict when existing tx linked to different hash", async () => {
      const investment = createMockInvestment();
      const lockedInvestment = createMockInvestment();

      const existingTx = createMockTransaction({ stellarTxHash: "different-hash" });

      const { service } = createService({
        investment,
        lockedInvestment,
        transactions: [existingTx],
        fetchResponses: [
          createJsonResponse({ successful: true }),
          createJsonResponse({
            _embedded: {
              records: [
                {
                  type: "payment",
                  asset_code: "USDC",
                  asset_issuer: TEST_USDC_ISSUER,
                  amount: "500.0000000",
                  to: TEST_ESCROW_KEY,
                },
              ],
            },
          }),
        ],
      });

      await expect(service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      })).rejects.toMatchObject({
        code: "reconciliation_conflict",
        statusCode: 409,
      });
    });

    it("should return already_verified when locked investment already confirmed", async () => {
      const investment = createMockInvestment();
      const lockedInvestment = createMockInvestment({
        status: InvestmentStatus.CONFIRMED,
        transactionHash: TEST_TX_HASH,
        stellarOperationIndex: 0,
      });

      const existingTx = createMockTransaction({ id: "existing-tx" });

      const { service } = createService({
        investment,
        lockedInvestment,
        transactions: [existingTx],
        fetchResponses: [
          createJsonResponse({ successful: true }),
          createJsonResponse({
            _embedded: {
              records: [
                {
                  type: "payment",
                  asset_code: "USDC",
                  asset_issuer: TEST_USDC_ISSUER,
                  amount: "500.0000000",
                  to: TEST_ESCROW_KEY,
                },
              ],
            },
          }),
        ],
      });

      const result = await service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
      });

      expect(result.outcome).toBe("already_verified");
    });
  });

  describe("operation index disambiguation", () => {
    it("should match specific operation when operationIndex provided", async () => {
      const investment = createMockInvestment();
      const lockedInvestment = createMockInvestment();

      const { service } = createService({
        investment,
        lockedInvestment,
        transactions: [],
        fetchResponses: [
          createJsonResponse({ successful: true }),
          createJsonResponse({
            _embedded: {
              records: [
                {
                  type: "create_account",
                  asset_code: "XLM",
                },
                {
                  type: "payment",
                  asset_code: "USDC",
                  asset_issuer: TEST_USDC_ISSUER,
                  amount: "500.0000000",
                  to: TEST_ESCROW_KEY,
                },
              ],
            },
          }),
        ],
      });

      const result = await service.verifyPayment({
        investmentId: TEST_INVESTMENT_ID,
        stellarTxHash: TEST_TX_HASH,
        operationIndex: 1,
      });

      expect(result.outcome).toBe("verified");
      expect(result.operationIndex).toBe(1);
    });
  });
});
