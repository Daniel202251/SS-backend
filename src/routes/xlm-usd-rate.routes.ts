import { Router } from "express";

import { createXlmUsdRateController } from "../controllers/xlm-usd-rate.controller";
import type { XlmUsdRateService } from "../services/xlm-usd-rate.service";

export interface XlmUsdRateRouterDependencies {
  xlmUsdRateService: XlmUsdRateService;
}

export function createXlmUsdRateRouter({
  xlmUsdRateService,
}: XlmUsdRateRouterDependencies): Router {
  const router = Router();
  const controller = createXlmUsdRateController(xlmUsdRateService);

  router.get("/xlm-usd", controller.getXlmUsdRate);

  return router;
}
