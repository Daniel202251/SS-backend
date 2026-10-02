import { ServiceError } from "../../../../src/utils/service-error";
import { InvoiceEscrowContractService } from "../../../../src/services/stellar/invoice-escrow-contract.service";
import type { AppLogger } from "../../../../src/observability/logger";

describe("InvoiceEscrowContractService - hardening", () => {
  const ESCROW_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const TEST_SELLER = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
  const TEST_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const TEST_INVOICE_ID = "INV-2026-001";
  const TEST_AMOUNT_STROOPS = 500_000_000n;
  // Future-safe due date: year ~2030.
  const FUTURE_DUE_DATE = 1893456000;
  const FUTURE_MS = FUTURE_DUE_DATE * 1000;

  let mockLogger: AppLogger;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
    };
  });

  describe("parseStroopAmount hardening", () => {
    const service = new InvoiceEscrowContractService({
      contractId: ESCROW_CONTRACT_ID,
      logger: mockLogger,
    });

    it.each([
      ["empty string", ""],
      ["whitespace string", "   "],
      ["non-numeric string", "abc"],
      ["decimal string", "1.5"],
    ])("rejects %s as ServiceError(invalid_input)", (_label, value) => {
      expect(() =>
        service.buildCreateEscrowTx(TEST_INVOICE_ID, TEST_SELLER, value, FUTURE_DUE_DATE, TEST_TOKEN),
      ).toThrow(ServiceError);
    });

    it("rejects non-integer numbers", () => {
      expect(() =>
        service.buildCreateEscrowTx(TEST_INVOICE_ID, TEST_SELLER, 1.5, FUTURE_DUE_DATE, TEST_TOKEN),
      ).toThrow(ServiceError);
      expect(() =>
        service.buildCreateEscrowTx(TEST_INVOICE_ID, TEST_SELLER, NaN, FUTURE_DUE_DATE, TEST_TOKEN),
      ).toThrow(ServiceError);
    });

    it("rejects amounts above the configured ceiling", () => {
      const tinyCapService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        logger: mockLogger,
        maxStroops: 1000n,
      });
      try {
        tinyCapService.buildCreateEscrowTx(
          TEST_INVOICE_ID,
          TEST_SELLER,
          1001n,
          FUTURE_DUE_DATE,
          TEST_TOKEN,
        );
        throw new Error("expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceError);
        expect((error as ServiceError).code).toBe("invalid_input");
        expect((error as ServiceError).statusCode).toBe(400);
      }
    });

    it("sanitizes the underlying error message before surfacing it", () => {
      try {
        service.buildCreateEscrowTx(
          TEST_INVOICE_ID,
          TEST_SELLER,
          "not-a-number",
          FUTURE_DUE_DATE,
          TEST_TOKEN,
        );
        throw new Error("expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceError);
        const message = (error as Error).message;
        // The original `SyntaxError` from `BigInt(...)` leaks no internal
        // details — only the sanitized field-prefixed message should be
        // visible to the caller.
        expect(message.startsWith("Invalid amountStroops:")).toBe(true);
      }
    });
  });

  describe("strict due-date validation (opt-in)", () => {
    it("rejects past due dates when strict validation is enabled", () => {
      const pastService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        logger: mockLogger,
        strictDueDateValidation: true,
        now: () => FUTURE_MS + 60_000,
      });
      try {
        pastService.buildCreateEscrowTx(
          TEST_INVOICE_ID,
          TEST_SELLER,
          TEST_AMOUNT_STROOPS,
          FUTURE_DUE_DATE,
          TEST_TOKEN,
        );
        throw new Error("expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceError);
        expect((error as ServiceError).code).toBe("invalid_input");
        expect((error as Error).message).toBe("dueDateTimestamp must be in the future.");
      }
    });

    it("rejects due dates far in the future when strict validation is enabled", () => {
      const farFuture = FUTURE_MS / 1000 + 100 * 365 * 24 * 60 * 60;
      const farService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        logger: mockLogger,
        strictDueDateValidation: true,
        now: () => FUTURE_MS,
      });
      expect(() =>
        farService.buildCreateEscrowTx(
          TEST_INVOICE_ID,
          TEST_SELLER,
          TEST_AMOUNT_STROOPS,
          farFuture,
          TEST_TOKEN,
        ),
      ).toThrow(ServiceError);
    });

    it("still rejects malformed due dates even without strict validation", () => {
      const permissiveService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        logger: mockLogger,
      });
      expect(() =>
        permissiveService.buildCreateEscrowTx(
          TEST_INVOICE_ID,
          TEST_SELLER,
          TEST_AMOUNT_STROOPS,
          0,
          TEST_TOKEN,
        ),
      ).toThrow(/dueDateTimestamp must be a positive number/);
      expect(() =>
        permissiveService.buildCreateEscrowTx(
          TEST_INVOICE_ID,
          TEST_SELLER,
          TEST_AMOUNT_STROOPS,
          Number.NaN,
          TEST_TOKEN,
        ),
      ).toThrow(/dueDateTimestamp must be a positive number/);
    });

    it("accepts past due dates when strict validation is disabled (back-compat)", () => {
      const permissiveService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        logger: mockLogger,
      });
      expect(() =>
        permissiveService.buildCreateEscrowTx(
          TEST_INVOICE_ID,
          TEST_SELLER,
          TEST_AMOUNT_STROOPS,
          1000,
          TEST_TOKEN,
        ),
      ).not.toThrow();
    });
  });

  describe("RPC retry/backoff", () => {
    it("recovers from a transient simulateTransaction failure on retry", async () => {
      const mockServer = {
        simulateTransaction: jest
          .fn<Promise<unknown>, []>()
          .mockRejectedValueOnce(new Error("ECONNRESET"))
          .mockResolvedValueOnce({ minResourceFee: "42", cost: { cpuInsns: "1", memBytes: "2" } }),
      } as any;

      const service = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
        logger: mockLogger,
        rpcRetryBaseDelayMs: 1,
      });

      const result = await service.simulateTransaction({} as any);

      expect(result.minResourceFee).toBe("42");
      expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Soroban RPC call failed, will retry if attempts remain",
        expect.objectContaining({ operation: "simulateTransaction", attempt: 1 }),
      );
    });

    it("wraps a persistent simulateTransaction failure in ServiceError 502 after retries", async () => {
      const mockServer = {
        simulateTransaction: jest.fn().mockRejectedValue(new Error("ECONNRESET")),
      } as any;

      const service = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
        logger: mockLogger,
        rpcRetryAttempts: 3,
        rpcRetryBaseDelayMs: 1,
      });

      await expect(service.simulateTransaction({} as any)).rejects.toMatchObject({
        code: "soroban_simulation_failed",
        statusCode: 502,
      });
      expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(3);
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Soroban simulateTransaction call failed.",
        expect.objectContaining({ sorobanContractId: ESCROW_CONTRACT_ID }),
      );
    });

    it("recovers from a transient submitTransaction failure on retry", async () => {
      const mockServer = {
        sendTransaction: jest
          .fn<Promise<unknown>, []>()
          .mockRejectedValueOnce(new Error("timeout"))
          .mockResolvedValueOnce({ status: "PENDING", hash: "h" }),
      } as any;

      const service = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
        logger: mockLogger,
        rpcRetryBaseDelayMs: 1,
      });

      const result = await service.submitTransaction({} as any);
      expect(result.status).toBe("PENDING");
      expect(mockServer.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it("honours a custom rpcRetryAttempts override", async () => {
      const mockServer = {
        sendTransaction: jest.fn().mockRejectedValue(new Error("boom")),
      } as any;

      const service = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
        logger: mockLogger,
        rpcRetryAttempts: 5,
        rpcRetryBaseDelayMs: 1,
      });

      await expect(service.submitTransaction({} as any)).rejects.toBeInstanceOf(ServiceError);
      expect(mockServer.sendTransaction).toHaveBeenCalledTimes(5);
    });
  });

  describe("RPC not configured", () => {
    it("throws ServiceError(503) for simulateTransaction without server", async () => {
      const service = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        logger: mockLogger,
      });
      await expect(service.simulateTransaction({} as any)).rejects.toMatchObject({
        code: "rpc_not_configured",
        statusCode: 503,
      });
    });

    it("throws ServiceError(503) for submitTransaction without server", async () => {
      const service = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        logger: mockLogger,
      });
      await expect(service.submitTransaction({} as any)).rejects.toMatchObject({
        code: "rpc_not_configured",
        statusCode: 503,
      });
    });

    it("throws ServiceError(503) for waitForTransactionConfirmation without server", async () => {
      const service = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        logger: mockLogger,
      });
      await expect(service.waitForTransactionConfirmation("hash")).rejects.toMatchObject({
        code: "rpc_not_configured",
        statusCode: 503,
      });
    });
  });

  describe("sanitization", () => {
    it("rejects non-string invoiceId in build helpers as ServiceError", () => {
      const service = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        logger: mockLogger,
      });
      // @ts-expect-error - exercising runtime safety
      expect(() => service.buildFundEscrowTx(undefined, TEST_SELLER, TEST_AMOUNT_STROOPS)).toThrow(
        ServiceError,
      );
    });

    it("does not log platformSecretKey in createEscrowOnChain", async () => {
      const secret = "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
      const service = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        logger: mockLogger,
        platformSecretKey: secret,
      });
      await service.createEscrowOnChain({
        invoiceId: TEST_INVOICE_ID,
        sellerAddress: TEST_SELLER,
        amountStroops: TEST_AMOUNT_STROOPS,
        dueDateTimestamp: FUTURE_DUE_DATE,
        paymentTokenAddress: TEST_TOKEN,
      });
      const allCalls = [
        ...(mockLogger.info as jest.Mock).mock.calls,
        ...(mockLogger.warn as jest.Mock).mock.calls,
        ...(mockLogger.error as jest.Mock).mock.calls,
        ...(mockLogger.debug as jest.Mock).mock.calls,
      ];
      for (const call of allCalls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(secret);
      }
    });
  });
});
