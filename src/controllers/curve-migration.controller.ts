import type { NextFunction, Request, Response } from "express";

import { AdminRole } from "../types/enums";
import type { AuthenticatedRequest } from "../types/auth";
import type { CreatorKeyService } from "../services/creator-key.service";
import type {
  CurveMigrationService,
  CurveMigrationView,
} from "../services/curve-migration.service";
import { HttpError } from "../utils/http-error";

export interface CurveMigrationRequest extends Request {
  params: { id: string };
  query: { status?: string };
}

const STATUS_VALUES = ["all", "pending", "executed"] as const;

export function createCurveMigrationController(
  creatorKeyService: CreatorKeyService,
  curveMigrationService: CurveMigrationService
) {
  return {
    /**
     * GET /keys/:id/curve-migrations
     *
     * Executed migrations are visible to any authenticated user; migrations
     * still sitting behind the timelock are creator-only, since a pending
     * proposal is a creator's pending governance action.
     */
    async getCurveMigrations(
      req: CurveMigrationRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> {
      try {
        const status = normalizeStatus(req.query.status);
        const isOwner = await isKeyCreator(req, creatorKeyService, req.params.id);

        if (status === "pending" && !isOwner) {
          throw new HttpError(403, "Creator access required.");
        }

        const result = await curveMigrationService.listForKey(req.params.id);
        const pending = isOwner ? result.pending : [];
        const executed = status === "pending" ? [] : result.executed;
        const data: CurveMigrationView[] =
          status === "executed"
            ? executed
            : status === "pending"
              ? pending
              : [...pending, ...executed];

        res.status(200).json({
          success: true,
          data: {
            pending,
            executed,
            items: data,
            total: data.length,
          },
        });
      } catch (error) {
        next(error);
      }
    },
  };
}

function normalizeStatus(status?: string): (typeof STATUS_VALUES)[number] {
  if (!status) return "all";
  const normalized = status.toLowerCase();
  if ((STATUS_VALUES as readonly string[]).includes(normalized)) {
    return normalized as (typeof STATUS_VALUES)[number];
  }
  throw new HttpError(400, `status must be one of: ${STATUS_VALUES.join(", ")}`);
}

async function isKeyCreator(
  req: Request,
  creatorKeyService: CreatorKeyService,
  keyId: string
): Promise<boolean> {
  const user = (req as AuthenticatedRequest).user;
  if (!user) return false;

  if (String(user.userType).toLowerCase() === AdminRole.ADMIN) return true;

  const detail = await creatorKeyService.getKeyDetail(keyId);
  const requester = user.stellarAddress?.toLowerCase();
  const candidates = [detail.creatorWallet, detail.creatorId].map((value) => value?.toLowerCase());

  return Boolean(requester && candidates.includes(requester));
}
