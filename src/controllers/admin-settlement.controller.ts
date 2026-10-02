import { Response } from "express";
import { AdminSettlementService } from "../services/admin-settlement.service";
import { AuthenticatedRequest } from "../types/auth";
import { ServiceError } from "../utils/service-error";

export class AdminSettlementController {
  constructor(private readonly adminSettlementService: AdminSettlementService) {}

  settleInvoice = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({
          error: {
            code: "FORBIDDEN",
            message: "Admin access required",
          },
        });
      }

      const invoiceId = req.params.invoiceId as string;
      const { repaymentAmount } = req.body;

      if (repaymentAmount === undefined || repaymentAmount === null) {
        return res.status(400).json({
          error: {
            code: "MISSING_FIELDS",
            message: "repaymentAmount is required",
          },
        });
      }

      const result = await this.adminSettlementService.settleInvoice({
        invoiceId,
        repaymentAmount: String(repaymentAmount),
        actorWallet: req.user.stellarAddress,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: unknown) {
      if (err instanceof ServiceError) {
        return res.status(err.statusCode).json({
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
          },
        });
      }

      const statusCode =
        (err as { statusCode?: number }).statusCode || (err as { status?: number }).status || 500;
      return res.status(statusCode).json({
        error: {
          code: (err as { code?: string }).code || "INTERNAL_ERROR",
          message: (err as { message?: string }).message || "Internal server error",
        },
      });
    }
  };
}