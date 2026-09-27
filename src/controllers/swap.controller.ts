import type { NextFunction, Request, Response } from "express";
import Joi from "joi";

import type { AuthenticatedRequest } from "../types/auth";
import type { AtomicSwapService } from "../services/atomic-swap.service";
import { HttpError } from "../utils/http-error";

const historyQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(25),
  cursor: Joi.string().max(512).allow("").optional(),
}).unknown(true);

export interface SwapRequest extends Request {
  params: { id: string };
  query: { limit?: string; cursor?: string };
}

export function createSwapController(swapService: AtomicSwapService) {
  return {
    /**
     * GET /swaps/history — cursor-paginated swaps for the authenticated wallet
     * as either buyer or seller.
     */
    async getHistory(req: SwapRequest, res: Response, next: NextFunction): Promise<void> {
      try {
        const { error, value } = historyQuerySchema.validate(req.query, {
          stripUnknown: true,
          convert: true,
        });
        if (error) {
          throw new HttpError(400, `Invalid query parameters: ${error.message}`);
        }

        const wallet = (req as AuthenticatedRequest).user?.stellarAddress;
        if (!wallet) {
          throw new HttpError(401, "Authentication required.");
        }

        const result = await swapService.listForWallet(wallet, {
          limit: value.limit,
          cursor: value.cursor ? String(value.cursor) : null,
        });

        res.status(200).json({ success: true, data: result.data, meta: result.meta });
      } catch (err) {
        next(err);
      }
    },

    /** GET /swaps/:id — public single swap lookup. */
    async getSwap(req: SwapRequest, res: Response, next: NextFunction): Promise<void> {
      try {
        const data = await swapService.getSwap(req.params.id);
        res.status(200).json({ success: true, data });
      } catch (err) {
        next(err);
      }
    },
  };
}
