import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export interface HmacWebhookOptions {
  /**
   * Name of the environment variable that stores the shared secret.
   * E.g., "KYC_WEBHOOK_SECRET" or "WEBHOOK_SECRET".
   */
  secretEnvVar?: string;
  /**
   * Direct secret string, used as override or fallback when secretEnvVar is not set.
   */
  secret?: string;
  /**
   * Header name carrying the HMAC signature (case-insensitive in Express).
   * Defaults to "x-webhook-signature".
   */
  headerName?: string;
  /**
   * Hash algorithm for HMAC. Defaults to "sha256".
   */
  algorithm?: string;
  /**
   * Optional custom extractor to extract raw signature hex (e.g. stripping prefixes).
   */
  extractSignature?: (headerValue: string) => string;
}

export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

/**
 * Creates an Express middleware that verifies incoming webhook requests using HMAC-SHA256.
 *
 * Requirements:
 * - Reads raw request body before JSON parsing
 * - Preserves raw body on `req.rawBody` for downstream parsing and validation
 * - Computes HMAC-SHA256 using the configured shared secret and compares against the signature header
 * - Uses constant-time comparison to prevent timing attacks
 * - Returns HTTP 401 when signature header is missing or signature is invalid
 * - Supports configurable header name per webhook source
 * - Loads shared secret from environment variables
 */
export function createHmacWebhookMiddleware(options: HmacWebhookOptions = {}) {
  const headerName = options.headerName ?? "x-webhook-signature";
  const algorithm = options.algorithm ?? "sha256";

  return function hmacWebhookMiddleware(
    req: RequestWithRawBody,
    res: Response,
    next: NextFunction
  ): void {
    // 1. Resolve shared secret from environment variable or explicit option
    const secret =
      (options.secretEnvVar ? process.env[options.secretEnvVar] : undefined) ?? options.secret;

    if (!secret) {
      res.status(401).json({
        error: {
          code: "MISSING_WEBHOOK_SECRET",
          message: "Webhook secret is not configured",
        },
      });
      return;
    }

    // 2. Helper to verify signature against raw body Buffer
    const verifySignature = (rawBody: Buffer): void => {
      req.rawBody = rawBody;

      // Extract signature header
      const signatureHeader = req.header(headerName);
      if (!signatureHeader || !signatureHeader.trim()) {
        res.status(401).json({
          error: {
            code: "MISSING_SIGNATURE_HEADER",
            message: `Missing signature header: ${headerName}`,
          },
        });
        return;
      }

      const rawSig = signatureHeader.trim();
      const signature = options.extractSignature
        ? options.extractSignature(rawSig)
        : rawSig.replace(/^sha256=/i, "");

      // Compute expected HMAC
      const expectedHex = crypto.createHmac(algorithm, secret).update(rawBody).digest("hex");

      // Verify length and constant-time match
      if (
        !/^[0-9a-f]+$/i.test(signature) ||
        signature.length !== expectedHex.length ||
        !crypto.timingSafeEqual(
          Buffer.from(signature.toLowerCase()),
          Buffer.from(expectedHex.toLowerCase())
        )
      ) {
        res.status(401).json({
          error: {
            code: "INVALID_WEBHOOK_SIGNATURE",
            message: "Invalid webhook signature",
          },
        });
        return;
      }

      next();
    };

    // 3. Read raw request body if not already available
    if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
      verifySignature(req.rawBody);
      return;
    }

    if (Buffer.isBuffer(req.body)) {
      verifySignature(req.body);
      return;
    }

    if (typeof req.body === "string") {
      verifySignature(Buffer.from(req.body, "utf8"));
      return;
    }

    // If stream is readable and unconsumed
    if (req.readable) {
      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      req.on("end", () => {
        const rawBody = Buffer.concat(chunks);
        req.rawBody = rawBody;

        // Preserve body for downstream parsing if content-type is json
        if (req.is("application/json")) {
          try {
            (req as Request).body = JSON.parse(rawBody.toString("utf8"));
          } catch {
            // Keep as raw buffer if JSON parse fails
            (req as Request).body = rawBody;
          }
        } else {
          (req as Request).body = rawBody;
        }

        verifySignature(rawBody);
      });

      req.on("error", (err) => {
        next(err);
      });
      return;
    }

    // If req.body is already parsed into an object (e.g. upstream body-parser without verify callback)
    if (req.body && typeof req.body === "object") {
      const serialized = Buffer.from(JSON.stringify(req.body), "utf8");
      verifySignature(serialized);
      return;
    }

    // Empty body fallback
    verifySignature(Buffer.alloc(0));
  };
}
