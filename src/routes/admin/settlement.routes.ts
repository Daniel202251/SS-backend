import { Router, type RequestHandler } from "express";
import { AdminSettlementController } from "../../controllers/admin-settlement.controller";
import type { AdminSettlementService } from "../../services/admin-settlement.service";
import { authenticateAdminJWT } from "../../middleware/admin-auth.middleware";

export interface AdminSettlementRouterDependencies {
  adminSettlementService: AdminSettlementService;
}

export function createAdminSettlementRouter({
  adminSettlementService,
}: AdminSettlementRouterDependencies): Router {
  const router = Router();
  const controller = new AdminSettlementController(adminSettlementService);

  // POST /api/v1/admin/invoices/:invoiceId/settle
  router.post(
    "/invoices/:invoiceId/settle",
    authenticateAdminJWT,
    controller.settleInvoice
  );

  return router;
}