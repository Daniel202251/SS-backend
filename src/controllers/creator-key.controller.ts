import type { Request, Response, NextFunction } from "express";
import type { CreatorKeyService } from "../services/creator-key.service";

export interface CreatorKeyRequest extends Request {
  params: { id: string };
}

export function createCreatorKeyController(creatorKeyService: CreatorKeyService) {
  return {
    /**
     * GET /keys/:id/buy-limit — public read, no auth required. The caps are
     * enforced on-chain, so exposing them is safe and lets the frontend clamp
     * the buy input before submitting a transaction.
     */
    async getBuyLimit(req: CreatorKeyRequest, res: Response, next: NextFunction): Promise<void> {
      try {
        const data = await creatorKeyService.getBuyLimit(req.params.id);
        res.status(200).json({ success: true, data });
      } catch (error) {
        next(error);
      }
    },

    /** GET /keys/:id — key detail, including the per-transaction buy limit. */
    async getKeyDetail(req: CreatorKeyRequest, res: Response, next: NextFunction): Promise<void> {
      try {
        const data = await creatorKeyService.getKeyDetail(req.params.id);
        res.status(200).json({ success: true, data });
      } catch (error) {
        next(error);
      }
    },
  };
}
