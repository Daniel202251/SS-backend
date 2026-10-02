import { Response } from "express";
import { InvestmentService } from "../services/investment.service";
import { AuthenticatedRequest } from "../types/auth";
import { requireApprovedKYC } from "../lib/kyc";

export class InvestmentController {
  constructor(private readonly investmentService: InvestmentService) {}

  createInvestment = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Enforce KYC check
      requireApprovedKYC(user);

      const { invoiceId, investmentAmount } = req.body;

      if (!invoiceId || !investmentAmount) {
        return res.status(400).json({
          error: {
            code: "MISSING_FIELDS",
            message: "invoiceId and investmentAmount are required",
          },
        });
      }

      const investment = await this.investmentService.createInvestment({
        invoiceId,
        investorId: user.id,
        investmentAmount,
        investorWallet: user.stellarAddress,
      });

      return res.status(201).json({
        success: true,
        data: investment,
      });
    } catch (err: unknown) {
      const statusCode =
        (err as { status?: number }).status || (err as { statusCode?: number }).statusCode || 400;
      return res.status(statusCode).json({
        error: {
          code: (err as { code?: string }).code || "INTERNAL_ERROR",
          message: (err as { message?: string }).message || "Internal server error",
        },
      });
    }
  };

  getDashboard = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const dashboard = await this.investmentService.getInvestorDashboard(user.id);

      return res.status(200).json({
        success: true,
        data: dashboard,
      });
    } catch (err: unknown) {
      const statusCode =
        (err as { status?: number }).status || (err as { statusCode?: number }).statusCode || 500;
      return res.status(statusCode).json({
        error: {
          code: (err as { code?: string }).code || "INTERNAL_ERROR",
          message: (err as { message?: string }).message || "Internal server error",
        },
      });
    }
  };

  getInvestorAnalytics = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const analytics = await this.investmentService.calculateInvestorAnalytics(user.id);

      return res.status(200).json({
        success: true,
        data: analytics,
      });
    } catch (err: unknown) {
      const statusCode =
        (err as { status?: number }).status || (err as { statusCode?: number }).statusCode || 500;
      return res.status(statusCode).json({
        error: {
          code: (err as { code?: string }).code || "INTERNAL_ERROR",
          message: (err as { message?: string }).message || "Internal server error",
        },
      });
    }
  };
}
