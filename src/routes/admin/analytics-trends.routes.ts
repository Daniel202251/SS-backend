import { Router, Request, Response, NextFunction } from "express";
import { AnalyticsSnapshotService } from "../../services/analytics-snapshot.service";
import { AppError } from "../../utils/http-error";
import { logger } from "../../observability/logger";

export interface AnalyticsTrendsRouterDependencies {
  analyticsSnapshotService: AnalyticsSnapshotService;
}

/**
 * GET /admin/analytics/trends
 *
 * Returns daily platform metric snapshots for a date range.
 * Missing dates in the range are returned as null in the data array.
 *
 * Query params:
 *   - from  (required) Date string "YYYY-MM-DD" or ISO datetime
 *   - to    (required) Date string "YYYY-MM-DD" or ISO datetime
 *
 * Access: Admin-only (enforced by the IP whitelist middleware on the admin router)
 */
export function createAdminAnalyticsTrendsRouter({
  analyticsSnapshotService,
}: AnalyticsTrendsRouterDependencies): Router {
  const router = Router();

  router.get(
    "/trends",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const fromStr = String(req.query.from ?? "");
        const toStr = String(req.query.to ?? "");

        if (!fromStr) {
          next(new AppError(400, "'from' date parameter is required.", "MISSING_FROM_DATE"));
          return;
        }
        if (!toStr) {
          next(new AppError(400, "'to' date parameter is required.", "MISSING_TO_DATE"));
          return;
        }

        const from = new Date(fromStr);
        const to = new Date(toStr);

        if (isNaN(from.getTime())) {
          next(new AppError(400, "Invalid 'from' date format. Use YYYY-MM-DD or ISO 8601.", "INVALID_DATE_FROM"));
          return;
        }
        if (isNaN(to.getTime())) {
          next(new AppError(400, "Invalid 'to' date format. Use YYYY-MM-DD or ISO 8601.", "INVALID_DATE_TO"));
          return;
        }
        if (from > to) {
          next(new AppError(400, "'from' date must not be after 'to' date.", "INVALID_DATE_RANGE"));
          return;
        }

        // Clamp to maximum 365 days to prevent runaway queries
        const diffDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
        if (diffDays > 365) {
          next(new AppError(400, "Date range cannot exceed 365 days.", "DATE_RANGE_TOO_LARGE"));
          return;
        }

        const result = await analyticsSnapshotService.getTrends(from, to);

        res.status(200).json({
          success: true,
          data: result.data,
          dates: result.dates,
          meta: result.meta,
        });
      } catch (error) {
        logger.error("GET /admin/analytics/trends failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to retrieve analytics trends", "ANALYTICS_TRENDS_ERROR")
        );
      }
    }
  );

  return router;
}
