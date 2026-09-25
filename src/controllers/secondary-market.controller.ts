import type { NextFunction, Request, Response } from "express";
import Joi from "joi";
import type { AuthenticatedRequest } from "../types/auth";
import type { SecondaryMarketService } from "../services/secondary-market.service";
import { KYCError, requireApprovedKYC } from "../lib/kyc";
import { AppError, HttpError, PublicAppError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";

const createListingSchema = Joi.object({
  invoiceId: Joi.string().uuid().required(),
  quantity: Joi.string().trim().required(),
  price: Joi.string().trim().required(),
});

const buyListingSchema = Joi.object({
  quantity: Joi.string().trim().required(),
  paymentAmount: Joi.string().trim().optional(),
});

export function createSecondaryMarketController(secondaryMarketService: SecondaryMarketService) {
  return {
    async createListing(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
      try {
        const user = req.user;
        if (!user) {
          throw new HttpError(401, "Authentication required");
        }

        requireApprovedKYC(user);

        const { error, value } = createListingSchema.validate(req.body, {
          stripUnknown: true,
          convert: true,
        });
        if (error) {
          throw new HttpError(400, `Invalid listing payload: ${error.message}`);
        }

        const result = await secondaryMarketService.createListing({
          invoiceId: value.invoiceId,
          sellerId: user.id,
          quantity: String(value.quantity),
          price: String(value.price),
        });

        res.status(201).json({ success: true, data: result });
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

    async getListings(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const invoiceId =
          typeof req.query.invoiceId === "string"
            ? req.query.invoiceId
            : typeof req.query.invoice_id === "string"
              ? req.query.invoice_id
              : undefined;
        const result = await secondaryMarketService.getListings(invoiceId);
        res.status(200).json({ success: true, data: result });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new PublicAppError(error.statusCode, error.message, error.code.toUpperCase(), error.details));
          return;
        }
        next(error);
      }
    },

    async buyListing(req: AuthenticatedRequest & { params: { id: string } }, res: Response, next: NextFunction): Promise<void> {
      try {
        const user = req.user;
        if (!user) {
          throw new HttpError(401, "Authentication required");
        }

        requireApprovedKYC(user);

        const { error, value } = buyListingSchema.validate(req.body, {
          stripUnknown: true,
          convert: true,
        });
        if (error) {
          throw new HttpError(400, `Invalid purchase payload: ${error.message}`);
        }

        const result = await secondaryMarketService.buyListing({
          listingId: req.params.id,
          buyerId: user.id,
          buyerWallet: user.stellarAddress,
          quantity: String(value.quantity),
          paymentAmount: value.paymentAmount ? String(value.paymentAmount) : undefined,
        });

        res.status(200).json({ success: true, data: result });
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

    async cancelListing(req: AuthenticatedRequest & { params: { id: string } }, res: Response, next: NextFunction): Promise<void> {
      try {
        const user = req.user;
        if (!user) {
          throw new HttpError(401, "Authentication required");
        }

        requireApprovedKYC(user);

        const result = await secondaryMarketService.cancelListing(req.params.id, user.id);
        res.status(200).json({ success: true, data: result });
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
