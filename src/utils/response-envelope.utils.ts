/**
 * Builds a standardized paginated JSON envelope for REST API list endpoints.
 *
 * @param items  - Array of items for the current page
 * @param totalCount - Total number of items across all pages
 * @param limit  - Maximum items per page
 * @param nextCursor - Cursor for the next page (optional, for keyset pagination)
 * @returns A paginated response envelope object
 */
export function buildPaginatedResponse<T>(
  items: T[],
  totalCount: number,
  limit: number,
  nextCursor?: string
): {
  success: true;
  data: T[];
  meta: {
    total: number;
    limit: number;
    hasNextPage: boolean;
    nextCursor: string | null;
  };
} {
  return {
    success: true,
    data: items,
    meta: {
      total: totalCount,
      limit,
      hasNextPage: Boolean(nextCursor),
      nextCursor: nextCursor || null,
    },
  };
}
