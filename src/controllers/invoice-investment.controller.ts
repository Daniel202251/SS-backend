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

        const { walletAddress, amount, ledgerSequence } = req.body;
        if (walletAddress !== user.stellarAddress) {
          throw new AppError(
            403,
            "walletAddress must be the authenticated investor's own wallet",
            "WALLET_MISMATCH"
          );
        }

        const { investment, funding } = await investmentService.investInInvoice({
          invoiceId: req.params.id,
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

    async refund(req: AuthenticatedRequest & { params: { id: string } }, res: Response, next: NextFunction): Promise<void> {
      try {
        const user = req.user;
        if (!user) {
          throw new HttpError(401, "Authentication required");
        }

        requireApprovedKYC(user);

        const result = await investmentService.refundExpiredInvoiceInvestment({
          invoiceId: req.params.id,
          investorId: user.id,
          walletAddress: user.stellarAddress,
        });

        res.status(200).json({
          success: true,
          data: result,
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
