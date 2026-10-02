import { ServiceError } from "../../utils/service-error";

export interface MappedSorobanError {
  error: ServiceError;
  retryable: boolean;
  cause?: string;
}

/**
 * Map common Soroban RPC / contract errors into stable ServiceError categories.
 *
 * This intentionally returns a sanitized ServiceError and a `retryable` flag.
 * Avoid embedding raw provider payloads or secrets in the returned error.
 */
export function mapSorobanError(
  input: unknown,
  context: { contractId?: string; invoiceId?: string } = {}
): MappedSorobanError {
  // Normalize message
  const message =
    input instanceof Error
      ? input.message
      : typeof input === "string"
        ? input
        : JSON.stringify(input ?? {});

  const lower = (message ?? "").toLowerCase();

  // Timeouts / network blips
  if (/timeout|timed out|etimedout/.test(lower)) {
    return {
      error: new ServiceError("soroban_timeout", "Soroban RPC timed out.", 503, {
        contractId: context.contractId,
        invoiceId: context.invoiceId,
      }),
      retryable: true,
      cause: "timeout",
    };
  }

  // Rate limiting
  if (/429|rate limit|too many requests/.test(lower)) {
    return {
      error: new ServiceError("soroban_rate_limited", "Soroban RPC rate limited.", 503, {
        contractId: context.contractId,
      }),
      retryable: true,
      cause: "rate_limited",
    };
  }

  // Simulation failures (contract-level reverts, validation failures)
  if (/simulate|simulation failed|simulation error|revert|reverted|contract failed/.test(lower)) {
    return {
      error: new ServiceError(
        "soroban_simulation_failed",
        "Soroban transaction simulation failed.",
        422,
        { contractId: context.contractId }
      ),
      retryable: false,
      cause: "simulation_failed",
    };
  }

  // Authorization failures
  if (/authorization|auth failed|unauthorized|not authorized|forbidden/.test(lower)) {
    return {
      error: new ServiceError("soroban_unauthorized", "Soroban authorization failed.", 403, {
        contractId: context.contractId,
      }),
      retryable: false,
      cause: "unauthorized",
    };
  }

  // Capacity / resource exhaustion
  if (
    /capacity|out of memory|insufficient resources|gas|resource limit|limit exceeded/.test(lower)
  ) {
    return {
      error: new ServiceError("soroban_capacity_exceeded", "Soroban node capacity exceeded.", 503, {
        contractId: context.contractId,
      }),
      retryable: true,
      cause: "capacity_exceeded",
    };
  }

  // Transaction-level rejection reported by sendTransaction result
  if (typeof input === "object" && input !== null && "status" in input) {
    const statusVal = (input as Record<string, unknown>).status;
    const st = String(statusVal).toUpperCase();
    if (st === "ERROR" || st === "FAILED") {
      return {
        error: new ServiceError("soroban_tx_rejected", "Soroban transaction was rejected.", 422, {
          contractId: context.contractId,
        }),
        retryable: false,
        cause: "tx_rejected",
      };
    }
    if (st === "TRY_AGAIN_LATER") {
      return {
        error: new ServiceError(
          "soroban_try_again_later",
          "Soroban RPC asked to try again later.",
          503,
          { contractId: context.contractId }
        ),
        retryable: true,
        cause: "try_again_later",
      };
    }
  }

  // Fallback: generic RPC error, mark retryable (network/backpressure)
  return {
    error: new ServiceError("soroban_rpc_error", "Soroban RPC error.", 502, {
      contractId: context.contractId,
    }),
    retryable: true,
    cause: "rpc_error",
  };
}

export default mapSorobanError;
