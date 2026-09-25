import { Router, type RequestHandler } from "express";
import { createSecondaryMarketController } from "../controllers/secondary-market.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { SecondaryMarketService } from "../services/secondary-market.service";

export interface SecondaryMarketRouterDependencies {
  secondaryMarketService: SecondaryMarketService;
  authService: AuthService;
}

export function createSecondaryMarketRouter({
  secondaryMarketService,
  authService,
}: SecondaryMarketRouterDependencies): Router {
  const router = Router();
  const controller = createSecondaryMarketController(secondaryMarketService);
  const authMiddleware = createAuthMiddleware(authService);

  router.post("/listings", authMiddleware as RequestHandler, controller.createListing as RequestHandler);
  router.get("/listings", controller.getListings as RequestHandler);
  router.post("/listings/:id/buy", authMiddleware as RequestHandler, controller.buyListing as RequestHandler);
  router.post("/listings/:id/cancel", authMiddleware as RequestHandler, controller.cancelListing as RequestHandler);
  router.delete("/listings/:id", authMiddleware as RequestHandler, controller.cancelListing as RequestHandler);

  return router;
}
