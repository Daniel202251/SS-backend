import { ServiceError } from "../../utils/service-error";
import { RetryableHorizonError } from "./verify-payment.service";

/**
 * Classification of a reconciliation failure so the worker (or any caller)
 * can decide whether the pending candidate should be retried on a later tick.
 *
 * Transient provider failures (timeouts, unavailable RPC/Horizon, 5xx / 429)
 * are retryable. Permanent validation failures (malformed responses,
 * authorization issues, business-rule violations) are not retryable because no
 * amount of retrying will change the outcome.
 */
export type ReconciliationFailureKind = "transient_provider" | "permanent_validation";

export interface ReconciliationRetryDecision {
  /** `true` when the failure is safe to retry on a later tick. */
  retryable: boolean;
  kind: ReconciliationFailureKind;
  /** Human-readable, deterministic reason for the decision. */
  reason: string;
  /** The attempt at which the failure was observed (1-based). */
  attempt: number;
}

/** ServiceError codes that represent a temporarily unavailable provider. */
const RETRYABLE_SERVICE_CODES = new Set(["horizon_unavailable"]);

/** Network-level errno codes that indicate a transient infrastructure issue. */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
]);

/** Error `name` values produced by fetch/AbortController when a request times out. */
const TIMEOUT_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);

function timeoutDecision(attempt: number, name: string): ReconciliationRetryDecision {
  return {
    retryable: true,
    kind: "transient_provider",
    reason: `Provider request timed out (${name})`,
    attempt,
  };
}

/**
 * Classifies an error thrown while reconciling pending Stellar state.
 *
 * The decision is deterministic: the same error type always yields the same
 * `retryable` / `kind` outcome, so tests (and operators reasoning from logs)
 * can rely on stable behaviour.
 *
 * @param error   The thrown error, or any unknown value.
 * @param attempt The 1-based attempt number at which the failure occurred.
 */
export function classifyReconciliationError(
  error: unknown,
  attempt = 1
): ReconciliationRetryDecision {
  // 1. Explicit request timeouts / aborts are always transient.
  if (error instanceof Error && TIMEOUT_ERROR_NAMES.has(error.name)) {
    return timeoutDecision(attempt, error.name);
  }

  // 2. Provider errors marked retryable (5xx / 429 Horizon responses).
  if (error instanceof RetryableHorizonError) {
    return {
      retryable: true,
      kind: "transient_provider",
      reason: "Transient provider error",
      attempt,
    };
  }

  // 3. Network-level errno codes indicate a transient connectivity issue.
  if (
    error instanceof Error &&
    RETRYABLE_NETWORK_CODES.has((error as NodeJS.ErrnoException).code ?? "")
  ) {
    return {
      retryable: true,
      kind: "transient_provider",
      reason: `Transient network error (${(error as NodeJS.ErrnoException).code})`,
      attempt,
    };
  }

  // 4. Any object carrying a provider HTTP status of 5xx / 429 is transient.
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && (status === 429 || status >= 500)) {
      return {
        retryable: true,
        kind: "transient_provider",
        reason: `Transient provider status ${status}`,
        attempt,
      };
    }
  }

  // 5. Known domain service errors: only the explicitly transient ones retry.
  if (error instanceof ServiceError) {
    if (RETRYABLE_SERVICE_CODES.has(error.code)) {
      return {
        retryable: true,
        kind: "transient_provider",
        reason: `Provider unavailable (${error.code})`,
        attempt,
      };
    }

    return {
      retryable: false,
      kind: "permanent_validation",
      reason: `Validation failure (${error.code})`,
      attempt,
    };
  }

  // 6. Anything unclassified is treated as a permanent validation failure:
  //    retrying would be wasteful and could mask a real defect.
  return {
    retryable: false,
    kind: "permanent_validation",
    reason: "Permanent validation failure",
    attempt,
  };
}
