import {
  classifyReconciliationError,
  ReconciliationFailureKind,
  ReconciliationRetryDecision,
} from "../../src/services/stellar/reconciliation-retry";
import { RetryableHorizonError } from "../../src/services/stellar/verify-payment.service";
import { ServiceError } from "../../src/utils/service-error";

/**
 * Unit coverage for issue #222: reconciliation must retry transient
 * Soroban / Horizon provider failures but must NOT retry permanent
 * validation failures. The classifier is a pure function so every covered
 * error type can be asserted deterministically.
 */
describe("classifyReconciliationError", () => {
  describe("transient provider failures are retryable", () => {
    it("classifies an explicit Horizon 5xx/429 provider error as retryable", () => {
      const decision = classifyReconciliationError(
        new RetryableHorizonError("Transient Horizon response: 503")
      );

      expect(decision.retryable).toBe(true);
      expect(decision.kind).toBe("transient_provider");
    });

    it("classifies a horizon_unavailable service error as retryable", () => {
      const decision = classifyReconciliationError(
        new ServiceError(
          "horizon_unavailable",
          "Horizon is temporarily unavailable. Please retry later.",
          503
        )
      );

      expect(decision).toMatchObject({
        retryable: true,
        kind: "transient_provider",
        reason: "Provider unavailable (horizon_unavailable)",
      });
    });

    it("classifies a fetch abort (timeout) as retryable", () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";

      const decision = classifyReconciliationError(abortError);

      expect(decision.retryable).toBe(true);
      expect(decision.kind).toBe("transient_provider");
      expect(decision.reason).toMatch(/timed out/);
    });

    it("classifies a DOM-style TimeoutError as retryable", () => {
      const timeoutError = new Error("Timeout hit");
      timeoutError.name = "TimeoutError";

      expect(classifyReconciliationError(timeoutError).retryable).toBe(true);
    });

    it("classifies a network errno failure as retryable", () => {
      const networkError = new Error("socket hang up");
      (networkError as NodeJS.ErrnoException).code = "ECONNRESET";

      expect(classifyReconciliationError(networkError)).toMatchObject({
        retryable: true,
        kind: "transient_provider",
      });
    });

    it("classifies any object carrying a 5xx/429 provider status as retryable", () => {
      expect(classifyReconciliationError({ status: 429 }).retryable).toBe(true);
      expect(classifyReconciliationError({ status: 503 }).retryable).toBe(true);
      expect(classifyReconciliationError({ status: 500 }).retryable).toBe(true);
    });
  });

  describe("permanent validation failures are NOT retryable", () => {
    it("classifies a malformed response error as permanent", () => {
      const decision = classifyReconciliationError(
        new ServiceError("invalid_amount", "Invalid decimal amount: abc", 500)
      );

      expect(decision.retryable).toBe(false);
      expect(decision.kind).toBe("permanent_validation");
    });

    it("classifies an authorization / rejected request as permanent", () => {
      const decision = classifyReconciliationError(
        new ServiceError(
          "horizon_request_failed",
          "Horizon rejected the verification request.",
          502
        )
      );

      expect(decision.retryable).toBe(false);
      expect(decision.kind).toBe("permanent_validation");
    });

    it("classifies a business-rule invalid_payment error as permanent", () => {
      const decision = classifyReconciliationError(
        new ServiceError("invalid_payment", "No Stellar payment operation matched.", 422)
      );

      expect(decision.retryable).toBe(false);
      expect(decision.kind).toBe("permanent_validation");
    });

    it("classifies a not-found error as permanent", () => {
      const decision = classifyReconciliationError(
        new ServiceError("transaction_not_found", "Transaction not found.", 404)
      );

      expect(decision.retryable).toBe(false);
      expect(decision.kind).toBe("permanent_validation");
    });

    it("classifies a reconciliation conflict as permanent", () => {
      const decision = classifyReconciliationError(
        new ServiceError("reconciliation_conflict", "Investment is already confirmed.", 409)
      );

      expect(decision.retryable).toBe(false);
    });

    it("classifies an unrecognised generic error as permanent (fail-safe)", () => {
      expect(classifyReconciliationError(new Error("boom"))).toMatchObject({
        retryable: false,
        kind: "permanent_validation",
      });
    });
  });

  describe("attempt metadata and determinism", () => {
    it("exposes the attempt number it was classified at", () => {
      const decision = classifyReconciliationError(
        new ServiceError("horizon_unavailable", "down", 503),
        3
      );

      expect(decision.attempt).toBe(3);
    });

    it("defaults the attempt metadata to 1", () => {
      const decision = classifyReconciliationError(new Error("boom"));
      expect(decision.attempt).toBe(1);
    });

    it("is deterministic for every covered error type", () => {
      const errors: unknown[] = [
        new RetryableHorizonError("x"),
        new ServiceError("horizon_unavailable", "x", 503),
        new ServiceError("invalid_payment", "x", 422),
        new ServiceError("horizon_request_failed", "x", 502),
        new ServiceError("invalid_amount", "x", 500),
        new Error("generic"),
      ];

      for (const error of errors) {
        const first = classifyReconciliationError(error);
        const second = classifyReconciliationError(error);
        expect(second).toEqual(first);
      }
    });

    it("survives non-Error values without throwing", () => {
      const nonErrors: unknown[] = [undefined, null, "text", 42, { status: 200 }];

      for (const value of nonErrors) {
        const decision: ReconciliationRetryDecision = classifyReconciliationError(value);
        expect(typeof decision.retryable).toBe("boolean");
        expect(["transient_provider", "permanent_validation"]).toContain(
          decision.kind as ReconciliationFailureKind
        );
      }
    });
  });
});
