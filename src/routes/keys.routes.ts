import { Router, Request, Response, NextFunction } from "express";
import { RatingsLeaderboardService } from "../services/ratings-leaderboard.service";
import { AppError } from "../utils/http-error";
import { logger } from "../observability/logger";

export interface KeysRouterDependencies {
  ratingsLeaderboardService: RatingsLeaderboardService;
}

/**
 * GET /keys/ratings-leaderboard
 *
 * Returns top N creator keys ranked by average holder rating.
 * Keys below the minimum rating count threshold are excluded.
 * Results are cached with a 5-minute TTL.
 *
 * Query params:
 *   - limit   (optional, default 50, max 100)
 *   - minCount (optional, overrides LEADERBOARD_MIN_RATING_COUNT env var)
 */
export function createKeysRouter({ ratingsLeaderboardService }: KeysRouterDependencies): Router {
  const router = Router();

  router.get(
    "/ratings-leaderboard",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const rawLimit = parseInt(String(req.query.limit ?? "50"), 10);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;

        const rawMin = req.query.minCount !== undefined
          ? parseInt(String(req.query.minCount), 10)
          : undefined;
        const minRatingCountOverride =
          rawMin !== undefined && Number.isFinite(rawMin) && rawMin >= 0 ? rawMin : undefined;

        const result = await ratingsLeaderboardService.getLeaderboard(limit, minRatingCountOverride);

        res.status(200).json({
          success: true,
          data: result.data,
          meta: result.meta,
        });
      } catch (error) {
        logger.error("GET /keys/ratings-leaderboard failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to retrieve ratings leaderboard", "LEADERBOARD_ERROR")
        );
      }
    }
  );

  return router;
}
