import { Router, Response, NextFunction } from "express";

import { createAuthMiddleware } from "../middleware/auth.middleware";
import { logger } from "../observability/logger";
import type { AuthService } from "../services/auth.service";
import type { OnboardingService } from "../services/onboarding.service";
import { AppError } from "../utils/http-error";
import type { AuthenticatedRequest } from "../types/auth";

export interface OnboardingRouterDependencies {
  onboardingService: OnboardingService;
  authService: AuthService;
}

/**
 * Onboarding tour completion (issue #540).
 *
 *   GET  /onboarding/status   - Whether the authenticated wallet has finished
 *                               the tour, and when. Checked on app load.
 *   POST /onboarding/complete - Records that the authenticated wallet finished
 *                               the tour, with the server timestamp.
 *
 * Both routes require a JWT: onboarding state is personal to a wallet and there
 * is no public reason to expose it.
 */
export function createOnboardingRouter({
  onboardingService,
  authService,
}: OnboardingRouterDependencies): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(authService);

  router.get(
    "/status",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        const wallet = req.user?.stellarAddress;
        if (!wallet) {
          next(new AppError(401, "Authentication required.", "UNAUTHENTICATED"));
          return;
        }

        const status = await onboardingService.getStatus(wallet);

        res.status(200).json({ success: true, data: status });
      } catch (error) {
        logger.error("GET /onboarding/status failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to retrieve onboarding status", "ONBOARDING_STATUS_ERROR")
        );
      }
    }
  );

  router.post(
    "/complete",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        const wallet = req.user?.stellarAddress;
        if (!wallet) {
          next(new AppError(401, "Authentication required.", "UNAUTHENTICATED"));
          return;
        }

        const status = await onboardingService.markTourCompleted(wallet);

        res.status(200).json({ success: true, data: status });
      } catch (error) {
        logger.error("POST /onboarding/complete failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to record onboarding completion", "ONBOARDING_COMPLETE_ERROR")
        );
      }
    }
  );

  return router;
}
