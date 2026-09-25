import { Router, Request, Response, NextFunction, type RequestHandler } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import Joi from "joi";
import type { InvoiceService } from "../services/invoice.service";
import type { AppConfig } from "../config/env";
import { createInvoiceController } from "../controllers/invoice.controller";
import { createInvoiceInvestmentController } from "../controllers/invoice-investment.controller";
import { authenticateJWT, createAuthMiddleware, requireKYC } from "../middleware/auth.middleware";
import { checkContractNotPaused } from "../middleware/contract-pause-guard.middleware";
import type { AuthService } from "../services/auth.service";
import type { InvestmentService } from "../services/investment.service";
import type { ContractGuardService } from "../services/stellar/contract-guard.service";
import { isValidStellarPublicKey } from "../utils/stellar-address.utils";
import { createWalletRateLimiter } from "../middleware/rate-limit-wallet.middleware";
import { HttpError } from "../utils/http-error";
import { InvoiceStatus } from "../types/enums";
import { InvoiceCacheService, createInvoiceCacheService } from "../services/invoice-cache.service";

export interface InvoiceRouterDependencies {
  invoiceService: InvoiceService;
  config: AppConfig;
  /** Both required to mount POST /:id/invest. */
  investmentService?: InvestmentService;
  authService?: AuthService;
  contractGuardService?: ContractGuardService;
  contractId?: string | null;
  cacheService?: InvoiceCacheService;
}

/**
 * Joi schemas for invoice validation
 */
const createInvoiceSchema = Joi.object({
  invoiceNumber: Joi.string().required().trim().max(64),
  customerName: Joi.string().required().trim().max(255),
  amount: Joi.string()
    .required()
    .pattern(/^\d+(\.\d{1,4})?$/)
    .messages({
      "string.pattern.base": "amount must be a decimal number with max 4 decimal places",
    }),
  discountRate: Joi.string()
    .required()
    .pattern(/^\d+(\.\d{1,2})?$/)
    .custom((value, helpers) => {
      const num = parseFloat(value);
      if (num > 100) {
        return helpers.error("any.invalid");
      }
      return value;
    })
    .messages({
      "any.invalid": "discountRate must be a percentage (0-100) with max 2 decimal places",
    }),
  dueDate: Joi.date().iso().required(),
  ipfsHash: Joi.string().optional().trim().max(128),
  riskScore: Joi.string()
    .optional()
    .pattern(/^\d+(\.\d{1,2})?$/)
    .custom((value, helpers) => {
      const num = parseFloat(value);
      if (num > 100) {
        return helpers.error("any.invalid");
      }
      return value;
    })
    .messages({
      "any.invalid": "riskScore must be a percentage (0-100) with max 2 decimal places",
    }),
});

const updateInvoiceSchema = Joi.object({
  customerName: Joi.string().optional().trim().max(255),
  amount: Joi.string()
    .optional()
    .pattern(/^\d+(\.\d{1,4})?$/)
    .messages({
      "string.pattern.base": "amount must be a decimal number with max 4 decimal places",
    }),
  discountRate: Joi.string()
    .optional()
    .pattern(/^\d+(\.\d{1,2})?$/)
    .max(100)
    .messages({
      "string.pattern.base": "discountRate must be a percentage (0-100) with max 2 decimal places",
    }),
  dueDate: Joi.date().iso().optional(),
  riskScore: Joi.string()
    .optional()
    .pattern(/^\d+(\.\d{1,2})?$/)
    .max(100),
});

const batchPublishSchema = Joi.object({
  invoiceIds: Joi.array()
    .items(Joi.string().uuid().required())
    .min(1)
    .max(100)
    .required()
    .messages({
      "array.min": "invoiceIds must contain at least one invoice id",
      "array.max": "invoiceIds must contain at most 100 invoice ids",
      "string.guid": "invoiceIds must contain valid invoice ids",
    }),
});

const getInvoicesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string()
    .valid(...Object.values(InvoiceStatus))
    .optional(),
});

const calculateTermsSchema = Joi.object({
  faceValue: Joi.alternatives()
    .try(Joi.string().pattern(/^\d+(\.\d{1,4})?$/), Joi.number().positive())
    .required()
    .messages({
      "alternatives.match":
        "faceValue must be a positive number or decimal string with max 4 decimal places",
    }),
  dueDate: Joi.date().iso().required(),
  discountBps: Joi.number().integer().min(0).max(10000).required(),
  platformFeeBps: Joi.number().integer().min(0).max(10000).optional().default(0),
  referenceDate: Joi.date().iso().optional(),
});

const investSchema = Joi.object({
  walletAddress: Joi.string()
    .trim()
    .required()
    .custom((value, helpers) =>
      isValidStellarPublicKey(value) ? value : helpers.error("any.invalid")
    )
    .messages({ "any.invalid": "walletAddress must be a valid Stellar public key" }),
  amount: Joi.alternatives()
    .try(
      Joi.string()
        .trim()
        .pattern(/^\d+(\.\d{1,4})?$/),
      Joi.number().positive()
    )
    .required()
    .custom((value) => String(value))
    .messages({
      "alternatives.match": "amount must be a positive decimal with at most 4 decimal places",
    }),
  ledgerSequence: Joi.number().integer().min(1).optional(),
});

/**
 * Validation middleware factory
 */
function validateBody(schema: Joi.Schema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req.body, {
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      return next(new HttpError(400, `Invalid request: ${error.message}`));
    }

    req.body = value;
    next();
  };
}

