import { Router } from "express";
import type { MarketplaceService } from "../services/marketplace.service";
import { createMarketplaceController } from "../controllers/marketplace.controller";

export interface MarketplaceRouterDependencies {
  marketplaceService: MarketplaceService;
}

export function createMarketplaceRouter({
  marketplaceService,
}: MarketplaceRouterDependencies): Router {
  const router = Router();
  const controller = createMarketplaceController(marketplaceService);

  // GET /api/v1/marketplace & /api/v1/marketplace/invoices - List published invoices
  router.get("/", controller.getInvoices);
  router.get("/invoices", controller.getInvoices);

  return router;
}
