import type { NextFunction, Response } from "express";
import type { InvestmentService } from "../services/investment.service";
import type { AuthenticatedRequest } from "../types/auth";
import { KYCError, requireApprovedKYC } from "../lib/kyc";
import { AppError, HttpError, PublicAppError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";

export interface InvestInInvoiceRequest extends AuthenticatedRequest {
  params: { id: string };
  body: {
    walletAddress: string;
    amount: string;
    ledgerSequence?: number;
  };
}

export function createInvoiceInvestmentController(investmentService: InvestmentService) {
  return {
    /**
     * POST /api/v1/invoices/:id/invest — buy a fractional share of an invoice.
     */
    async invest(req: InvestInInvoiceRequest, res: Response, next: NextFunction): Promise<void> {
      try {
        const user = req.user;
        if (!user) {
          throw new HttpError(401, "Authentication required");
        }

        requireApprovedKYC(user);

        const { amount, ledgerSequence } = req.body;
        const walletAddress = req.body.walletAddress || user.stellarAddress;
        if (walletAddress !== user.stellarAddress) {
          throw new AppError(
            403,
            "walletAddress must be the authenticated investor's own wallet",
            "WALLET_MISMATCH"
          );
        }

        const params = req.params as Record<string, string | undefined>;
        const invoiceId = params.id || params.invoiceId || "";
        const { investment, funding } = await investmentService.investInInvoice({
          invoiceId,
          investorId: user.id,
          walletAddress,
          amount,
          ledgerSequence,
        });

        res.status(201).json({
          success: true,
          data: {
            investment: {
              id: investment.id,
              invoiceId: investment.invoiceId,
              investorWallet: investment.investorWallet,
              investmentAmount: investment.investmentAmount,
              expectedReturn: investment.expectedReturn,
              status: investment.status,
              fundingBlock: investment.fundingBlock,
              createdAt: investment.createdAt,
            },
            funding,
          },
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(
            new PublicAppError(
              error.statusCode,
              error.message,
              error.code.toUpperCase(),
              error.details
            )
          );
          return;
        }
        if (error instanceof KYCError) {
          next(new AppError(error.statusCode, error.message, error.code));
          return;
        }
        next(error);
      }
    },
  };
}
