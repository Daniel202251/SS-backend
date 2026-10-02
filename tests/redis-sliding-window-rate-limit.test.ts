import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { checkSlidingWindow, SLIDING_WINDOW_LUA_SCRIPT } from "../src/lib/redis-sliding-window";
import {
  createRedisRateLimiter,
  createAuthRateLimiter,
  createInvestRateLimiter,
  createInvoiceSubmitRateLimiter,
  getClientIp,
  extractWalletAddress,
  resolveThreshold,
} from "../src/middleware/redis-rate-limit.middleware";
import { setRedisClient } from "../src/config/redis";
import { createErrorMiddleware } from "../src/middleware/error.middleware";
import { logger } from "../src/observability/logger";
import { KYCStatus, UserType } from "../src/types/enums";

describe("Redis Sliding Window Rate Limiting", () => {
  const TEST_SECRET = "test-secret-redis-rate-limit";
  const WALLET_A = "GAWalletA123456789012345678901234567890123456789012345";
  const WALLET_B = "GBWalletB123456789012345678901234567890123456789012345";

  let redisMock: Redis;

  function createToken(walletAddress: string): string {
    return jwt.sign({ sub: walletAddress, stellarAddress: walletAddress }, TEST_SECRET);
  }

  function createAuthApp(limiter: express.RequestHandler) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        try {
          const payload = jwt.verify(token, TEST_SECRET) as any;
          (req as any).user = {
            id: payload.sub,
            stellarAddress: payload.stellarAddress,
            email: null,
            userType: UserType.INVESTOR,
            kycStatus: KYCStatus.APPROVED,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        } catch {
          // ignore
        }
      }
      next();
    });

    app.post("/test-endpoint", limiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    app.use(createErrorMiddleware(logger));
    return app;
  }

  beforeEach(() => {
    redisMock = new RedisMock() as unknown as Redis;
    setRedisClient(redisMock);
    delete process.env.RATE_LIMIT_TEST_EP_IP_MAX;
    delete process.env.RATE_LIMIT_TEST_EP_IP_WINDOW_MS;
    delete process.env.RATE_LIMIT_TEST_EP_WALLET_MAX;
    delete process.env.RATE_LIMIT_TEST_EP_WALLET_WINDOW_MS;
  });

  afterEach(async () => {
    await redisMock.flushall();
  });

  describe("checkSlidingWindow engine", () => {
    it("should allow requests up to maxRequests and then reject with 429 calculation", async () => {
      const key = "test:sliding:window:1";
      const windowMs = 5000;
      const maxRequests = 3;

      // 1st request
      const r1 = await checkSlidingWindow({ key, windowMs, maxRequests, client: redisMock });
      expect(r1.allowed).toBe(true);
      expect(r1.currentCount).toBe(1);
      expect(r1.remaining).toBe(2);

      // 2nd request
      const r2 = await checkSlidingWindow({ key, windowMs, maxRequests, client: redisMock });
      expect(r2.allowed).toBe(true);
      expect(r2.currentCount).toBe(2);
      expect(r2.remaining).toBe(1);

      // 3rd request
      const r3 = await checkSlidingWindow({ key, windowMs, maxRequests, client: redisMock });
      expect(r3.allowed).toBe(true);
      expect(r3.currentCount).toBe(3);
      expect(r3.remaining).toBe(0);

      // 4th request (should exceed limit)
      const r4 = await checkSlidingWindow({ key, windowMs, maxRequests, client: redisMock });
      expect(r4.allowed).toBe(false);
      expect(r4.currentCount).toBe(3);
      expect(r4.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });

    it("should reset counters correctly after window expires", async () => {
      const key = "test:sliding:window:expiry";
      const windowMs = 150;
      const maxRequests = 2;

      const r1 = await checkSlidingWindow({ key, windowMs, maxRequests, client: redisMock });
      expect(r1.allowed).toBe(true);
      const r2 = await checkSlidingWindow({ key, windowMs, maxRequests, client: redisMock });
      expect(r2.allowed).toBe(true);

      const r3 = await checkSlidingWindow({ key, windowMs, maxRequests, client: redisMock });
      expect(r3.allowed).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 200));

      // After expiry, quota should be completely reset
      const r4 = await checkSlidingWindow({ key, windowMs, maxRequests, client: redisMock });
      expect(r4.allowed).toBe(true);
      expect(r4.currentCount).toBe(1);
    });

    it("should fall back to allow-all without crashing when Redis fails", async () => {
      const faultyClient = {
        eval: jest.fn().mockRejectedValue(new Error("Redis connection lost")),
      } as unknown as Redis;

      const result = await checkSlidingWindow({
        key: "test:faulty",
        windowMs: 60000,
        maxRequests: 5,
        client: faultyClient,
      });

      expect(result.allowed).toBe(true);
      expect(result.fallback).toBe(true);
    });
  });

  describe("createRedisRateLimiter middleware", () => {
    it("should return 429 with Retry-After header when IP limit is exceeded", async () => {
      const limiter = createRedisRateLimiter({
        endpoint: "test-ip-limit",
        ipLimit: { windowMs: 60000, maxRequests: 2 },
        walletLimit: { windowMs: 60000, maxRequests: 10 },
        client: redisMock,
      });
      const app = createAuthApp(limiter);

      await request(app).post("/test-endpoint").expect(200);
      await request(app).post("/test-endpoint").expect(200);

      // 3rd request from same IP should fail
      const res = await request(app).post("/test-endpoint").expect(429);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: expect.stringContaining("Too many requests"),
        },
      });
    });

    it("should return 429 with Retry-After header when Wallet limit is exceeded", async () => {
      const limiter = createRedisRateLimiter({
        endpoint: "test-wallet-limit",
        ipLimit: { windowMs: 60000, maxRequests: 50 },
        walletLimit: { windowMs: 60000, maxRequests: 2 },
        client: redisMock,
      });
      const app = createAuthApp(limiter);
      const token = createToken(WALLET_A);

      await request(app).post("/test-endpoint").set("Authorization", `Bearer ${token}`).expect(200);
      await request(app).post("/test-endpoint").set("Authorization", `Bearer ${token}`).expect(200);

      // 3rd request with same wallet should fail
      const res = await request(app)
        .post("/test-endpoint")
        .set("Authorization", `Bearer ${token}`)
        .expect(429);

      expect(res.headers["retry-after"]).toBeDefined();
      expect(res.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    });

    it("should apply per-wallet limits independently from per-IP limits", async () => {
      const limiter = createRedisRateLimiter({
        endpoint: "test-independent",
        ipLimit: { windowMs: 60000, maxRequests: 10 },
        walletLimit: { windowMs: 60000, maxRequests: 2 },
        client: redisMock,
      });
      const app = createAuthApp(limiter);
      const tokenA = createToken(WALLET_A);
      const tokenB = createToken(WALLET_B);

      // Exhaust Wallet A quota from default IP (127.0.0.1)
      await request(app)
        .post("/test-endpoint")
        .set("Authorization", `Bearer ${tokenA}`)
        .expect(200);
      await request(app)
        .post("/test-endpoint")
        .set("Authorization", `Bearer ${tokenA}`)
        .expect(200);
      await request(app)
        .post("/test-endpoint")
        .set("Authorization", `Bearer ${tokenA}`)
        .expect(429);

      // Wallet B from the SAME IP should still have full quota!
      await request(app)
        .post("/test-endpoint")
        .set("Authorization", `Bearer ${tokenB}`)
        .expect(200);
      await request(app)
        .post("/test-endpoint")
        .set("Authorization", `Bearer ${tokenB}`)
        .expect(200);
      await request(app)
        .post("/test-endpoint")
        .set("Authorization", `Bearer ${tokenB}`)
        .expect(429);
    });

    it("should share wallet limit across different IPs", async () => {
      const limiter = createRedisRateLimiter({
        endpoint: "test-wallet-cross-ip",
        ipLimit: { windowMs: 60000, maxRequests: 10 },
        walletLimit: { windowMs: 60000, maxRequests: 2 },
        client: redisMock,
      });
      const app = createAuthApp(limiter);
      const tokenA = createToken(WALLET_A);

      // Request from IP 1
      await request(app)
        .post("/test-endpoint")
        .set("X-Forwarded-For", "198.51.100.1")
        .set("Authorization", `Bearer ${tokenA}`)
        .expect(200);

      // Request from IP 2 with same wallet
      await request(app)
        .post("/test-endpoint")
        .set("X-Forwarded-For", "198.51.100.2")
        .set("Authorization", `Bearer ${tokenA}`)
        .expect(200);

      // 3rd request from IP 3 with same wallet must be rate limited!
      await request(app)
        .post("/test-endpoint")
        .set("X-Forwarded-For", "198.51.100.3")
        .set("Authorization", `Bearer ${tokenA}`)
        .expect(429);
    });

    it("should extract wallet address from request body for unauthenticated auth endpoints", async () => {
      const limiter = createRedisRateLimiter({
        endpoint: "test-auth-body",
        ipLimit: { windowMs: 60000, maxRequests: 10 },
        walletLimit: { windowMs: 60000, maxRequests: 2 },
        client: redisMock,
      });
      const app = createAuthApp(limiter);

      // Requests with publicKey in body
      await request(app).post("/test-endpoint").send({ publicKey: WALLET_A }).expect(200);
      await request(app).post("/test-endpoint").send({ publicKey: WALLET_A }).expect(200);

      // 3rd request for WALLET_A should hit wallet rate limit
      await request(app).post("/test-endpoint").send({ publicKey: WALLET_A }).expect(429);

      // WALLET_B in body should still succeed
      await request(app).post("/test-endpoint").send({ publicKey: WALLET_B }).expect(200);
    });

    it("should allow request to proceed without crashing when Redis fails", async () => {
      const brokenRedis = {
        eval: jest.fn().mockRejectedValue(new Error("Connection timeout")),
      } as unknown as Redis;

      const limiter = createRedisRateLimiter({
        endpoint: "test-broken-redis",
        ipLimit: { windowMs: 60000, maxRequests: 1 },
        walletLimit: { windowMs: 60000, maxRequests: 1 },
        client: brokenRedis,
      });
      const app = createAuthApp(limiter);

      // Even with broken Redis, requests succeed (fall back to allow-all)
      await request(app).post("/test-endpoint").expect(200);
      await request(app).post("/test-endpoint").expect(200);
    });

    it("should configure limit thresholds via environment variables without code changes", () => {
      process.env.RATE_LIMIT_TEST_EP_IP_MAX = "7";
      process.env.RATE_LIMIT_TEST_EP_IP_WINDOW_MS = "30000";
      process.env.RATE_LIMIT_TEST_EP_WALLET_MAX = "3";
      process.env.RATE_LIMIT_TEST_EP_WALLET_WINDOW_MS = "45000";

      const ipThresh = resolveThreshold("test-ep", "ip", { windowMs: 60000, maxRequests: 100 });
      expect(ipThresh.maxRequests).toBe(7);
      expect(ipThresh.windowMs).toBe(30000);

      const walletThresh = resolveThreshold("test-ep", "wallet", {
        windowMs: 60000,
        maxRequests: 20,
      });
      expect(walletThresh.maxRequests).toBe(3);
      expect(walletThresh.windowMs).toBe(45000);
    });
  });

  describe("Sensitive Endpoint Helper Factories", () => {
    it("createAuthRateLimiter should enforce configured auth limits", async () => {
      const limiter = createAuthRateLimiter("challenge", {
        client: redisMock,
        ipLimit: { windowMs: 60000, maxRequests: 2 },
        walletLimit: { windowMs: 60000, maxRequests: 2 },
      });
      const app = createAuthApp(limiter);

      await request(app).post("/test-endpoint").send({ publicKey: WALLET_A }).expect(200);
      await request(app).post("/test-endpoint").send({ publicKey: WALLET_A }).expect(200);
      await request(app).post("/test-endpoint").send({ publicKey: WALLET_A }).expect(429);
    });

    it("createInvestRateLimiter should enforce configured invest limits", async () => {
      const limiter = createInvestRateLimiter("create", {
        client: redisMock,
        ipLimit: { windowMs: 60000, maxRequests: 10 },
        walletLimit: { windowMs: 60000, maxRequests: 2 },
      });
      const app = createAuthApp(limiter);
      const token = createToken(WALLET_A);

      await request(app).post("/test-endpoint").set("Authorization", `Bearer ${token}`).expect(200);
      await request(app).post("/test-endpoint").set("Authorization", `Bearer ${token}`).expect(200);
      await request(app).post("/test-endpoint").set("Authorization", `Bearer ${token}`).expect(429);
    });

    it("createInvoiceSubmitRateLimiter should enforce configured invoice submit limits", async () => {
      const limiter = createInvoiceSubmitRateLimiter("submit", {
        client: redisMock,
        ipLimit: { windowMs: 60000, maxRequests: 10 },
        walletLimit: { windowMs: 60000, maxRequests: 2 },
      });
      const app = createAuthApp(limiter);
      const token = createToken(WALLET_A);

      await request(app).post("/test-endpoint").set("Authorization", `Bearer ${token}`).expect(200);
      await request(app).post("/test-endpoint").set("Authorization", `Bearer ${token}`).expect(200);
      await request(app).post("/test-endpoint").set("Authorization", `Bearer ${token}`).expect(429);
    });
  });

  describe("Utility functions", () => {
    it("getClientIp should read X-Forwarded-For if present", () => {
      const req = {
        headers: { "x-forwarded-for": "203.0.113.195, 70.41.3.18" },
      } as unknown as express.Request;
      expect(getClientIp(req)).toBe("203.0.113.195");
    });

    it("extractWalletAddress should check user stellarAddress, publicKey, and body", () => {
      expect(
        extractWalletAddress({
          user: { stellarAddress: "G_STELLAR_ADDR" },
        } as unknown as express.Request)
      ).toBe("G_STELLAR_ADDR");

      expect(
        extractWalletAddress({
          body: { publicKey: "G_PUB_KEY" },
        } as unknown as express.Request)
      ).toBe("G_PUB_KEY");

      expect(
        extractWalletAddress({
          body: { walletAddress: "G_WALLET_ADDR" },
        } as unknown as express.Request)
      ).toBe("G_WALLET_ADDR");

      expect(
        extractWalletAddress({
          body: {},
        } as unknown as express.Request)
      ).toBeNull();
    });
  });
});
