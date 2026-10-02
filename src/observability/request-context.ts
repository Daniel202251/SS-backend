import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

/**
 * Per-request context carried across async boundaries, so code far from the
 * HTTP layer (services, outbound HTTP clients, the logger) can read the
 * correlation ID of the request it is running on behalf of without it being
 * threaded through every function signature.
 */
export interface RequestContext {
  correlationId: string;
}

export const CORRELATION_ID_HEADER = "x-correlation-id";
export const REQUEST_ID_HEADER = "x-request-id";

// Inbound IDs end up verbatim in response headers and log lines, so only
// accept a conservative character set; anything else is replaced with a fresh
// UUID rather than risking header or log injection.
const INBOUND_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Picks the correlation ID for an inbound request: an upstream service's
 * X-Correlation-Id wins, then a client-supplied X-Request-Id, and otherwise a
 * new UUID is generated.
 */
export function resolveCorrelationId(...candidates: Array<string | string[] | undefined>): string {
  for (const candidate of candidates) {
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    const trimmed = value?.trim();
    if (trimmed && INBOUND_ID_PATTERN.test(trimmed)) {
      return trimmed;
    }
  }

  return randomUUID();
}

/**
 * Returns `headers` with the current correlation ID added, for propagating
 * it to downstream services. Outside a request context the headers are
 * returned unchanged.
 */
export function withCorrelationHeaders(
  headers: Record<string, string> = {}
): Record<string, string> {
  const correlationId = getCorrelationId();
  return correlationId ? { ...headers, [CORRELATION_ID_HEADER]: correlationId } : headers;
}
