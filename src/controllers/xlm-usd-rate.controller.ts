import type { Request, Response, NextFunction } from "express";

import type { XlmUsdRateService } from "../services/xlm-usd-rate.service";

export function createXlmUsdRateController(xlmUsdRateService: XlmUsdRateService) {
  return {
    async getXlmUsdRate(_req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const rate = await xlmUsdRateService.getCurrentRate();
        res.status(200).json({
          success: true,
          data: rate,
        });
      } catch (error) {
        next(error);
      }
    },
  };
}
