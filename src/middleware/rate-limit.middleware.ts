import { createHash } from "crypto";
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
  /**
   * Upper bound on a single store `increment` call. A shared store that stops
   * answering would otherwise hold every request open until the client gives
   * up; past this bound the call is treated as a store failure and handled by
   * `failOpenOnStoreError`. Only applies when a custom `store` is supplied.
   */
  storeTimeoutMs?: number;
}

type RequestWithId = ExpressRequest & { requestId?: string };

const DEFAULT_CODE = "RATE_LIMIT_EXCEEDED";
const DEFAULT_MESSAGE = "Too many requests, please try again later.";

/** Generous for a Redis round trip, short enough not to stall the request. */
export const DEFAULT_STORE_TIMEOUT_MS = 1_000;

/**
 * Keys longer than this are hashed before they reach the store. Custom key
 * generators often derive keys from client-supplied values (headers, wallet
 * addresses), and an unbounded key lets a client inflate store memory.
 */
const MAX_KEY_LENGTH = 128;

const DEFAULT_GLOBAL_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  max: 100,
  message: DEFAULT_MESSAGE,
  code: DEFAULT_CODE,
};

const DEFAULT_CHALLENGE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  max: 10,
  message: "Too many challenge requests, please try again later.",
  code: "CHALLENGE_RATE_LIMIT_EXCEEDED",
};

const DEFAULT_VERIFY_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  max: 20,
  message: "Too many verification attempts, please try again later.",
  code: "VERIFY_RATE_LIMIT_EXCEEDED",
};

/** Raised when the shared store does not answer within `storeTimeoutMs`. */
export class RateLimitStoreTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Rate limit store did not respond within ${timeoutMs}ms`);
    this.name = "RateLimitStoreTimeoutError";
  }
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function assertPositiveInteger(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Rate limit ${name} must be a positive integer.`);
  }
}

function validateOptions(options: RateLimitOptions): void {
  assertPositiveInteger(options.windowMs, "windowMs");
  assertPositiveInteger(options.max, "max");
  if (options.keyGenerator !== undefined && typeof options.keyGenerator !== "function") {
    throw new Error("Rate limit keyGenerator must be a function.");
  }
  if (options.store !== undefined) {
    const store = options.store as Partial<Store> | null;
    if (!store || typeof store.increment !== "function") {
      throw new Error("Rate limit store must implement increment().");
    }
  }
  if (options.storeTimeoutMs !== undefined) {
    assertPositiveInteger(options.storeTimeoutMs, "storeTimeoutMs");
  }
}

/** Drops `undefined` overrides so they cannot erase a default. */
function mergeOptions(
  defaults: RateLimitOptions,
  overrides?: Partial<RateLimitOptions>
): RateLimitOptions {
  const merged: RateLimitOptions = { ...defaults };
  if (!overrides) {
    return merged;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function storeName(store: Store | undefined): string {
  return store?.constructor?.name ?? "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown rate limit store error";
}

/**
 * Wraps a store so `increment` cannot hang indefinitely. Every other member is
 * forwarded untouched — in particular `init`, which stores such as
 * rate-limit-redis rely on to learn the window length.
 */
function withStoreTimeout(store: Store, timeoutMs: number): Store {
  const wrapped: Store = {
    increment: (key) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new RateLimitStoreTimeoutError(timeoutMs)),
          timeoutMs
        );
        timer.unref?.();
        Promise.resolve()
          .then(() => store.increment(key))
          .then(resolve, reject)
          .finally(() => clearTimeout(timer));
      }),
    decrement: (key) => store.decrement(key),
    resetKey: (key) => store.resetKey(key),
  };

  if (store.init) wrapped.init = (options) => store.init?.(options);
  if (store.get) wrapped.get = (key) => store.get?.(key);
  if (store.resetAll) wrapped.resetAll = () => store.resetAll?.();
  if (store.shutdown) wrapped.shutdown = () => store.shutdown?.();
  if (store.localKeys !== undefined) wrapped.localKeys = store.localKeys;
  if (store.prefix !== undefined) wrapped.prefix = store.prefix;

  return wrapped;
}

function fallbackKey(req: ExpressRequest): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

function boundKey(key: string): string {
  if (key.length <= MAX_KEY_LENGTH) {
    return key;
  }
  return `sha256:${createHash("sha256").update(key, "utf8").digest("hex")}`;
}

/**
 * Guards a caller-supplied key generator. A generator that throws or returns
 * something unusable falls back to the client IP rather than failing the
 * request — the error would otherwise surface as a store outage (503) and
 * trip fail-open/fail-closed handling meant for infrastructure failures.
 */
