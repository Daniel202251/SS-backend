import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Redis } from "ioredis";
import { checkSlidingWindow } from "../lib/redis-sliding-window";
import type { AppLogger } from "../observability/logger";
import { logger as defaultLogger } from "../observability/logger";
import type { AuthenticatedRequest } from "../types/auth";

export interface RateLimitThreshold {
  windowMs: number;
  maxRequests: number;
}

export interface RedisRateLimiterOptions {
  endpoint: string;
  ipLimit?: RateLimitThreshold;
  walletLimit?: RateLimitThreshold;
  getWalletAddress?: (req: Request) => string | null | undefined;
  client?: Redis;
  logger?: AppLogger;
  enabled?: boolean;
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket.remoteAddress || "127.0.0.1";
}

export function extractWalletAddress(req: Request): string | null {
  const authReq = req as AuthenticatedRequest;
  if (authReq.user?.stellarAddress) {
    return authReq.user.stellarAddress;
  }
  if ((authReq.user as unknown as { publicKey?: string })?.publicKey) {
    return (authReq.user as unknown as { publicKey: string }).publicKey;
  }
  if (req.body && typeof req.body === "object") {
    if (typeof req.body.publicKey === "string" && req.body.publicKey.trim()) {
      return req.body.publicKey.trim();
    }
    if (typeof req.body.walletAddress === "string" && req.body.walletAddress.trim()) {
      return req.body.walletAddress.trim();
    }
    if (typeof req.body.investorWallet === "string" && req.body.investorWallet.trim()) {
      return req.body.investorWallet.trim();
    }
  }
  return null;
}

export function resolveThreshold(
  endpoint: string,
  dimension: "ip" | "wallet",
  fallback: RateLimitThreshold
): RateLimitThreshold {
  const normalized = endpoint.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const envWindow = process.env[`RATE_LIMIT_${normalized}_${dimension.toUpperCase()}_WINDOW_MS`];
  const envMax = process.env[`RATE_LIMIT_${normalized}_${dimension.toUpperCase()}_MAX`];

  const windowMs =
    envWindow && !isNaN(Number(envWindow)) && Number(envWindow) > 0
      ? Number(envWindow)
      : fallback.windowMs;

  const maxRequests =
    envMax && !isNaN(Number(envMax)) && Number(envMax) > 0 ? Number(envMax) : fallback.maxRequests;

  return { windowMs, maxRequests };
}

export function createRedisRateLimiter(options: RedisRateLimiterOptions): RequestHandler {
  const log = options.logger ?? defaultLogger;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (options.enabled === false || process.env.RATE_LIMIT_ENABLED === "false") {
      next();
      return;
    }

    const defaultIpFallback: RateLimitThreshold = options.ipLimit ?? {
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
      maxRequests: Number(process.env.RATE_LIMIT_MAX) || 100,
    };
    const ipThreshold = resolveThreshold(options.endpoint, "ip", defaultIpFallback);

    const defaultWalletFallback: RateLimitThreshold = options.walletLimit ?? {
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
      maxRequests: 10,
    };
    const walletThreshold = resolveThreshold(options.endpoint, "wallet", defaultWalletFallback);

    // 1. IP rate limiting
    if (ipThreshold.maxRequests > 0) {
      const clientIp = getClientIp(req);
      const ipKey = `ratelimit:${options.endpoint}:ip:${clientIp}`;

      const ipResult = await checkSlidingWindow({
        key: ipKey,
        windowMs: ipThreshold.windowMs,
        maxRequests: ipThreshold.maxRequests,
        client: options.client,
      });

      if (!ipResult.allowed) {
        log.warn("IP rate limit exceeded", {
          endpoint: options.endpoint,
          ip: clientIp,
          retryAfter: ipResult.retryAfterSeconds,
        });

        res.setHeader("Retry-After", String(ipResult.retryAfterSeconds));
        res.status(429).json({
          success: false,
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: `Too many requests. Please wait ${ipResult.retryAfterSeconds} seconds before retrying.`,
          },
        });
        return;
      }
    }

    // 2. Wallet rate limiting (independent from IP)
    const wallet = options.getWalletAddress
      ? options.getWalletAddress(req)
      : extractWalletAddress(req);
    if (wallet && walletThreshold.maxRequests > 0) {
      const walletKey = `ratelimit:${options.endpoint}:wallet:${wallet}`;

      const walletResult = await checkSlidingWindow({
        key: walletKey,
        windowMs: walletThreshold.windowMs,
        maxRequests: walletThreshold.maxRequests,
        client: options.client,
      });

      if (!walletResult.allowed) {
        log.warn("Wallet rate limit exceeded", {
          endpoint: options.endpoint,
          wallet,
          retryAfter: walletResult.retryAfterSeconds,
        });

        res.setHeader("Retry-After", String(walletResult.retryAfterSeconds));
        res.status(429).json({
          success: false,
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: `Too many requests. Please wait ${walletResult.retryAfterSeconds} seconds before retrying.`,
          },
        });
        return;
      }
    }

    next();
  };
}

