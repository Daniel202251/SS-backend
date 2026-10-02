import { Router, type NextFunction, type Request, type Response } from "express";

import { createAuthMiddleware } from "@/middleware/auth.middleware";
import type { AuthService } from "@/services/auth.service";
import {
  ADMIN_USER_LIST_MAX_LIMIT,
  type AdminUserService,
  type AdminUserStatusFilter,
} from "@/services/admin-user.service";
import type { AuthenticatedRequest } from "@/types/auth";
import { UserType } from "@/types/enums";
import { AppError, HttpError } from "@/utils/http-error";

/** Allows the request only for an authenticated user whose current role is admin. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).user;
  if (!user) {
    next(new HttpError(401, "Authentication required"));
    return;
  }
  if (user.userType !== UserType.ADMIN) {
    next(new AppError(403, "Admin role required.", "ADMIN_REQUIRED"));
    return;
  }
  next();
}

function parseListQuery(query: Request["query"]) {
  const { role, status, cursor, limit } = query;

  if (role !== undefined && !Object.values(UserType).includes(role as UserType)) {
    throw new AppError(400, "Invalid role filter.", "INVALID_ROLE", {
      allowedRoles: Object.values(UserType),
    });
  }
  if (status !== undefined && status !== "active" && status !== "suspended") {
    throw new AppError(400, "status must be 'active' or 'suspended'.", "INVALID_STATUS");
  }
  if (cursor !== undefined && typeof cursor !== "string") {
    throw new AppError(400, "Invalid pagination cursor.", "INVALID_CURSOR");
  }

  let parsedLimit: number | undefined;
  if (limit !== undefined) {
    parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > ADMIN_USER_LIST_MAX_LIMIT) {
      throw new AppError(
        400,
        `limit must be an integer between 1 and ${ADMIN_USER_LIST_MAX_LIMIT}.`,
        "INVALID_LIMIT"
      );
    }
  }

  return {
    role: role as UserType | undefined,
    status: status as AdminUserStatusFilter | undefined,
    cursor: cursor as string | undefined,
    limit: parsedLimit,
  };
}

function reasonFrom(body: unknown): string | null {
  const reason = (body as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" ? reason : null;
}

function actorFrom(req: Request) {
  const user = (req as AuthenticatedRequest).user!;
  return { id: user.id, stellarAddress: user.stellarAddress };
}

export function createAdminUsersRouter(
  adminUserService: AdminUserService,
  authService: AuthService
): Router {
  const router = Router();

  // Role is loaded from the database on every request, so a role change
  // applies to the user's very next request.
  router.use(createAuthMiddleware(authService), requireAdmin);

  router.get("/", async (req, res) => {
    const result = await adminUserService.listUsers(parseListQuery(req.query));
    res.json({
      success: true,
      data: result.items,
      meta: {
        limit: result.limit,
        hasNextPage: result.nextCursor !== null,
        nextCursor: result.nextCursor,
      },
    });
  });

  router.get("/:id", async (req, res) => {
    res.json({ success: true, data: await adminUserService.getUser(req.params.id) });
  });

  router.patch("/:id/role", async (req, res) => {
    const role = (req.body as { role?: unknown } | undefined)?.role;
    if (typeof role !== "string") {
      throw new AppError(400, "role is required.", "INVALID_ROLE", {
        allowedRoles: Object.values(UserType),
      });
    }
    const user = await adminUserService.updateRole(
      actorFrom(req),
      req.params.id,
      role as UserType,
      reasonFrom(req.body)
    );
    res.json({ success: true, data: user });
  });

  router.patch("/:id/suspend", async (req, res) => {
    const user = await adminUserService.suspend(actorFrom(req), req.params.id, reasonFrom(req.body));
    res.json({ success: true, data: user });
  });

  router.patch("/:id/unsuspend", async (req, res) => {
    const user = await adminUserService.unsuspend(
      actorFrom(req),
      req.params.id,
      reasonFrom(req.body)
    );
    res.json({ success: true, data: user });
  });

  return router;
}
