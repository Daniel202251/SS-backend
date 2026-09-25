import { Request, Response } from "express";
import { KycService } from "../services/kyc.service";
import { AuthenticatedRequest } from "../types/auth";
import { KYCStatus } from "../types/enums";

export function createKycController(service: KycService) {
  return {
    submit: async (req: AuthenticatedRequest, res: Response) => {
      if (!req.user) return res.status(401).json({ error: "Authentication required" });
      const verification = await service.submitKycVerification(req.user.id, req.body);
      return res.status(201).json({ success: true, data: verification });
    },
    status: async (req: AuthenticatedRequest, res: Response) => {
      if (!req.user) return res.status(401).json({ error: "Authentication required" });

      const status = await service.getKycStatusForUser(req.user.id);
      return res.status(200).json({ success: true, data: status });
    },
    review: async (req: Request, res: Response) => {
      const adminKey = req.headers["x-admin-key"];
      if (adminKey !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { status, reason, decision } = req.body ?? {};
      const nextStatus = (status ?? decision) as string | undefined;
      if (!nextStatus || ![KYCStatus.APPROVED, KYCStatus.REJECTED].includes(nextStatus as KYCStatus)) {
        return res.status(400).json({
          error: { code: "INVALID_KYC_STATUS", message: "Status must be approved or rejected." },
        });
      }

      const verification = await service.reviewKycVerification(req.params.id, {
        status: nextStatus as KYCStatus.APPROVED | KYCStatus.REJECTED,
        reason: typeof reason === "string" ? reason : null,
      });

      return res.status(200).json({ success: true, data: verification });
    },
    webhook: async (req: Request, res: Response) => {
      if (!Buffer.isBuffer(req.body)) {
        return res
          .status(400)
          .json({ error: { code: "RAW_BODY_REQUIRED", message: "Raw webhook body required" } });
      }
      const rawBody = req.body;
      if (!service.verifyWebhookSignature(rawBody, req.header("x-provider-signature"))) {
        return res.status(401).json({
          error: { code: "INVALID_WEBHOOK_SIGNATURE", message: "Invalid webhook signature" },
        });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return res
          .status(400)
          .json({ error: { code: "INVALID_WEBHOOK_PAYLOAD", message: "Invalid JSON payload" } });
      }
      await service.processWebhook(payload as Parameters<KycService["processWebhook"]>[0]);
      return res.status(204).send();
    },
  };
}
