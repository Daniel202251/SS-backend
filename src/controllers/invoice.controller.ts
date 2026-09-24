import type { Request, Response, NextFunction } from "express";
import type { InvoiceService } from "../services/invoice.service";
import { HttpError, PublicAppError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";
import { AuthenticatedRequest } from "../types/auth";
import { InvoiceStatus } from "@/types/enums";
import { calculateInvoiceTerms } from "../utils/discount-calculator.utils";

export interface UploadDocumentRequest extends Request {
  params: {
    id: string;
  };
  file?: Express.Multer.File;
}

export interface CreateInvoiceRequest extends AuthenticatedRequest {
  body: {
    invoiceNumber: string;
    customerName: string;
    amount: string;
    discountRate: string;
    dueDate: string;
    ipfsHash?: string;
    riskScore?: string;
  };
}

export interface UpdateInvoiceRequest extends AuthenticatedRequest {
  params: {
    id: string;
  };
  body: {
    customerName?: string;
    amount?: string;
    discountRate?: string;
    dueDate?: string;
    riskScore?: string;
  };
}

export interface GetInvoicesRequest extends AuthenticatedRequest {
  query: {
    page?: string;
    limit?: string;
    status?: string;
  };
}

export interface PublishInvoiceRequest extends AuthenticatedRequest {
  params: {
    id: string;
  };
}

export interface BatchPublishInvoicesRequest extends AuthenticatedRequest {
  body: {
    invoiceIds: string[];
  };
}

const TRANSITION_ERROR_CODES = new Set([
  "invalid_status_transition",
  "transition_not_permitted",
  "transition_precondition_failed",
  "invoice_not_publishable",
]);

/**
 * State machine rejections carry the from/to statuses and the allowed next
 * statuses; surface them as a structured error instead of a bare message.
 */
function toTransitionError(error: ServiceError): PublicAppError | null {
  return TRANSITION_ERROR_CODES.has(error.code)
    ? new PublicAppError(error.statusCode, error.message, error.code.toUpperCase(), error.details)
    : null;
}

export function createInvoiceController(invoiceService: InvoiceService) {
  return {
    async createInvoice(
      req: CreateInvoiceRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const { invoiceNumber, customerName, amount, discountRate, dueDate, ipfsHash, riskScore } =
          req.body;

        const result = await invoiceService.createInvoice({
          sellerId: req.user.id,
          invoiceNumber,
          customerName,
          amount,
          discountRate,
          dueDate: new Date(dueDate),
          ipfsHash,
          riskScore,
        });

        res.status(201).json({
          success: true,
          data: result,
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },

    async getInvoices(req: GetInvoicesRequest, res: Response, next: NextFunction): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 20;
        const status = req.query.status;

        // Validate pagination
        if (page < 1 || limit < 1 || limit > 100) {
          throw new HttpError(400, "Invalid pagination parameters");
        }

        const result = await invoiceService.getInvoicesBySellerId({
          sellerId: req.user.id,
          status: status as InvoiceStatus | undefined,
          skip: (page - 1) * limit,
          take: limit,
        });

        res.status(200).json({
          success: true,
          data: result.invoices,
          meta: {
            total: result.total,
            page,
            limit,
            totalPages: Math.ceil(result.total / limit),
          },
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },

    async getInvoice(
      req: Request & { params: { id: string } },
      res: Response,
      next: NextFunction
    ): Promise<void> {
      try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.user) {
          throw new HttpError(401, "Authentication required");
        }

        const { id } = req.params;

        try {
          const result = await invoiceService.getInvoiceById(id, authReq.user.id);

          if (!result) {
            throw new HttpError(404, "Invoice not found");
          }

          res.status(200).json({
            success: true,
            data: result,
          });
        } catch (error) {
          if (error instanceof ServiceError && error.statusCode === 403) {
            // Return 404 instead of 403 to prevent info leakage
            throw new HttpError(404, "Invoice not found");
          }
          throw error;
        }
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },

    async updateInvoice(
      req: UpdateInvoiceRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const { id } = req.params;
        const { customerName, amount, discountRate, dueDate, riskScore } = req.body;

        const result = await invoiceService.updateInvoice({
          sellerId: req.user.id,
          invoiceId: id,
          customerName,
          amount,
          discountRate,
          dueDate: dueDate ? new Date(dueDate) : undefined,
          riskScore,
        });

        res.status(200).json({
          success: true,
          data: result,
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          if (error.statusCode === 403) {
            // Return 404 instead of 403 to prevent info leakage
            next(new HttpError(404, "Invoice not found"));
            return;
          }
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },

    async deleteInvoice(
      req: Request & { params: { id: string } },
      res: Response,
      next: NextFunction
    ): Promise<void> {
      try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.user) {
          throw new HttpError(401, "Authentication required");
        }

        const { id } = req.params;

        await invoiceService.deleteInvoice(id, authReq.user.id);

        res.status(204).send();
      } catch (error) {
        if (error instanceof ServiceError) {
          if (error.statusCode === 403) {
            // Return 404 instead of 403 to prevent info leakage
            next(new HttpError(404, "Invoice not found"));
            return;
          }
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },

    async submitInvoiceForReview(
      req: PublishInvoiceRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const result = await invoiceService.submitInvoiceForReview({
          invoiceId: req.params.id,
          sellerId: req.user.id,
        });

        res.status(200).json({ success: true, data: result });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(toTransitionError(error) ?? new HttpError(error.statusCode, error.message));
          return;
        }
        next(error);
      }
    },

    async getInvoiceStatusHistory(
      req: PublishInvoiceRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const history = await invoiceService.getInvoiceStatusHistory(req.params.id, req.user.id);

        res.status(200).json({ success: true, data: history });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new HttpError(error.statusCode, error.message));
          return;
        }
        next(error);
      }
    },

    async publishInvoice(
      req: PublishInvoiceRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const { id } = req.params;

        const result = await invoiceService.publishInvoice({
          invoiceId: id,
          sellerId: req.user.id,
        });

        res.status(200).json({
          success: true,
          data: result,
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          const transitionError = toTransitionError(error);
          if (transitionError) {
            next(transitionError);
            return;
          }
          if (error.statusCode === 403) {
            // Return 404 instead of 403 to prevent info leakage
            next(new HttpError(404, "Invoice not found"));
            return;
          }
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },

    async batchPublishInvoices(
      req: BatchPublishInvoicesRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        const result = await invoiceService.publishInvoicesBatch({
          invoiceIds: req.body.invoiceIds,
          sellerId: req.user.id,
        });

        res.status(200).json({
          success: true,
          data: result,
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          // Per-invoice rejections are the point of the endpoint: the seller
          // needs to see every problem at once, so they are passed through as
          // error details rather than collapsed into a message.
          next(new HttpError(error.statusCode, error.message, error.details));
          return;
        }

        next(error);
      }
    },

    async uploadDocument(
      req: UploadDocumentRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        if (!req.file) {
          throw new HttpError(400, "No file uploaded");
        }

        const { id: invoiceId } = req.params;
        const sellerId = req.user.id;

        const result = await invoiceService.uploadDocument({
          invoiceId,
          sellerId,
          fileBuffer: req.file.buffer,
          filename: req.file.originalname,
          mimeType: req.file.mimetype,
        });

        res.status(200).json({
          success: true,
          data: result,
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },

    async getInvoiceTokenHolders(
      req: Request & { params: { id: string } },
      res: Response,
      next: NextFunction
    ): Promise<void> {
      try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.user) {
          throw new HttpError(401, "Authentication required");
        }

        const { id } = req.params;

        const result = await invoiceService.getInvoiceTokenHolders(id, authReq.user.id);

        res.status(200).json({
          success: true,
          data: result,
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },

    async getInvoiceEscrowStatus(
      req: Request & { params: { id: string } },
      res: Response,
      next: NextFunction
    ): Promise<void> {
      try {
        const { id } = req.params;

        const result = await invoiceService.getInvoiceEscrowStatus(id);

        res.status(200).json({
          success: true,
          data: result,
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },

    async calculateTerms(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const { faceValue, dueDate, discountBps, platformFeeBps, referenceDate } = req.body;

        const terms = calculateInvoiceTerms({
          faceValue,
          dueDate,
          discountBps: Number(discountBps),
          platformFeeBps: platformFeeBps !== undefined ? Number(platformFeeBps) : 0,
          referenceDate,
        });

        res.status(200).json({
          success: true,
          data: terms,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to calculate invoice terms";
        next(new HttpError(400, message));
      }
    },
  };
}
