import { Router } from "express";
import type { SellerService } from "../services/seller.service";
import type { AuthService } from "../services/auth.service";
import { createSellerController } from "../controllers/seller.controller";
import { createAuthMiddleware, requireRole } from "../middleware/auth.middleware";
import { UserType } from "../types/enums";

export interface SellerRouterDependencies {
  sellerService: SellerService;
  authService: AuthService;
}

export function createSellerRouter({
  sellerService,
  authService,
}: SellerRouterDependencies): Router {
  const router = Router();
  const controller = createSellerController(sellerService);
  const authMiddleware = createAuthMiddleware(authService);
  const sellerRoleMiddleware = requireRole([UserType.SELLER, UserType.BOTH]);

  // GET /seller/dashboard - Seller summary statistics and owned invoices
  router.get("/dashboard", authMiddleware, sellerRoleMiddleware, controller.getDashboard);
  router.get("/", authMiddleware, sellerRoleMiddleware, controller.getDashboard);

  return router;
}
