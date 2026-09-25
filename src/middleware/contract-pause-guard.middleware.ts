import type { NextFunction, Request, Response } from "express";
import type { ContractGuardService } from "../services/stellar/contract-guard.service";
import type { AppLogger } from "../observability/logger";
import { logger as globalLogger } from "../observability/logger";

import { AppError } from "../utils/http-error";

export interface ContractPauseGuardOptions {
  contractGuardService: ContractGuardService;
  /** Contract to check. When null the guard is inert and every request passes. */
  contractId: string | null;
  logger?: AppLogger;
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
 * Read-only endpoints should not use this guard. Browsing the marketplace
 * during a pause is harmless, and blocking it would hide the state of the
 * system from the people who need to see it.
 */
export function checkContractNotPaused({
  contractGuardService,
  contractId,
  logger = globalLogger,
}: ContractPauseGuardOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!contractId) {
      next();
      return;
    }

    try {
      const paused = await contractGuardService.checkContractPauseState(contractId);

      if (paused) {
        logger.warn("Request blocked: smart contract is paused", {
          contract_id: contractId,
          method: req.method,
          path: req.originalUrl ?? req.path,
        });

        res.status(503).json({
          success: false,
          error: {
            code: "CONTRACT_PAUSED",
            message: "Smart contract operations are currently paused by administration.",
          },
        });
        return;
      }

      next();
    } catch (error) {
      logger.error('Failed to process', { error });
      next(new AppError(500, 'Processing failed', 'PROCESSING_FAILED'));
    }
  };
}
