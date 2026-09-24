import rateLimit, { type Store } from "express-rate-limit";
import type { NextFunction, Request as ExpressRequest, RequestHandler, Response } from "express";
import type { AppLogger } from "../observability/logger";
import { AppError } from "../utils/http-error";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
  code?: string;
  keyGenerator?: (req: ExpressRequest) => string;
  /** Use a shared store (for example Redis) when running more than one API replica. */
  store?: Store;
  /** Allow traffic when the shared store is unavailable. Defaults to fail-closed. */
  failOpenOnStoreError?: boolean;
}

const DEFAULT_GLOBAL_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  max: 100,
  message: "Too many requests, please try again later.",
  code: "RATE_LIMIT_EXCEEDED",
};

const DEFAULT_CHALLENGE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  max: 5,
  message: "Too many challenge requests, please try again later.",
  code: "CHALLENGE_RATE_LIMIT_EXCEEDED",
};

const DEFAULT_VERIFY_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  max: 20,
  message: "Too many verification attempts, please try again later.",
  code: "VERIFY_RATE_LIMIT_EXCEEDED",
};

export function createRateLimitMiddleware(
  logger: AppLogger,
  options: RateLimitOptions = DEFAULT_GLOBAL_LIMIT
): RequestHandler {
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs <= 0) {
    throw new Error("Rate limit windowMs must be a positive integer.");
  }
  if (!Number.isSafeInteger(options.max) || options.max <= 0) {
    throw new Error("Rate limit max must be a positive integer.");
  }
  if (options.keyGenerator !== undefined && typeof options.keyGenerator !== "function") {
    throw new Error("Rate limit keyGenerator must be a function.");
  }

  const code =
    options.code && options.code.trim() ? options.code : "RATE_LIMIT_EXCEEDED";
  const message =
    options.message && options.message.trim()
      ? options.message
      : "Too many requests, please try again later.";
  const limiter = rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    keyGenerator: options.keyGenerator,
    message: {
      success: false,
      error: {
        code,
        message,
      },
    },
    standardHeaders: "draft-7",
    legacyHeaders: false,
    validate: true,
    store: options.store,
    passOnStoreError: false,
    handler: (req, _res, next) => {
      logger.warn("Rate limit exceeded.", {
        requestId: (req as ExpressRequest & { requestId?: string }).requestId,
        method: req.method,
        path: req.path,
        ip: req.ip,
      });

      next(new AppError(429, message, code));
    },
  });

  return (req: ExpressRequest, res: Response, next: NextFunction) => {
    limiter(req, res, (error?: unknown) => {
      if (!error) {
        next();
        return;
      }

      if (error instanceof AppError) {
        next(error);
        return;
      }

      logger.error("Rate limit store failed.", {
        requestId: (req as ExpressRequest & { requestId?: string }).requestId,
        method: req.method,
        path: req.path,
        store: options.store?.constructor?.name ?? "unknown",
        error: error instanceof Error ? error.message : "Unknown rate limit store error",
        failOpen: options.failOpenOnStoreError === true,
      });

      if (options.failOpenOnStoreError === true) {
        next();
        return;
      }

      next(
        new AppError(
          503,
          "Request throttling is temporarily unavailable. Please try again later.",
          "RATE_LIMIT_STORE_UNAVAILABLE"
        )
      );
    });
  };
}

export function createChallengeRateLimitMiddleware(logger: AppLogger) {
  return createRateLimitMiddleware(logger, DEFAULT_CHALLENGE_LIMIT);
}

export function createVerifyRateLimitMiddleware(logger: AppLogger) {
  return createRateLimitMiddleware(logger, DEFAULT_VERIFY_LIMIT);
}

export function createAuthRateLimitMiddleware(logger: AppLogger) {
  return createRateLimitMiddleware(logger, DEFAULT_VERIFY_LIMIT);
}

/** Path prefix the auth router is mounted under (see app.ts). */
const AUTH_ROUTE_PREFIX = "/api/v1/auth";

interface RateLimitableApp {
  use(middleware: unknown): void;
  use(path: string, middleware: unknown): void;
}

export function applyRateLimiters(
  app: RateLimitableApp,
  logger: AppLogger,
  config?: {
    global?: Partial<RateLimitOptions>;
    auth?: Partial<RateLimitOptions>;
  }
) {
  const globalOptions: RateLimitOptions = {
    ...DEFAULT_GLOBAL_LIMIT,
    ...config?.global,
  };

  const globalLimiter = createRateLimitMiddleware(logger, globalOptions);
  app.use(globalLimiter);

  // config.auth was accepted here but silently dropped — callers configuring
  // a stricter auth-path limiter got the global one instead (#385/#388).
  // Mount it on AUTH_ROUTE_PREFIX so it actually takes effect, layered on
  // top of (not instead of) the global limiter above.
  if (config?.auth) {
    const authOptions: RateLimitOptions = {
      ...DEFAULT_GLOBAL_LIMIT,
      ...config.auth,
    };
    const authLimiter = createRateLimitMiddleware(logger, authOptions);
    app.use(AUTH_ROUTE_PREFIX, authLimiter);
  }
}
