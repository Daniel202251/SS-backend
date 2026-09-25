import type { NextFunction, Request, Response } from "express";
import { Contract } from "stellar-sdk";
import type { ContractGuardService } from "../services/stellar/contract-guard.service";
import type { AppLogger } from "../observability/logger";
import { logger as globalLogger } from "../observability/logger";
import { AppError } from "../utils/http-error";

/**
 * Upper bound on a pause-state read. The service has no timeout of its own on
 * the RPC call, and because it shares one in-flight read per contract, a hung
 * node would otherwise stall every guarded request at once.
 */
export const DEFAULT_PAUSE_CHECK_TIMEOUT_MS = 3_000;

/**
 * Seconds a blocked client should wait before retrying. Matches the service's
 * pause-state cache lifetime, so a retry after this long sees a fresh reading.
 */
export const PAUSED_RETRY_AFTER_SECONDS = 15;

export interface ContractPauseGuardOptions {
  contractGuardService: ContractGuardService;
  /** Contract to check. When null the guard is inert and every request passes. */
  contractId: string | null;
  logger?: AppLogger;
  /** Override for the pause-state read timeout. */
  timeoutMs?: number;
}

class PauseCheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Contract pause state check timed out after ${timeoutMs}ms`);
    this.name = "PauseCheckTimeoutError";
  }
}

/**
 * Normalises and validates the configured contract id up front.
 *
 * A malformed id would otherwise make every ledger-key build throw inside the
 * service, which degrades to "assume not paused" — the guard would silently
 * stop guarding. Failing at startup surfaces the misconfiguration instead.
 */
function normaliseContractId(contractId: string | null | undefined): string | null {
  if (contractId === null || contractId === undefined) {
    return null;
  }
  if (typeof contractId !== "string") {
    throw new Error("Contract pause guard contractId must be a string or null.");
  }

  const trimmed = contractId.trim();
  if (!trimmed) {
    return null;
  }
  try {
    // Same constructor the service uses to build the ledger key.
    new Contract(trimmed);
  } catch {
    throw new Error("Contract pause guard contractId is not a valid Soroban contract id.");
  }
  return trimmed;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PauseCheckTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Request path without the query string, which can carry sensitive values. */
function requestPath(req: Request): string {
  const url = req.originalUrl ?? req.path ?? "";
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * Blocks requests while the underlying Soroban contract is paused.
 *
 * When contracts are paused on-chain — during a security investigation, say —
 * any funding, investment or settlement call the API accepts would fail at
 * submission time anyway, after the user has already committed to it. Rejecting
 * up front with a 503 is both faster and clearer than letting the request reach
 * the chain and bounce.
 *
 * 503 rather than 403: this is a temporary, whole-system condition the caller
 * can retry out of, not a permission problem with their request.
 *
 * If the pause state cannot be determined — the read throws unexpectedly or
 * exceeds `timeoutMs` — the request fails with 503 `CONTRACT_PAUSE_CHECK_FAILED`
 * rather than being waved through on an unknown state.
 *
 * Read-only endpoints should not use this guard. Browsing the marketplace
 * during a pause is harmless, and blocking it would hide the state of the
 * system from the people who need to see it.
 */
export function checkContractNotPaused({
  contractGuardService,
  contractId,
  logger = globalLogger,
  timeoutMs = DEFAULT_PAUSE_CHECK_TIMEOUT_MS,
}: ContractPauseGuardOptions) {
  const guardedContractId = normaliseContractId(contractId);

  if (guardedContractId && typeof contractGuardService?.checkContractPauseState !== "function") {
    throw new Error("Contract pause guard requires a contractGuardService.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Contract pause guard timeoutMs must be a positive integer.");
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!guardedContractId) {
      next();
      return;
    }

    const startedAt = Date.now();
    let paused: boolean;
    try {
      paused = await withTimeout(
        Promise.resolve().then(() =>
          contractGuardService.checkContractPauseState(guardedContractId)
        ),
        timeoutMs
      );
    } catch (error) {
      // The service already degrades gracefully on RPC failure, so reaching
      // here means something unexpected broke or the read hung. Fail the
      // request rather than waving it through on an unknown pause state.
      const timedOut = error instanceof PauseCheckTimeoutError;
      logger.error("Contract pause state check failed; rejecting request", {
        contract_id: guardedContractId,
        method: req.method,
        path: requestPath(req),
        reason: timedOut ? "timeout" : "error",
        duration_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });

      next(
        new AppError(
          503,
          "Unable to verify smart contract status. Please try again shortly.",
          "CONTRACT_PAUSE_CHECK_FAILED"
        )
      );
      return;
    }

    if (!paused) {
      next();
      return;
    }

    logger.warn("Request blocked: smart contract is paused", {
      contract_id: guardedContractId,
      method: req.method,
      path: requestPath(req),
    });

    if (res.headersSent) {
      return;
    }

    res.setHeader("Retry-After", String(PAUSED_RETRY_AFTER_SECONDS));
    res.status(503).json({
      success: false,
      error: {
        code: "CONTRACT_PAUSED",
        message: "Smart contract operations are currently paused by administration.",
      },
    });
  };
}
