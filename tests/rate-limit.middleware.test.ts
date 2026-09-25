import express from "express";
import request from "supertest";
import type { Store } from "express-rate-limit";
import { applyRateLimiters, createRateLimitMiddleware } from "../src/middleware/rate-limit.middleware";
import { createErrorMiddleware } from "../src/middleware/error.middleware";
import type { AppLogger } from "../src/observability/logger";

function createLogger(): AppLogger & { error: jest.Mock; warn: jest.Mock } {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  } as unknown as AppLogger & { error: jest.Mock; warn: jest.Mock };
}

function failingStore(): Store {
  return {
    increment: async () => {
      throw new Error("redis unavailable");
    },
    decrement: async () => undefined,
    resetKey: async () => undefined,
  };
}

function createTestApp(
  logger: AppLogger,
  options: Parameters<typeof createRateLimitMiddleware>[1]
) {
  const app = express();
  app.use(createRateLimitMiddleware(logger, options));
  app.get("/resource", (_req, res) => res.json({ ok: true }));
  app.use(createErrorMiddleware(logger));
  return app;
}

describe("global rate limit middleware", () => {
  it("returns the configured code and standard retry headers", async () => {
    const logger = createLogger();
    const app = createTestApp(logger, {
      windowMs: 60_000,
      max: 1,
      code: "CUSTOM_LIMIT",
      message: "Slow down.",
    });

    await request(app).get("/resource").expect(200);
    const response = await request(app).get("/resource").expect(429);

    expect(response.body).toEqual({
      success: false,
      error: { code: "CUSTOM_LIMIT", message: "Slow down." },
    });
    expect(response.headers["retry-after"]).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "Rate limit exceeded.",
      expect.objectContaining({ path: "/resource" })
    );
  });

  it("fails closed and logs a shared-store outage", async () => {
    const logger = createLogger();
    const app = createTestApp(logger, { windowMs: 60_000, max: 10, store: failingStore() });

    const response = await request(app).get("/resource").expect(503);
    expect(response.body.error.code).toBe("RATE_LIMIT_STORE_UNAVAILABLE");
    expect(logger.error).toHaveBeenCalledWith(
      "Rate limit store failed.",
      expect.objectContaining({ error: "redis unavailable", failOpen: false })
    );
  });

  it("can explicitly fail open during a shared-store outage", async () => {
    const logger = createLogger();
    const app = createTestApp(logger, {
      windowMs: 60_000,
      max: 10,
      store: failingStore(),
      failOpenOnStoreError: true,
    });

    await request(app).get("/resource").expect(200, { ok: true });
  });

  it.each([
    { windowMs: 0, max: 1 },
    { windowMs: 1_000, max: 0 },
  ])("rejects invalid configuration: %j", (options) => {
    expect(() => createRateLimitMiddleware(createLogger(), options)).toThrow(
      "must be a positive integer"
    );
  });
});

describe("applyRateLimiters", () => {
  function createAppWithLimiters(
    logger: AppLogger,
    config?: Parameters<typeof applyRateLimiters>[2]
  ) {
    const app = express();
    applyRateLimiters(app, logger, config);
    app.get("/resource", (_req, res) => res.json({ ok: true }));
    app.get("/api/v1/auth/me", (_req, res) => res.json({ ok: true }));
    app.use(createErrorMiddleware(logger));
    return app;
  }

  it("applies the global limiter to every route when no auth config is given", async () => {
    const logger = createLogger();
    const app = createAppWithLimiters(logger, { global: { windowMs: 60_000, max: 1 } });

    await request(app).get("/resource").expect(200);
    await request(app).get("/resource").expect(429);
  });

  it("enforces a stricter auth-path limit on top of the global one (#385/#388)", async () => {
    const logger = createLogger();
    const app = createAppWithLimiters(logger, {
      global: { windowMs: 60_000, max: 100 },
      auth: { windowMs: 60_000, max: 1, code: "AUTH_RATE_LIMIT_EXCEEDED" },
    });

    // The global limit (100) would not trip here, but the auth-scoped one (1) does.
    await request(app).get("/api/v1/auth/me").expect(200);
    const limited = await request(app).get("/api/v1/auth/me").expect(429);
    expect(limited.body.error.code).toBe("AUTH_RATE_LIMIT_EXCEEDED");

    // A route outside the auth prefix is unaffected by the auth-scoped limiter.
    await request(app).get("/resource").expect(200);
  });

  it("does not affect non-auth routes when only auth config is given", async () => {
    const logger = createLogger();
    const app = createAppWithLimiters(logger, {
      auth: { windowMs: 60_000, max: 1 },
    });

    await request(app).get("/resource").expect(200);
    await request(app).get("/resource").expect(200);
  });
});
