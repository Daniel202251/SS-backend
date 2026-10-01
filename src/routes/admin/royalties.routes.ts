import { Router, Request, Response, NextFunction } from "express";
import { RoyaltyAnalyticsService } from "../../services/royalty-analytics.service";
import { AppError } from "../../utils/http-error";
import { logger } from "../../observability/logger";

export interface RoyaltiesRouterDependencies {
  royaltyAnalyticsService: RoyaltyAnalyticsService;
}

/**
 * GET /admin/royalties/analytics
 *
 * Returns platform-wide royalty analytics:
 *  - Total royalties collected
 *  - Top 10 earning creators by royalty amount
 *  - Royalty volume per key (sorted descending)
 *
 * Query params (all optional):
 *   - from  ISO datetime string to filter paidAt >= from
 *   - to    ISO datetime string to filter paidAt <= to
 *
 * Access: Admin-only (enforced by the IP whitelist middleware on the admin router)
 */
export function createAdminRoyaltiesRouter({
  royaltyAnalyticsService,
}: RoyaltiesRouterDependencies): Router {
  const router = Router();

  router.get(
    "/analytics",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const from = req.query.from ? new Date(String(req.query.from)) : undefined;
        const to = req.query.to ? new Date(String(req.query.to)) : undefined;

        if (from && isNaN(from.getTime())) {
          next(new AppError(400, "Invalid 'from' date format. Use ISO 8601.", "INVALID_DATE_FROM"));
          return;
        }
        if (to && isNaN(to.getTime())) {
          next(new AppError(400, "Invalid 'to' date format. Use ISO 8601.", "INVALID_DATE_TO"));
          return;
        }

        const result = await royaltyAnalyticsService.getAnalytics({ from, to });

        res.status(200).json({
          success: true,
          data: result,
        });
      } catch (error) {
        logger.error("GET /admin/royalties/analytics failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to retrieve royalty analytics", "ROYALTY_ANALYTICS_ERROR")
        );
      }
    }
  );

  return router;
}
