import { Response } from "express";
import { SettlementService } from "../services/settlement.service";
import { AuthenticatedRequest } from "../types/auth";

export class SettlementController {
  constructor(private readonly settlementService: SettlementService) {}

  settleInvoice = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const invoiceId = req.params.invoiceId as string;
      const { proceeds } = req.body;

      if (!proceeds) {
        return res.status(400).json({
          error: {
            code: "MISSING_FIELDS",
            message: "proceeds is required",
          },
        });
      }

      const result = await this.settlementService.settleInvoice({
        invoiceId,
        proceeds,
        actorWallet: req.user.stellarAddress,
        sellerId: req.user.id,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      const statusCode =
        (err as { statusCode?: number }).statusCode || (err as { status?: number }).status || 400;
      return res.status(statusCode).json({
        error: {
          code: (err as { code?: string }).code || "INTERNAL_ERROR",
          message: (err as { message?: string }).message || "Internal server error",
        },
      });
    }
  };
}
