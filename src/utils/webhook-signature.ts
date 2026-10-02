import crypto from "crypto";

/**
 * Compute an HMAC-SHA256 signature for a payload using the given secret.
 */
export function computeWebhookSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Verify that a signature matches the expected HMAC-SHA256 of the payload
 * computed with the given secret.
 *
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @returns `true` if the signature is valid, `false` otherwise.
 * Never throws — safe to use in webhook handlers.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  try {
    if (!payload || !signature || !secret) {
      return false;
    }

    const expected = computeWebhookSignature(payload, secret);

    // Constant-time comparison
    if (expected.length !== signature.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Header carrying the (milliseconds-since-epoch) timestamp the signature covers. */
export const WEBHOOK_TIMESTAMP_HEADER = "x-webhook-timestamp";

/** Header carrying the HMAC-SHA256 hex signature of `<timestamp>.<payload>`. */
export const WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature";

/** Codes returned when a webhook signature verification fails. */
export type WebhookSignatureErrorCode =
  | "MISSING_TIMESTAMP"
  | "MISSING_SIGNATURE"
  | "MALFORMED_SIGNATURE"
  | "TIMESTAMP_OUT_OF_RANGE"
  | "TIMESTAMP_SKEWED"
  | "INVALID_SIGNATURE";

/** A typed, addressable webhook verification failure. */
export class WebhookSignatureError extends Error {
  constructor(
    public readonly code: WebhookSignatureErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

/** Default maximum acceptable skew between `now` and the signed timestamp. */
export const DEFAULT_MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/**
 * Compute the signature over an optional timestamp and the raw payload.
 *
 * When a timestamp is supplied the signed content is `<timestamp>.<payload>`.
 * Providers commonly sign the timestamp plus the raw body so that a captured
 * signature cannot be replayed after the timestamp age expires.
 */
export function computeWebhookSignatureForTimestamp(
  payload: string,
  timestamp: string,
  secret: string
): string {
  return computeWebhookSignature(`${timestamp}.${payload}`, secret);
}

export interface VerifyWebhookHeadersOptions {
  /** Raw, unparsed request body exactly as it was received. */
  payload: string;
  /** Value of the signature header (`x-webhook-signature`), if present. */
  signature: string | undefined | null;
  /** Value of the timestamp header (`x-webhook-timestamp`), if present. */
  timestamp: string | undefined | null;
  /** The configured shared secret. */
  secret: string;
  /** Maximum allowed skew between `now()` and `timestamp` in milliseconds. */
  maxTimestampSkewMs?: number;
  /**
   * Override for the current time in milliseconds since the epoch. Injected so
   * tests (and replay windows) are deterministic. Defaults to `Date.now()`.
   */
  now?: () => number;
}

/**
 * Verify that a webhook request is authentic: a signature header must be
 * present, well-formed, unexpired (within the allowed timestamp skew), and
 * must match the HMAC-SHA256 of `<timestamp>.<payload>` computed with the
 * configured secret.
 *
 * @returns The verified timestamp header value (as a numeric string) on
 *   success so callers can echo it / log it.
 * @throws {WebhookSignatureError} with a stable, enumerable code for any
 *   failure. Never returns `false` — every rejection is a typed error that a
 *   handler can map to a 4xx response.
 */
export function verifyWebhookSignatureHeaders(options: VerifyWebhookHeadersOptions): string {
  const {
    payload,
    signature,
    timestamp,
    secret,
    maxTimestampSkewMs = DEFAULT_MAX_TIMESTAMP_SKEW_MS,
    now = () => Date.now(),
  } = options;

  if (!secret) {
    throw new WebhookSignatureError("INVALID_SIGNATURE", "Webhook secret is not configured.");
  }

  if (timestamp === undefined || timestamp === null || timestamp === "") {
    throw new WebhookSignatureError(
      "MISSING_TIMESTAMP",
      `Missing '${WEBHOOK_TIMESTAMP_HEADER}' header.`
    );
  }

  if (signature === undefined || signature === null || signature === "") {
    throw new WebhookSignatureError(
      "MISSING_SIGNATURE",
      `Missing '${WEBHOOK_SIGNATURE_HEADER}' header.`
    );
  }

  const skewMs = now() - parseTimestampMs(timestamp);

  if (Number.isNaN(skewMs) || !Number.isFinite(skewMs)) {
    throw new WebhookSignatureError(
      "TIMESTAMP_OUT_OF_RANGE",
      `'${WEBHOOK_TIMESTAMP_HEADER}' is not a valid timestamp.`
    );
  }

  if (Math.abs(skewMs) > maxTimestampSkewMs) {
    throw new WebhookSignatureError(
      "TIMESTAMP_SKEWED",
      `'${WEBHOOK_TIMESTAMP_HEADER}' is outside the allowed ${maxTimestampSkewMs}ms window.`
    );
  }

  // Signature format must be a 64-char hex digest (HMAC-SHA256).
  if (!/^[0-9a-f]{64}$/i.test(signature)) {
    throw new WebhookSignatureError(
      "MALFORMED_SIGNATURE",
      "'x-webhook-signature' is not a valid HMAC-SHA256 hex signature."
    );
  }

  const expected = computeWebhookSignatureForTimestamp(payload, timestamp, secret);

  if (expected.length !== signature.length) {
    throw new WebhookSignatureError(
      "MALFORMED_SIGNATURE",
      "'x-webhook-signature' has an invalid length."
    );
  }

  const matches = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));

  if (!matches) {
    throw new WebhookSignatureError("INVALID_SIGNATURE", "Webhook signature verification failed.");
  }

  return timestamp;
}

function parseTimestampMs(timestamp: string): number {
  const trimmed = timestamp.trim();

  // Accept digits-only epoch milliseconds (the common webhook wire format).
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  return new Date(trimmed).getTime();
}