function validateQuery(schema: Joi.Schema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req.query, {
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      return next(new HttpError(422, `Invalid query parameters: ${error.message}`));
    }

    // Replace req.query with validated value
    // In Express, req.query is a getter/setter by default, but we can override it
    // if we use the default query parser.
    Object.keys(req.query).forEach((key) => delete req.query[key]);
    Object.assign(req.query, value);
    next();
  };
}

export function createInvoiceRouter({
  invoiceService,
  config,
  investmentService,
  authService,
  contractGuardService,
  contractId = null,
  cacheService,
}: InvoiceRouterDependencies): Router {
  const router = Router();
  const cache =
    cacheService ??
    (config.cache?.enabled !== false
      ? createInvoiceCacheService({
          redisUrl: config.cache?.redisUrl,
          listTtlSeconds: config.cache?.invoicesListTtlSeconds,
          detailTtlSeconds: config.cache?.invoiceDetailTtlSeconds,
          enabled: config.cache?.enabled,
        })
      : undefined);
  const controller = createInvoiceController(invoiceService, cache);

  // Configure multer for file uploads
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.ipfs.maxFileSizeMB * 1024 * 1024, // Convert MB to bytes
    },
    fileFilter: (req, file, cb) => {
      if (config.ipfs.allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`File type ${file.mimetype} is not allowed`));
      }
    },
  });

  // Rate limiting for document uploads
  const uploadRateLimit = rateLimit({
    windowMs: config.ipfs.uploadRateLimit.windowMs,
    max: config.ipfs.uploadRateLimit.maxUploads,
    message: {
      error: {
        code: "rate_limit_exceeded",
        message: `Too many upload attempts. Maximum ${config.ipfs.uploadRateLimit.maxUploads} uploads per ${config.ipfs.uploadRateLimit.windowMs / (60 * 1000)} minutes.`,
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const kycGating = requireKYC(config.kyc.skipVerification);

  // Per-wallet rate limit: max 5 invoice publishes per 60 seconds
  const publishRateLimiter = createWalletRateLimiter(
    { windowMs: 60_000, maxRequests: 5 },
    "invoice-publish"
  );

  // ============ INVOICE CRUD ENDPOINTS ============

  // GET /api/v1/invoices - List invoices for authenticated seller
  router.get("/", authenticateJWT, validateQuery(getInvoicesQuerySchema), controller.getInvoices);

  // POST /api/v1/invoices - Create new invoice
  router.post(
    "/",
    authenticateJWT,
    kycGating,
    validateBody(createInvoiceSchema),
    controller.createInvoice
  );

  // POST /api/v1/invoices/batch-publish - Publish several drafts atomically.
  // Declared ahead of the "/:id" routes so "batch-publish" is never matched as
  // an invoice id.
  router.post(
    "/batch-publish",
    authenticateJWT,
    kycGating,
    publishRateLimiter,
    validateBody(batchPublishSchema),
    controller.batchPublishInvoices
  );

  // GET /api/v1/invoices/:id - Get single invoice
  router.get("/:id", authenticateJWT, controller.getInvoice);

  // PUT /api/v1/invoices/:id - Update invoice
  router.put(
    "/:id",
    authenticateJWT,
    kycGating,
    validateBody(updateInvoiceSchema),
    controller.updateInvoice
  );

  // DELETE /api/v1/invoices/:id - Delete invoice
  router.delete("/:id", authenticateJWT, kycGating, controller.deleteInvoice);

  // POST /api/v1/invoices/:id/publish - Publish invoice
  router.post(
    "/:id/publish",
    authenticateJWT,
    kycGating,
    publishRateLimiter,
    controller.publishInvoice
  );

  // POST /api/v1/invoices/:id/submit - Submit a draft for admin review (draft → pending)
  router.post("/:id/submit", authenticateJWT, kycGating, controller.submitInvoiceForReview);

  // GET /api/v1/invoices/:id/history - Status transition history, oldest first
  router.get("/:id/history", authenticateJWT, controller.getInvoiceStatusHistory);

  // POST /api/v1/invoices/:id/document - Upload document
  router.post(
    "/:id/document",
    uploadRateLimit,
    authenticateJWT,
    kycGating,
    upload.single("document"),
    controller.uploadDocument
  );

  // POST /api/v1/invoices/:id/invest - Buy a fractional share of an invoice.
  // Same gating as POST /api/v1/investments: full user lookup (for KYC),
  // contract pause guard and the per-wallet investment rate limit.
  if (investmentService && authService) {
    const investController = createInvoiceInvestmentController(investmentService);
    const pauseGuard: RequestHandler[] = contractGuardService
      ? [checkContractNotPaused({ contractGuardService, contractId })]
      : [];
    const investRateLimiter = createWalletRateLimiter(
      { windowMs: 60_000, maxRequests: 10 },
      "invoice-invest"
    );

    router.post(
      "/:id/invest",
      createAuthMiddleware(authService),
      ...pauseGuard,
      investRateLimiter,
      validateBody(investSchema),
      investController.invest as RequestHandler
    );

    router.post(
      "/:id/refund",
      createAuthMiddleware(authService),
      ...pauseGuard,
      investController.refund as RequestHandler
    );
  }

  // GET /api/v1/invoices/:id/tokens - Get invoice token holders
  router.get("/:id/tokens", authenticateJWT, controller.getInvoiceTokenHolders);

  // GET /api/v1/invoices/:id/escrow - Get invoice escrow status
  router.get("/:id/escrow", authenticateJWT, controller.getInvoiceEscrowStatus);

  // POST /api/v1/invoices/calculate-terms - Calculate invoice discounting terms, fees, and APR
  router.post("/calculate-terms", validateBody(calculateTermsSchema), controller.calculateTerms);

  return router;
}
