import { ObjectLiteral, SelectQueryBuilder } from "typeorm";
import { ServiceError } from "./service-error";

/**
 * Generic keyset (cursor) pagination helper for any TypeORM `SelectQueryBuilder`.
 *
 * Unlike `pagination.ts`'s `queryInvoicesPage` (which is hard-coded to the
 * Invoice entity and a fixed `createdAt` + `id` sort), this helper works over
 * any entity and any single sortable column, so it can back any list endpoint
 * that needs stable, O(1)-per-page cursor pagination instead of offset/limit.
 *
 * The cursor is opaque to callers: it is a base64 encoding of
 * `{ field, value, id }` for the last row of the current page, so API consumers
 * can round-trip it without needing to understand its internal shape.
 *
 * Stable ordering: the cursor always carries the row's primary key (`id`) so
 * that rows sharing the same sort value are ordered deterministically and are
 * neither repeated nor skipped across page boundaries. The primary sort column
 * is ordered by `order` and the primary key is always a secondary ASC tiebreak.
 */

export interface PaginateQueryOptions<T extends ObjectLiteral> {
  /** Query builder pre-configured with `select`/`where`/joins, but WITHOUT
   *  ordering, cursor filtering, or a `take` limit applied yet. */
  queryBuilder: SelectQueryBuilder<T>;
  /** Column to sort and page by (must be unique or combined with a tiebreaker
   *  that is already unique, e.g. a primary key). Dot-qualified with the
   *  query builder's alias, e.g. "invoice.createdAt". */
  cursorField: string;
  /** Sort direction for `cursorField`. Defaults to "DESC". */
  order?: "ASC" | "DESC";
  /** Maximum number of items to return for this page. */
  limit: number;
  /** Opaque cursor from a previous page's `nextCursor`, or omitted/null for
   *  the first page. */
  cursor?: string | null;
  /**
   * Secondary sort column used as a tiebreaker (must be unique). Defaults to
   * `"<alias>.id"`. Always ordered ASC. Encoded in the cursor so equal primary
   * values resolve deterministically.
   */
  tiebreakerField?: string;
}

export interface PaginateQueryResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface DecodedCursor {
  field: string;
  value: string | number;
  id?: string;
}

function invalidCursor(message: string): ServiceError {
  return new ServiceError("invalid_cursor", message, 400);
}

/**
 * Encodes a cursor field/value pair as an opaque base64 string.
 *
 * @param id Optional secondary key (row id) so that rows sharing the primary
 *   sort value resume deterministically. Always included by `paginateQuery`.
 */
export function encodeQueryCursor(
  field: string,
  value: string | number | Date,
  id?: string
): string {
  const normalizedValue = value instanceof Date ? value.toISOString() : value;
  return Buffer.from(
    JSON.stringify({ field, value: normalizedValue, ...(id !== undefined ? { id } : {}) })
  ).toString("base64");
}

/**
 * Decodes an opaque cursor previously produced by `encodeQueryCursor` /
 * `paginateQuery`.
 *
 * @throws ServiceError (400) if the cursor is not valid base64-encoded JSON,
 *   or is missing the expected `field`/`value` shape.
 */
export function decodeQueryCursor(cursor: string): DecodedCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
  } catch {
    throw invalidCursor("Invalid cursor: not valid base64-encoded JSON");
  }

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("field" in decoded) ||
    !("value" in decoded)
  ) {
    throw invalidCursor("Invalid cursor: missing 'field' or 'value'");
  }

  const { field, value, id } = decoded as {
    field: unknown;
    value: unknown;
    id?: unknown;
  };

  if (typeof field !== "string" || (typeof value !== "string" && typeof value !== "number")) {
    throw invalidCursor("Invalid cursor: 'field' must be a string and 'value' a string or number");
  }

  if (id !== undefined && typeof id !== "string") {
    throw invalidCursor("Invalid cursor: 'id' must be a string when present");
  }

  return { field, value, ...(id !== undefined ? { id } : {}) };
}

