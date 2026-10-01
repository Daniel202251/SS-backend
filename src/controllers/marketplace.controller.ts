import type { Request, Response, NextFunction } from "express";
import Joi from "joi";
import type {
  MarketplaceService,
  MarketplaceFilters,
  PaginationOptions,
} from "../services/marketplace.service";
import { InvoiceStatus } from "../types/enums";
import { HttpError } from "../utils/http-error";
import { ServiceError } from "../utils/service-error";

const getInvoicesSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  cursor: Joi.string().trim().allow(null, "").optional(),
  status: Joi.alternatives()
    .try(
      Joi.string(),
      Joi.array().items(Joi.string())
    )
    .optional(),
  filter: Joi.string().optional(),
  dueBefore: Joi.date().iso().optional(),
  minAmount: Joi.number().min(0).optional(),
  maxAmount: Joi.number().min(0).optional(),
  sort: Joi.string().optional().default("amount"),
  sortOrder: Joi.string().valid("ASC", "DESC", "asc", "desc").default("DESC"),
  search: Joi.string().trim().max(255).optional(),
});

export interface GetInvoicesRequest extends Request {
  query: {
    page?: string;
    limit?: string;
    cursor?: string;
    status?: string | string[];
    filter?: string;
    dueBefore?: string;
    minAmount?: string;
    maxAmount?: string;
    sort?: string;
    sortOrder?: string;
    search?: string;
  };
}

export function createMarketplaceController(marketplaceService: MarketplaceService) {
  return {
    async getInvoices(req: GetInvoicesRequest, res: Response, next: NextFunction): Promise<void> {
      try {
        // Validate query parameters
        const { error, value } = getInvoicesSchema.validate(req.query, {
          stripUnknown: true,
          convert: true,
        });

        if (error) {
          throw new HttpError(400, `Invalid query parameters: ${error.message}`);
        }

        let sort = value.sort;
        let sortOrder = (value.sortOrder || "DESC").toUpperCase() as "ASC" | "DESC";

        if (sort === "deadline_asc") {
          sort = "due_date";
          sortOrder = "ASC";
        } else if (sort === "yield_desc") {
          sort = "discount_rate";
          sortOrder = "DESC";
        } else if (sort === "amount_desc") {
          sort = "amount";
          sortOrder = "DESC";
        } else if (!["due_date", "discount_rate", "amount", "created_at"].includes(sort)) {
          sort = "amount";
        }

        const rawStatus = value.status || value.filter;
        let mappedStatus: InvoiceStatus[] | undefined;
        if (rawStatus) {
          const arr = Array.isArray(rawStatus) ? rawStatus : [rawStatus];
          mappedStatus = arr.map((s: string) => {
            const lower = s.toLowerCase();
            if (lower === "open") return InvoiceStatus.PUBLISHED;
            return s as InvoiceStatus;
          });
        }

        // Parse and normalize filters
        const normalizedSort = (sort || "created_at") as "due_date" | "discount_rate" | "amount" | "created_at";
        const filters: MarketplaceFilters = {
          status: mappedStatus,
          dueBefore: value.dueBefore,
          minAmount: value.minAmount,
          maxAmount: value.maxAmount,
          sort: normalizedSort,
          sortOrder,
          search: value.search,
        };

        // Validate amount range
        if (filters.minAmount !== undefined && filters.maxAmount !== undefined) {
          if (filters.minAmount > filters.maxAmount) {
            throw new HttpError(400, "minAmount cannot be greater than maxAmount");
          }
        }

        if (value.cursor !== undefined) {
          const cursorResult = await marketplaceService.getPublishedInvoicesByCursor(
            filters,
            {
              sortField: normalizedSort,
              order: sortOrder,
              limit: value.limit,
              cursor: value.cursor || null,
            }
          );

          res.status(200).json({
            success: true,
            data: cursorResult.data,
            nextCursor: cursorResult.nextCursor,
            hasMore: cursorResult.hasMore,
          });
          return;
        }

        const pagination: PaginationOptions = {
          page: value.page,
          limit: value.limit,
        };

        const result = await marketplaceService.getPublishedInvoices(filters, pagination);

        res.status(200).json({
          success: true,
          data: result.data,
          meta: result.meta,
        });
      } catch (error) {
        if (error instanceof ServiceError) {
          next(new HttpError(error.statusCode, error.message));
          return;
        }

        next(error);
      }
    },
  };
}
