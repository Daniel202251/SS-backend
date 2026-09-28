import { Router, Response, NextFunction } from "express";

import { createAuthMiddleware, requireRole } from "../middleware/auth.middleware";
import { logger } from "../observability/logger";
import type { AuthService } from "../services/auth.service";
import type { RoyaltyEarningsService } from "../services/royalty-earnings.service";
import { UserType } from "../types/enums";
import { AppError } from "../utils/http-error";
import type { AuthenticatedRequest } from "../types/auth";

export interface RoyaltiesRouterDependencies {
  royaltyEarningsService: RoyaltyEarningsService;
  authService: AuthService;
}

const DEFAULT_TRANSFER_LIMIT = 50;
const DEFAULT_HISTORY_LIMIT = 20;

function parseBoundedInt(
  raw: unknown,
  fallback: number,
  max: number
): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * Royalty endpoints for invoice creators (issue #537).
 *
 *   GET /royalties/earnings - Lifetime accruals, claims and the claimable
 *                             balance for the authenticated creator, plus the
 *                             per-transfer breakdown of every royalty event.
 *   GET /royalties/history  - Royalties the creator has claimed, newest first,
 *                             with the on-chain transaction that paid them.
 *
 * Both routes are creator-only: a seller (or `both`) account must hold a valid
 * JWT, and the figures are always scoped to that token's wallet so one creator
 * can never read another's earnings.
 */
export function createRoyaltiesRouter({
  royaltyEarningsService,
  authService,
}: RoyaltiesRouterDependencies): Router {
  const router = Router();

  const requireAuth = createAuthMiddleware(authService);
  const requireCreator = requireRole([UserType.SELLER, UserType.BOTH]);

  router.get(
    "/earnings",
    requireAuth,
    requireCreator,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        const creatorWallet = req.user?.stellarAddress;
        if (!creatorWallet) {
          next(new AppError(401, "Authentication required.", "UNAUTHENTICATED"));
          return;
        }

        const transferLimit = parseBoundedInt(
          req.query.transfer_limit,
          DEFAULT_TRANSFER_LIMIT,
          200
        );
        const earnings = await royaltyEarningsService.getEarnings(creatorWallet, { transferLimit });

        res.status(200).json({ success: true, data: earnings });
      } catch (error) {
        logger.error("GET /royalties/earnings failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to retrieve royalty earnings", "ROYALTY_EARNINGS_ERROR")
        );
      }
    }
  );

  router.get(
    "/history",
    requireAuth,
    requireCreator,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        const creatorWallet = req.user?.stellarAddress;
        if (!creatorWallet) {
          next(new AppError(401, "Authentication required.", "UNAUTHENTICATED"));
          return;
        }

        const limit = parseBoundedInt(req.query.limit, DEFAULT_HISTORY_LIMIT, 100);
        const cursor = req.query.cursor ? String(req.query.cursor) : null;
        const page = await royaltyEarningsService.getClaimHistory(creatorWallet, { limit, cursor });

        res.status(200).json({
          success: true,
          data: page.items,
          meta: { hasMore: page.hasMore, nextCursor: page.nextCursor, limit },
        });
      } catch (error) {
        logger.error("GET /royalties/history failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(
          error instanceof AppError
            ? error
            : new AppError(500, "Failed to retrieve royalty claim history", "ROYALTY_HISTORY_ERROR")
        );
      }
    }
  );

  return router;
}
