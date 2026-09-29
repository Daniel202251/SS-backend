import { Router, type Response, type NextFunction } from "express";
import { createAuthMiddleware, requireInvestor } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { InvestorAcknowledgementService } from "../services/investor-acknowledgement.service";
import type { AuthenticatedRequest } from "../types/auth";
import { ServiceError } from "../utils/service-error";
import { HttpError, PublicAppError } from "../utils/http-error";

export interface InvestorRouterDependencies {
  authService: AuthService;
  acknowledgementService: InvestorAcknowledgementService;
}

/**
 * Investor accreditation acknowledgement endpoints (issue #473).
 * Mounted at /api/v1/investors.
 */
export function createInvestorRouter({
  authService,
  acknowledgementService,
}: InvestorRouterDependencies): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);

  router.post(
    "/acknowledge",
    auth,
    requireInvestor(),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = req.user!;
        const bodyVersion =
          typeof req.body?.termsVersion === "string" ? req.body.termsVersion : undefined;
        const row = await acknowledgementService.acknowledge({
          walletAddress: user.stellarAddress,
          userId: user.id,
          termsVersion: bodyVersion,
        });
        res.status(201).json({
          success: true,
          data: {
            id: row.id,
            walletAddress: row.walletAddress,
            termsVersion: row.termsVersion,
            acknowledgedAt: row.acknowledgedAt.toISOString(),
          },
        });
      } catch (error) {
        next(mapServiceError(error));
      }
    }
  );

  router.get(
    "/acknowledgement-status",
    auth,
    requireInvestor(),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = req.user!;
        const status = await acknowledgementService.getStatus(user.stellarAddress);
        res.status(200).json({ success: true, data: status });
      } catch (error) {
        next(mapServiceError(error));
      }
    }
  );

  return router;
}

function mapServiceError(error: unknown): unknown {
  if (error instanceof ServiceError) {
    return new PublicAppError(error.statusCode, error.message, error.code, error.details);
  }
  if (error instanceof HttpError) return error;
  return error;
}
