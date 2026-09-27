import type { Response, NextFunction } from "express";
import type { SellerService } from "../services/seller.service";
import type { AuthenticatedRequest } from "../types/auth";
import { HttpError } from "../utils/http-error";

export function createSellerController(sellerService: SellerService) {
  return {
    async getDashboard(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
      try {
        const user = req.user;
        if (!user) {
          throw new HttpError(401, "Authentication required");
        }

        const data = await sellerService.getDashboard(user.id);

        res.status(200).json({
          success: true,
          data,
        });
      } catch (error) {
        next(error);
      }
    },
  };
}
