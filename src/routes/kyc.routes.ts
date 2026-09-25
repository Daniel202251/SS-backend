import express, { Router } from "express";
import { KycService } from "../services/kyc.service";
import { createKycController } from "../controllers/kyc.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";

export function createKycWebhookRouter(service: KycService): Router {
  const router = Router();
  const controller = createKycController(service);
  router.post(
    "/webhook",
    express.raw({ type: "application/json", limit: "256kb" }),
    controller.webhook
  );
  return router;
}

export function createKycRouter(service: KycService, authService: AuthService): Router {
  const router = Router();
  const controller = createKycController(service);
  router.post("/submit", createAuthMiddleware(authService), controller.submit);
  router.get("/status", createAuthMiddleware(authService), controller.status);
  router.patch("/:id/review", controller.review);
  return router;
}
