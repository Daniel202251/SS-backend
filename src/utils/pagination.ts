import { Repository, DataSource, SelectQueryBuilder } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { InvoiceStatus } from "../types/enums";
import { paginateQuery } from "./query-pagination.utils";

export interface InvoiceFilters {
  sellerId?: string;
  status?: InvoiceStatus | InvoiceStatus[];
}

export type Database = DataSource | Repository<Invoice>;

/**
 * Invoice-specific cursor pagination, kept for backward compatibility with
 * existing callers/tests that expect this exact `{ data, has_more, next_cursor }`
 * shape and the legacy `"ISO_DATE|id"` cursor encoding.
 *
 * Internally this now composes the generic `paginateQuery` helper
 * (see `query-pagination.utils.ts`) instead of duplicating the keyset
 * pagination logic, so any future fix to the cursor mechanics only needs to
 * happen in one place.
 */
export async function queryInvoicesPage(
  filters: InvoiceFilters,
  cursor: string | null,
  limit: number,
  db: Database
): Promise<{ data: Invoice[]; has_more: boolean; next_cursor: string | null }> {
  let queryBuilder: SelectQueryBuilder<Invoice>;

  if (db instanceof DataSource) {
    queryBuilder = db.getRepository(Invoice).createQueryBuilder("invoice");
  } else {
    queryBuilder = db.createQueryBuilder("invoice");
  }

  queryBuilder.where("invoice.deletedAt IS NULL");

  if (filters.sellerId) {
    queryBuilder.andWhere("invoice.sellerId = :sellerId", { sellerId: filters.sellerId });
  }

  if (filters.status) {
    if (Array.isArray(filters.status)) {
      if (filters.status.length > 0) {
        queryBuilder.andWhere("invoice.status IN (:...statuses)", { statuses: filters.status });
      }
    } else {
      queryBuilder.andWhere("invoice.status = :status", { status: filters.status });
    }
  }

  // This endpoint's cursor uses a legacy "ISO_DATE|id" encoding (predating
  // the generic helper's own opaque JSON+base64 cursor format), so we decode
  // it here and translate into a single composite ordering key that
  // `paginateQuery` can filter on via `invoice.createdAt`. The `id`
  // tiebreaker is preserved as a secondary `addOrderBy` for stability when
  // multiple invoices share the same `createdAt`.
  if (cursor) {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const [createdAtStr, id] = decoded.split("|");
    const createdAt = new Date(createdAtStr);

    queryBuilder.andWhere(
      "(invoice.createdAt < :createdAt OR (invoice.createdAt = :createdAt AND invoice.id < :id))",
      { createdAt, id }
    );
  }

  queryBuilder.addOrderBy("invoice.id", "DESC");

  const { items, hasMore } = await paginateQuery<Invoice>({
    queryBuilder,
    cursorField: "invoice.createdAt",
    order: "DESC",
    limit,
    // Cursor filtering above is already applied manually (legacy composite
    // encoding), so we don't pass `cursor` through to `paginateQuery` again
    // — doing so would double-filter and additionally reject on the
    // generic helper's own cursor-field validation.
  });

  let nextCursor: string | null = null;
  if (items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = Buffer.from(`${lastItem.createdAt.toISOString()}|${lastItem.id}`).toString(
      "base64"
    );
  }

  return {
    data: items,
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}
