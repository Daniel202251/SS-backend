import express from "express";
import request from "supertest";
import type { Store } from "express-rate-limit";
import { createRateLimitMiddleware } from "../src/middleware/rate-limit.middleware";
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
