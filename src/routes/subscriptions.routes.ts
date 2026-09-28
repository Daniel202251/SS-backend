import { Router, Response, NextFunction } from "express";

import { logger } from "../observability/logger";
import type { SubscriptionStatusService } from "../services/subscription-status.service";
import { AppError } from "../utils/http-error";
import type { AuthenticatedRequest } from "../types/auth";

export interface SubscriptionsRouterDependencies {
  subscriptionStatusService: SubscriptionStatusService;
}

/** Stellar account (strkey) public key. */
const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;
/** Soroban contract id, or the shorter key identifier a contract may use. */
const KEY_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,127}$/i;

/**
 * Gated-content subscription status (issue #539).
 *
 *   GET /subscriptions/status?wallet=G…&key_id=C… - Whether the wallet holds
 *        the minimum key balance required for access, with the expiry ledger
 *        and the number of days remaining.
 *
 * This endpoint is deliberately unauthenticated: a content gate has to answer
 * before a visitor is known to the platform, and the answer reveals nothing
 * beyond public on-chain holdings. The response is cached for 30 seconds and
 * evicted as soon as a holding-change event is observed.
 */
export function createSubscriptionsRouter({
  subscriptionStatusService,
}: SubscriptionsRouterDependencies): Router {
  const router = Router();

  router.get(
    "/status",
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        const wallet = String(req.query.wallet ?? "").trim();
        const keyId = String(req.query.key_id ?? req.query.keyId ?? "").trim();

        if (!wallet) {
          next(new AppError(400, "'wallet' query parameter is required.", "MISSING_WALLET"));
          return;
        }
        if (!STELLAR_ADDRESS_PATTERN.test(wallet)) {
          next(
            new AppError(400, "'wallet' must be a valid Stellar address.", "INVALID_WALLET")
          );
          return;
        }
        if (!keyId) {
          next(new AppError(400, "'key_id' query parameter is required.", "MISSING_KEY_ID"));
          return;
        }
        if (!KEY_ID_PATTERN.test(keyId)) {
          next(
            new AppError(400, "'key_id' must be a valid contract or key identifier.", "INVALID_KEY_ID")
          );
          return;
        }

        const status = await subscriptionStatusService.getStatus({ wallet, keyId });

        res.status(200).json({ success: true, data: status });
      } catch (error) {
        logger.error("GET /subscriptions/status failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(
                500,
                "Failed to determine subscription status",
                "SUBSCRIPTION_STATUS_ERROR"
              )
        );
      }
    }
  );

  return router;
}