/**
 * Extracts the alias-qualified column's bare column name and TypeORM
 * parameter-safe alias for use in query fragments, e.g.
 * "invoice.createdAt" -> { alias: "invoice", column: "createdAt" }.
 */
function splitCursorField(cursorField: string): { alias: string; column: string } {
  const parts = cursorField.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw invalidCursor(
      `Invalid cursorField "${cursorField}": expected "<alias>.<column>" (e.g. "invoice.createdAt")`
    );
  }
  return { alias: parts[0], column: parts[1] };
}

/**
 * Generic cursor-based (keyset) pagination over any Prisma-style query
 * builder pattern — implemented here against TypeORM's `SelectQueryBuilder`,
 * following the standard cursor pattern: filter strictly past the last seen
 * value, order by the same field, and fetch one extra row to detect whether
 * more pages remain.
 *
 * The caller supplies a query builder with its own filters/joins already
 * applied; this helper only adds cursor filtering, ordering, and the
 * over-fetch used to compute `hasMore`.
 *
 * Stable ordering: the cursor row's primary key is encoded and added as an ASC
 * secondary sort, so equal primary sort values never produce gaps or repeats.
 */
export async function paginateQuery<T extends ObjectLiteral>(
  options: PaginateQueryOptions<T>
): Promise<PaginateQueryResult<T>> {
  const { queryBuilder, cursorField, limit, cursor } = options;
  const order = options.order ?? "DESC";
  const { alias } = splitCursorField(cursorField);
  const tiebreakerField = options.tiebreakerField ?? `${alias}.id`;
  const { column: idColumn } = splitCursorField(tiebreakerField);

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("paginateQuery: 'limit' must be a positive integer");
  }

  const paramName = `cursor_${alias}_${columnOf(cursorField)}`;

  if (cursor) {
    const decoded = decodeQueryCursor(cursor);
    if (decoded.field !== cursorField) {
      throw invalidCursor(
        `Invalid cursor: was encoded for field "${decoded.field}" but query is paginating on "${cursorField}"`
      );
    }

    if (decoded.id === undefined) {
      // Legacy/shape cursor without a secondary key: filter on the primary
      // column alone (still stable as long as the sort value is unique).
      const comparator = order === "DESC" ? "<" : ">";
      queryBuilder.andWhere(`${cursorField} ${comparator} :${paramName}`, {
        [paramName]: decoded.value,
      });
    } else {
      const tiebreakerParamName = `cursor_${alias}_${idColumn}`;
      const comparator = order === "DESC" ? "<" : ">";
      queryBuilder.andWhere(
        `(${cursorField} ${comparator} :${paramName} OR (${cursorField} = :${paramName} AND ${tiebreakerField} > :${tiebreakerParamName}))`,
        {
          [paramName]: decoded.value,
          [tiebreakerParamName]: decoded.id,
        }
      );
    }
  }

  queryBuilder.orderBy(cursorField, order);
  // Secondary (tiebreaker) ordering so rows that share the primary sort value
  // are returned in a deterministic order and pagination never skips/repeats.
  queryBuilder.addOrderBy(tiebreakerField, "ASC");
  // Fetch one extra row so we can tell whether another page follows without
  // a second COUNT query.
  queryBuilder.take(limit + 1);

  const rows = await queryBuilder.getMany();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1] as unknown as Record<string, unknown>;
    const lastValue = lastItem[columnOf(cursorField)];
    if (
      typeof lastValue === "string" ||
      typeof lastValue === "number" ||
      lastValue instanceof Date
    ) {
      const lastId = lastItem[idColumn];
      nextCursor = encodeQueryCursor(
        cursorField,
        lastValue,
        typeof lastId === "string" ? lastId : undefined
      );
    } else {
      throw invalidCursor(
        `paginateQuery: cursor column "${columnOf(cursorField)}" must resolve to a string, number, or Date (got ${typeof lastValue})`
      );
    }
  }

  return { items, nextCursor, hasMore };
}

function columnOf(cursorField: string): string {
  const index = cursorField.indexOf(".");
  return index === -1 ? cursorField : cursorField.slice(index + 1);
}
