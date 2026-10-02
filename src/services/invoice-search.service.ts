import type { DataSource, SelectQueryBuilder } from "typeorm";
import { Invoice, type PublicInvoiceDTO } from "../models/Invoice.model";
import { InvoiceStatus } from "../types/enums";
import { AppError } from "../utils/http-error";

/** Statuses visible on the marketplace; drafts and review states never are. */
export const SEARCHABLE_STATUSES: readonly InvoiceStatus[] = [
  InvoiceStatus.PUBLISHED,
  InvoiceStatus.FUNDED,
  InvoiceStatus.SETTLED,
];

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;

export interface InvoiceSearchParams {
  q?: string;
  status?: InvoiceStatus[];
  minAmount?: string;
  maxAmount?: string;
  dueBefore?: Date;
  dueAfter?: Date;
  cursor?: string;
  limit?: number;
}

export interface InvoiceSearchHit extends PublicInvoiceDTO {
  /** ts_rank_cd relevance; present only when a query was given. */
  rank?: number;
}

export interface InvoiceSearchResult {
  items: InvoiceSearchHit[];
  limit: number;
  nextCursor: string | null;
}

/**
 * Keyset position. Ranked searches order by (rank DESC, created_at DESC,
 * id DESC); unranked ones by (created_at DESC, id DESC). A cursor records
 * whether it came from a ranked search so it can't be replayed against the
 * other ordering.
 */
interface SearchCursor {
  r?: number;
  c: string;
  i: string;
}

export function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeSearchCursor(raw: string, ranked: boolean): SearchCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const cursor = parsed as Partial<SearchCursor> | null;
  if (
    !cursor ||
    typeof cursor.c !== "string" ||
    Number.isNaN(Date.parse(cursor.c)) ||
    typeof cursor.i !== "string" ||
    (ranked ? typeof cursor.r !== "number" : cursor.r !== undefined)
  ) {
    throw invalidCursor();
  }
  return cursor as SearchCursor;
}

function invalidCursor(): AppError {
  return new AppError(400, "Invalid search cursor.", "INVALID_CURSOR");
}

/** websearch_to_tsquery accepts free text (quotes, "or", "-term") without syntax errors. */
const TS_QUERY = "websearch_to_tsquery('english', :q)";
// float8 so the rank round-trips exactly through the cursor (real does not).
const RANK_SQL = `ts_rank_cd(invoice.search_vector, ${TS_QUERY})::float8`;

export class InvoiceSearchService {
  constructor(private readonly dataSource: DataSource) {}

  async search(params: InvoiceSearchParams): Promise<InvoiceSearchResult> {
    const limit = Math.min(Math.max(params.limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
    const q = params.q?.trim() || undefined;
    const ranked = q !== undefined;

    const query = this.dataSource.getRepository(Invoice).createQueryBuilder("invoice");
    this.applyFilters(query, params);

    if (ranked) {
      // The GIN index on search_vector serves the @@ match.
      query
        .andWhere(`invoice.search_vector @@ ${TS_QUERY}`)
        .addSelect(RANK_SQL, "rank")
        .setParameter("q", q)
        .orderBy("rank", "DESC")
        .addOrderBy("invoice.createdAt", "DESC")
        .addOrderBy("invoice.id", "DESC");
    } else {
      query.orderBy("invoice.createdAt", "DESC").addOrderBy("invoice.id", "DESC");
    }

    if (params.cursor) {
      const cursor = decodeSearchCursor(params.cursor, ranked);
      const after = "(invoice.createdAt < :cursorCreatedAt OR (invoice.createdAt = :cursorCreatedAt AND invoice.id < :cursorId))";
      const cursorParams = { cursorCreatedAt: new Date(cursor.c), cursorId: cursor.i };
      if (ranked) {
        query.andWhere(
          `(${RANK_SQL} < :cursorRank OR (${RANK_SQL} = :cursorRank AND ${after}))`,
          { ...cursorParams, cursorRank: cursor.r }
        );
      } else {
        query.andWhere(after, cursorParams);
      }
    }

    // Raw + entities so the computed rank comes back alongside each row.
    query.limit(limit + 1);
    const { entities, raw } = await query.getRawAndEntities();

    const hits: InvoiceSearchHit[] = entities.slice(0, limit).map((invoice, index) => {
      const dto: InvoiceSearchHit = Invoice.toDTO(invoice);
      if (ranked) dto.rank = Number((raw[index] as { rank: string | number }).rank);
      return dto;
    });

    const last = hits[hits.length - 1];
    const nextCursor =
      entities.length > limit && last
        ? encodeSearchCursor({
            ...(ranked ? { r: last.rank } : {}),
            c: new Date(last.createdAt).toISOString(),
            i: last.id,
          })
        : null;

    return { items: hits, limit, nextCursor };
  }

  private applyFilters(query: SelectQueryBuilder<Invoice>, params: InvoiceSearchParams): void {
    const statuses = params.status?.length ? params.status : [InvoiceStatus.PUBLISHED];
    query.where("invoice.status IN (:...statuses)", { statuses });

    if (params.minAmount !== undefined) {
      query.andWhere("invoice.amount >= :minAmount", { minAmount: params.minAmount });
    }
    if (params.maxAmount !== undefined) {
      query.andWhere("invoice.amount <= :maxAmount", { maxAmount: params.maxAmount });
    }
    if (params.dueAfter) {
      query.andWhere("invoice.dueDate >= :dueAfter", { dueAfter: toDateOnly(params.dueAfter) });
    }
    if (params.dueBefore) {
      query.andWhere("invoice.dueDate <= :dueBefore", { dueBefore: toDateOnly(params.dueBefore) });
    }
  }
}

/** due_date is a DATE column; compare on the calendar day. */
function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function createInvoiceSearchService(dataSource: DataSource): InvoiceSearchService {
  return new InvoiceSearchService(dataSource);
}