function safeKeyGenerator(
  keyGenerator: (req: ExpressRequest) => string,
  logger: AppLogger
): (req: ExpressRequest) => string {
  return (req) => {
    let key: unknown;
    try {
      key = keyGenerator(req);
    } catch (error) {
      logger.warn("Rate limit key generator failed; falling back to client IP.", {
        requestId: (req as RequestWithId).requestId,
        path: req.path,
        error: errorMessage(error),
      });
      return fallbackKey(req);
    }

    if (typeof key !== "string" || !key.trim()) {
      logger.warn("Rate limit key generator returned an empty key; falling back to client IP.", {
        requestId: (req as RequestWithId).requestId,
        path: req.path,
        keyType: typeof key,
      });
      return fallbackKey(req);
    }

    return boundKey(key);
  };
}

export function createRateLimitMiddleware(
  logger: AppLogger,
  options: RateLimitOptions = DEFAULT_GLOBAL_LIMIT
): RequestHandler {
  validateOptions(options);

  const code = nonEmptyString(options.code, DEFAULT_CODE);
  const message = nonEmptyString(options.message, DEFAULT_MESSAGE);
  const failOpen = options.failOpenOnStoreError === true;
  const configuredStoreName = storeName(options.store);
  const storeTimeoutMs = options.storeTimeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;
  const store = options.store ? withStoreTimeout(options.store, storeTimeoutMs) : undefined;

  const limiter = rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    keyGenerator: options.keyGenerator ? safeKeyGenerator(options.keyGenerator, logger) : undefined,
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
    store,
    passOnStoreError: false,
    handler: (req, _res, next) => {
      logger.warn("Rate limit exceeded.", {
        requestId: (req as RequestWithId).requestId,
        method: req.method,
        path: req.path,
        ip: req.ip,
      });

      next(new AppError(429, message, code));
    },
  });

  return (req: ExpressRequest, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    let settled = false;

    const onStoreError = (error: unknown) => {
      const timedOut = error instanceof RateLimitStoreTimeoutError;
      logger.error("Rate limit store failed.", {
        requestId: (req as RequestWithId).requestId,
        method: req.method,
        path: req.path,
        store: configuredStoreName,
        error: errorMessage(error),
        reason: timedOut ? "timeout" : "error",
        durationMs: Date.now() - startedAt,
        failOpen,
      });

      if (failOpen) {
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
    };

    const done = (error?: unknown) => {
      // express-rate-limit settles once per request; this guards against a
      // misbehaving store resolving after the timeout already failed it.
      if (settled) return;
      settled = true;

      if (!error) {
        next();
        return;
      }

      if (error instanceof AppError) {
        next(error);
        return;
      }

      onStoreError(error);
    };

    try {
      limiter(req, res, done);
    } catch (error) {
      done(error);
    }
  };
}

export function createChallengeRateLimitMiddleware(
  logger: AppLogger,
  overrides?: Partial<RateLimitOptions>
): RequestHandler {
  return createRateLimitMiddleware(logger, mergeOptions(DEFAULT_CHALLENGE_LIMIT, overrides));
}

export function createVerifyRateLimitMiddleware(
  logger: AppLogger,
  overrides?: Partial<RateLimitOptions>
): RequestHandler {
  return createRateLimitMiddleware(logger, mergeOptions(DEFAULT_VERIFY_LIMIT, overrides));
}

export function createAuthRateLimitMiddleware(
  logger: AppLogger,
  overrides?: Partial<RateLimitOptions>
): RequestHandler {
  return createRateLimitMiddleware(logger, mergeOptions(DEFAULT_VERIFY_LIMIT, overrides));
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
): RequestHandler {
  const globalLimiter = createRateLimitMiddleware(
    logger,
    mergeOptions(DEFAULT_GLOBAL_LIMIT, config?.global)
  );
  app.use(globalLimiter);

  // config.auth was accepted here but silently dropped — callers configuring
  // a stricter auth-path limiter got the global one instead (#385/#388).
  // Mount it on AUTH_ROUTE_PREFIX so it actually takes effect, layered on
  // top of (not instead of) the global limiter above.
  if (config?.auth) {
    const authLimiter = createRateLimitMiddleware(
      logger,
      mergeOptions(DEFAULT_GLOBAL_LIMIT, config.auth)
    );
    app.use(AUTH_ROUTE_PREFIX, authLimiter);
  }

  return globalLimiter;
}
