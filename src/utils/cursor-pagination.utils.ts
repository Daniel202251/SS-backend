/**
 * Keyset cursor pagination helper using composite ordering on (created_at DESC, id DESC).
 * Provides O(1) query performance across large datasets compared to offset-based pagination.
 */

/**
 * Encodes a composite cursor from a createdAt date and an id string into a base64 string.
 *
 * @param date - The createdAt date of the last item on the current page
 * @param id   - The id of the last item on the current page
 * @returns A base64-encoded cursor string
 */
export function encodeCursor(date: Date, id: string): string {
  return Buffer.from(`${date.toISOString()}::${id}`).toString("base64");
}

/**
 * Decodes a base64-encoded cursor back into its createdAt date and id components.
 *
 * @param cursor - A base64-encoded cursor string
 * @returns An object with the parsed createdAt Date and id string
 * @throws If the cursor format is invalid
 */
export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = Buffer.from(cursor, "base64").toString("utf-8");
  const separatorIndex = decoded.indexOf("::");

  if (separatorIndex === -1) {
    throw new Error("Invalid cursor format: expected 'ISO_DATE::ID'");
  }

  const createdAtIso = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 2);

  if (!createdAtIso || !id) {
    throw new Error("Invalid cursor format: missing date or id component");
  }

  const createdAt = new Date(createdAtIso);

  if (isNaN(createdAt.getTime())) {
    throw new Error("Invalid cursor format: unable to parse date");
  }

  return { createdAt, id };
}