export function createAuthRateLimiter(
  subEndpoint: string,
  options?: Partial<RedisRateLimiterOptions>
): RequestHandler {
  const ipMax = Number(process.env.RATE_LIMIT_AUTH_IP_MAX) || 20;
  const ipWindow = Number(process.env.RATE_LIMIT_AUTH_IP_WINDOW_MS) || 60000;
  const walletMax = Number(process.env.RATE_LIMIT_AUTH_WALLET_MAX) || 10;
  const walletWindow = Number(process.env.RATE_LIMIT_AUTH_WALLET_WINDOW_MS) || 60000;

  return createRedisRateLimiter({
    endpoint: `auth-${subEndpoint}`,
    ipLimit: { windowMs: ipWindow, maxRequests: ipMax },
    walletLimit: { windowMs: walletWindow, maxRequests: walletMax },
    ...options,
  });
}

export function createInvestRateLimiter(
  subEndpoint: string,
  options?: Partial<RedisRateLimiterOptions>
): RequestHandler {
  const ipMax = Number(process.env.RATE_LIMIT_INVEST_IP_MAX) || 30;
  const ipWindow = Number(process.env.RATE_LIMIT_INVEST_IP_WINDOW_MS) || 60000;
  const walletMax = Number(process.env.RATE_LIMIT_INVEST_WALLET_MAX) || 10;
  const walletWindow = Number(process.env.RATE_LIMIT_INVEST_WALLET_WINDOW_MS) || 60000;

  return createRedisRateLimiter({
    endpoint: `invest-${subEndpoint}`,
    ipLimit: { windowMs: ipWindow, maxRequests: ipMax },
    walletLimit: { windowMs: walletWindow, maxRequests: walletMax },
    ...options,
  });
}

export function createInvoiceSubmitRateLimiter(
  subEndpoint: string,
  options?: Partial<RedisRateLimiterOptions>
): RequestHandler {
  const ipMax = Number(process.env.RATE_LIMIT_INVOICE_SUBMIT_IP_MAX) || 30;
  const ipWindow = Number(process.env.RATE_LIMIT_INVOICE_SUBMIT_IP_WINDOW_MS) || 60000;
  const walletMax = Number(process.env.RATE_LIMIT_INVOICE_SUBMIT_WALLET_MAX) || 10;
  const walletWindow = Number(process.env.RATE_LIMIT_INVOICE_SUBMIT_WALLET_WINDOW_MS) || 60000;

  return createRedisRateLimiter({
    endpoint: `invoice-submit-${subEndpoint}`,
    ipLimit: { windowMs: ipWindow, maxRequests: ipMax },
    walletLimit: { windowMs: walletWindow, maxRequests: walletMax },
    ...options,
  });
}
