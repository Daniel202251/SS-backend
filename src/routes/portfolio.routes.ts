import { Router, type Response, type NextFunction } from "express";
import { createAuthMiddleware, requireInvestor } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { PortfolioService } from "../services/portfolio.service";
import type { AuthenticatedRequest } from "../types/auth";
import { ServiceError } from "../utils/service-error";
import { HttpError, PublicAppError } from "../utils/http-error";

export interface PortfolioRouterDependencies {
  authService: AuthService;
  portfolioService: PortfolioService;
}

/**
 * GET /portfolio — investor portfolio summary with P&L (issue #479).
 */
export function createPortfolioRouter({
  authService,
  portfolioService,
}: PortfolioRouterDependencies): Router {
  const router = Router();
  const auth = createAuthMiddleware(authService);

  router.get(
    "/",
    auth,
    requireInvestor(),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = req.user!;
        const cursor =
          typeof req.query.cursor === "string" && req.query.cursor.length > 0
            ? req.query.cursor
            : null;
        const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
        const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

        const page = await portfolioService.getPortfolio(user.id, { cursor, limit });
        res.status(200).json({ success: true, data: page });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new PublicAppError(error.statusCode, error.message, error.code, error.details));
          return;
        }
        if (error instanceof HttpError) {
          next(error);
          return;
        }
        next(error);
      }
    }
  );

  return router;
}
