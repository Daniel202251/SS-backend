import { ServiceError } from "./service-error";

export interface DecodedInvoiceCursor {
  createdAt?: Date;
  id?: string;
}

/**
 * Encodes an invoice into an opaque base64 keyset cursor.
 * Format: ISO_8601_TIMESTAMP|INVOICE_ID
 */
export function encodeInvoiceCursor(invoice: { createdAt: Date | string; id: string }): string {
  const createdAtIso =
    invoice.createdAt instanceof Date
      ? invoice.createdAt.toISOString()
      : new Date(invoice.createdAt).toISOString();
  return Buffer.from(`${createdAtIso}|${invoice.id}`).toString("base64");
}

/**
 * Decodes an invoice cursor supporting multiple representations:
 * 1. Base64 encoded "ISO_TIMESTAMP|id"
 * 2. Base64 encoded JSON "{ createdAt, id }" or "{ field, value, id }"
 * 3. Raw UUID (invoice id)
 * 4. Raw ISO date string
 */
export function decodeInvoiceCursor(cursor: string): DecodedInvoiceCursor {
  const trimmed = cursor.trim();
  if (!trimmed) {
    throw new ServiceError("invalid_cursor", "Cursor cannot be empty", 400);
  }

  // 1. Try decoding as base64
  try {
    const decodedStr = Buffer.from(trimmed, "base64").toString("utf-8");

    // Check for JSON shape
    if (decodedStr.startsWith("{") && decodedStr.endsWith("}")) {
      const parsed = JSON.parse(decodedStr) as Record<string, unknown>;
      const createdAtRaw = parsed.createdAt ?? parsed.value;
      const idRaw = parsed.id;

      let date: Date | undefined;
      if (typeof createdAtRaw === "string" || typeof createdAtRaw === "number") {
        const parsedDate = new Date(createdAtRaw);
        if (!isNaN(parsedDate.getTime())) {
          date = parsedDate;
        }
      }

      const id = typeof idRaw === "string" && idRaw.length > 0 ? idRaw : undefined;
      if (date || id) {
        return { createdAt: date, id };
      }
    }

    // Check for pipe-delimited shape (ISO_DATE|id)
    if (decodedStr.includes("|")) {
      const [datePart, idPart] = decodedStr.split("|");
      const date = new Date(datePart);
      if (!isNaN(date.getTime())) {
        return {
          createdAt: date,
          id: idPart && idPart.length > 0 ? idPart : undefined,
        };
      }
    }
  } catch {
    // Fall through if base64 decoding or JSON parsing fails
  }

  // 2. Raw UUID format (matches invoice ID)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(trimmed)) {
    return { id: trimmed };
  }

  // 3. Raw ISO date string
  const directDate = new Date(trimmed);
  if (!isNaN(directDate.getTime()) && (trimmed.includes("T") || trimmed.includes("-"))) {
    return { createdAt: directDate };
  }

  throw new ServiceError("invalid_cursor", "Invalid cursor format", 400);
}
