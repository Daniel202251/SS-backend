import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { HttpError } from "../utils/http-error";

interface WalletRateLimitEntry {
  count: number;
  windowStart: number;
}

interface WalletRateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const stores = new Map<string, Map<string, WalletRateLimitEntry>>();

function getStore(name: string): Map<string, WalletRateLimitEntry> {
  let store = stores.get(name);
  if (!store) {
    store = new Map();
    stores.set(name, store);
  }
  return store;
}

function getWalletAddress(req: Request): string | null {
  const authReq = req as AuthenticatedRequest;
  return authReq.user?.stellarAddress ?? null;
}

export function createWalletRateLimiter(config: WalletRateLimitConfig, name: string) {
  const store = getStore(name);

  // Periodically clean up stale entries
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now - entry.windowStart >= config.windowMs) {
        store.delete(key);
      }
    }
  }, config.windowMs).unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const wallet = getWalletAddress(req);

    if (!wallet) {
      next(new HttpError(401, "Authentication required for rate-limited endpoint."));
      return;
    }

    const now = Date.now();
    const entry = store.get(wallet);

    if (!entry || now - entry.windowStart >= config.windowMs) {
      // Start a new window
      store.set(wallet, { count: 1, windowStart: now });
      next();
      return;
    }

    if (entry.count >= config.maxRequests) {
      const retryAfterMs = config.windowMs - (now - entry.windowStart);
      const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        success: false,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: `Too many requests. Please wait ${retryAfterSeconds} seconds before retrying.`,
        },
      });
      return;
    }

    entry.count++;
    next();
  };
}

// For testing: allow resetting stores
export function resetRateLimitStores(): void {
  stores.clear();
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getRedisClient } = require("../config/redis");
    const client = getRedisClient();
    if (client && typeof client.flushall === "function") {
      client.flushall();
    }
  } catch {
    // Ignore
  }
}
