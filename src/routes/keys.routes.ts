import { Router, Request, Response, NextFunction } from "express";
import { RatingsLeaderboardService } from "../services/ratings-leaderboard.service";
import { AppError } from "../utils/http-error";
import { logger } from "../observability/logger";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { CreatorKeyService } from "../services/creator-key.service";
import type { CurveMigrationService } from "../services/curve-migration.service";
import { UserType } from "../types/enums";
import type { AuthenticatedRequest } from "../types/auth";

export interface KeysRouterDependencies {
  ratingsLeaderboardService?: RatingsLeaderboardService;
  authService?: AuthService;
  /** Issue #542 — buy limit and key detail projections. */
  creatorKeyService?: CreatorKeyService;
  /** Issue #544 — pending/executed curve migrations for a key. */
  curveMigrationService?: CurveMigrationService;
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
/** Accepted values for the `status` query filter on curve migrations. */
const MIGRATION_STATUS_FILTERS = new Set(["all", "pending", "executed"]);

/** Creator roles are the only ones allowed to see pending curve migrations. */
function isCreatorRole(userType: unknown): boolean {
  return userType === UserType.SELLER || userType === UserType.BOTH;
}

export function createKeysRouter({
  ratingsLeaderboardService,
  authService,
  creatorKeyService,
  curveMigrationService,
}: KeysRouterDependencies): Router {
  const router = Router();

  if (ratingsLeaderboardService) {
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

          const result = await ratingsLeaderboardService!.getLeaderboard(limit, minRatingCountOverride);

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
  }

  // ---- GET /keys/:id — key detail, including the current buy limit ----
  // Public: a buyer needs the buy cap and key metadata before they hold a token,
  // and nothing here is wallet specific (issue #542).
  if (creatorKeyService) {
    router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
      try {
        const detail = await creatorKeyService.getKeyDetail(String(req.params.id));
        res.status(200).json({ success: true, data: detail });
      } catch (error) {
        next(error);
      }
    });

    // ---- GET /keys/:id/buy-limit — per-transaction and per-day caps ----
    router.get("/:id/buy-limit", async (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = await creatorKeyService.getBuyLimit(String(req.params.id));
        res.status(200).json({ success: true, data: limit });
      } catch (error) {
        next(error);
      }
    });
  }

  // ---- GET /keys/:id/curve-migrations — pending and executed migrations ----
  // Executed migrations are public history; *pending* ones are the creator's
  // in-flight change, so they are only visible to the creator (issue #544).
  if (curveMigrationService) {
    const requireAuth = authService
      ? createAuthMiddleware(authService)
      : (_req: Request, _res: Response, next: NextFunction) => next();

    router.get(
      "/:id/curve-migrations",
      requireAuth,
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const status = req.query.status ? String(req.query.status) : "all";
          if (!MIGRATION_STATUS_FILTERS.has(status)) {
            next(
              new AppError(
                400,
                `Invalid 'status' filter. Use one of: ${[...MIGRATION_STATUS_FILTERS].join(", ")}.`,
                "INVALID_STATUS"
              )
            );
            return;
          }

          const result = await curveMigrationService.listForKey(String(req.params.id));
          const isCreator = isCreatorRole(req.user?.userType);

          // Asking for the pending list outright is a creator-only request.
          if (status === "pending" && !isCreator) {
            next(
              new AppError(403, "Only the key creator can see pending migrations.", "FORBIDDEN")
            );
            return;
          }

          if (isCreator) {
            res.status(200).json({ success: true, data: result });
            return;
          }

          // Everyone else still gets published history, just without the
          // in-flight proposals.
          res.status(200).json({
            success: true,
            data: { pending: [], executed: result.executed, total: result.executed.length },
          });
        } catch (error) {
          logger.error("GET /keys/:id/curve-migrations failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          next(error);
        }
      }
    );
  }

  return router;
}
