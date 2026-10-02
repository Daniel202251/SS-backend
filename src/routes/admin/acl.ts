import type { Request, Response, NextFunction } from "express";

import type { AclService } from "../../services/acl.service";
import { HttpError } from "../../utils/http-error";

export interface AclQueryRequest extends Request {
  query: { limit?: string; offset?: string };
}

export function createAclController(aclService: AclService) {
  return {
    /** GET /admin/acl — current whitelist from synced ACLUpdated events. */
    async getAcl(_req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const data = await aclService.getAcl();
        res.status(200).json({ success: true, data });
      } catch (error) {
        next(error);
      }
    },

    /** GET /admin/acl/log — add/remove history for the whitelist. */
    async getAclLog(req: AclQueryRequest, res: Response, next: NextFunction): Promise<void> {
      try {
        const limit = parsePositiveInt(req.query.limit);
        const offset = parsePositiveInt(req.query.offset);

        const data = await aclService.getAclLog({ limit, offset });
        res.status(200).json({ success: true, data, meta: { count: data.length, limit, offset } });
      } catch (error) {
        next(error);
      }
    },
  };
}

function parsePositiveInt(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, "limit and offset must be non-negative integers.");
  }
  return parsed;
}
