import type { Request, Response } from "express";
import Joi from "joi";

import {
  SEARCH_MAX_LIMIT,
  SEARCHABLE_STATUSES,
  type InvoiceSearchService,
} from "../services/invoice-search.service";
import type { InvoiceStatus } from "../types/enums";
import { PublicAppError } from "../utils/http-error";

const AMOUNT = Joi.string().pattern(/^\d+(\.\d{1,4})?$/);

export const invoiceSearchQuerySchema = Joi.object({
  q: Joi.string().trim().max(200).allow(""),
  /** One status or a comma-separated list; marketplace-visible statuses only. */
  status: Joi.string()
    .custom((value: string, helpers) => {
      const statuses = value.split(",").map((s) => s.trim()).filter(Boolean);
      if (
        statuses.length === 0 ||
        statuses.some((s) => !SEARCHABLE_STATUSES.includes(s as InvoiceStatus))
      ) {
        return helpers.error("any.invalid");
      }
      return [...new Set(statuses)];
    })
    .messages({ "any.invalid": `status must be one of: ${SEARCHABLE_STATUSES.join(", ")}` }),
  min_amount: AMOUNT,
  max_amount: AMOUNT,
  due_before: Joi.date().iso(),
  due_after: Joi.date().iso(),
  cursor: Joi.string().max(512),
  limit: Joi.number().integer().min(1).max(SEARCH_MAX_LIMIT),
})
  .custom((value, helpers) => {
    if (
      value.min_amount !== undefined &&
      value.max_amount !== undefined &&
      Number(value.min_amount) > Number(value.max_amount)
    ) {
      return helpers.message({ custom: "min_amount must not exceed max_amount" });
    }
    if (value.due_before && value.due_after && value.due_after > value.due_before) {
      return helpers.message({ custom: "due_after must not be later than due_before" });
    }
    return value;
  });

/**
 * GET /api/v1/invoices/search — public marketplace search. Full-text match on
 * issuer name and description (ranked by relevance) combined with status,
 * amount and due-date filters; cursor-paginated.
 */
export function createInvoiceSearchHandler(searchService: InvoiceSearchService) {
  return async (req: Request, res: Response): Promise<void> => {
    const { error, value } = invoiceSearchQuerySchema.validate(req.query, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      throw new PublicAppError(
        400,
        "Request validation failed.",
        "VALIDATION_ERROR",
        error.details.map((detail) => detail.message)
      );
    }

    const result = await searchService.search({
      q: value.q,
      status: value.status,
      minAmount: value.min_amount,
      maxAmount: value.max_amount,
      dueBefore: value.due_before,
      dueAfter: value.due_after,
      cursor: value.cursor,
      limit: value.limit,
    });

    res.json({
      success: true,
      data: result.items,
      meta: {
        limit: result.limit,
        hasNextPage: result.nextCursor !== null,
        nextCursor: result.nextCursor,
        ranked: Boolean(value.q?.trim()),
      },
    });
  };
}
