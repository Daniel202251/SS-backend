import type { Request, Response, NextFunction } from "express";
import sanitizeHtml from "sanitize-html";

export function sanitizeString(input: string): string {
  const sanitize =
    typeof sanitizeHtml === "function"
      ? sanitizeHtml
      : (sanitizeHtml as unknown as { default: typeof sanitizeHtml })?.default;
  if (typeof sanitize === "function") {
    return sanitize(input, { allowedTags: [], allowedAttributes: {} }).trim();
  }
  return input.replace(/<[^>]*>/g, "").trim();
}

function isBuffer(obj: unknown): obj is Buffer {
  return Buffer.isBuffer(obj);
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value !== null && typeof value === "object" && !isBuffer(value)) {
    return sanitizeObject(value as Record<string, unknown>);
  }

  return value;
}

function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    sanitized[key] = sanitizeValue(value);
  }

  return sanitized;
}

export function sanitizeInputMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === "object" && !isBuffer(req.body)) {
    req.body = sanitizeObject(req.body);
  }

  if (req.query && typeof req.query === "object") {
    const sanitizedQuery = sanitizeObject(req.query as Record<string, unknown>);
    Object.defineProperty(req, "query", {
      value: sanitizedQuery,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  next();
}
