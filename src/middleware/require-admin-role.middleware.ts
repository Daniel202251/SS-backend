import type { NextFunction, Request, Response } from "express";

import { HttpError } from "../utils/http-error";
import { AdminRole } from "../types/enums";
import type { AuthenticatedRequest } from "../types/auth";

/**
 * Role gate for administrative endpoints (issue #543).
 *
 * There is no dedicated admin user model yet, so roles travel on the JWT the
 * same way `userType` does: `userType: "admin"` (or a `role: "admin"` claim
 * surfaced by `authenticateJWT`). Unauthenticated requests get 401;
 * authenticated non-admins get 403.
 */
export const DEFAULT_ADMIN_ROLES: readonly AdminRole[] = [AdminRole.ADMIN];

export function requireAdminRole(roles: readonly AdminRole[] = DEFAULT_ADMIN_ROLES) {
  const allowed = new Set<string>(roles.map((role) => String(role).toLowerCase()));

  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      next(new HttpError(401, "Authentication required."));
      return;
    }

    const role =
      (user as { userType?: unknown; role?: unknown }).userType ??
      (user as { role?: unknown }).role;
    if (typeof role !== "string" || !allowed.has(role.toLowerCase())) {
      next(new HttpError(403, "Admin access required."));
      return;
    }

    next();
  };
}
