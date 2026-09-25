import express from "express";
import request from "supertest";
import type { Store } from "express-rate-limit";
import {
  applyRateLimiters,
  createChallengeRateLimitMiddleware,
  createRateLimitMiddleware,
} from "../src/middleware/rate-limit.middleware";
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

  it("fails closed when the shared store hangs past storeTimeoutMs", async () => {
    const logger = createLogger();
    const hangingStore: Store = {
      increment: () => new Promise(() => undefined),
      decrement: async () => undefined,
      resetKey: async () => undefined,
    };
    const app = createTestApp(logger, {
      windowMs: 60_000,
      max: 10,
      store: hangingStore,
      storeTimeoutMs: 25,
    });

    const response = await request(app).get("/resource").expect(503);
    expect(response.body.error.code).toBe("RATE_LIMIT_STORE_UNAVAILABLE");
    expect(logger.error).toHaveBeenCalledWith(
      "Rate limit store failed.",
      expect.objectContaining({ reason: "timeout", failOpen: false })
    );
  });

  it("fails open on a store timeout when configured to", async () => {
    const logger = createLogger();
    const app = createTestApp(logger, {
      windowMs: 60_000,
      max: 10,
      store: {
        increment: () => new Promise(() => undefined),
        decrement: async () => undefined,
        resetKey: async () => undefined,
      },
      storeTimeoutMs: 25,
      failOpenOnStoreError: true,
    });

    await request(app).get("/resource").expect(200, { ok: true });
  });

  it("forwards init() to a wrapped store so it learns the window", async () => {
    const init = jest.fn();
    const hits = new Map<string, number>();
    const store: Store = {
      init,
      increment: async (key) => {
        const totalHits = (hits.get(key) ?? 0) + 1;
        hits.set(key, totalHits);
        return { totalHits, resetTime: new Date(Date.now() + 60_000) };
      },
      decrement: async () => undefined,
      resetKey: async () => undefined,
    };
    const app = createTestApp(createLogger(), { windowMs: 30_000, max: 1, store });

    await request(app).get("/resource").expect(200);
    await request(app).get("/resource").expect(429);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ windowMs: 30_000 }));
  });

  it("falls back to the client IP when a custom key generator throws", async () => {
    const logger = createLogger();
    const app = createTestApp(logger, {
      windowMs: 60_000,
      max: 1,
      keyGenerator: () => {
        throw new Error("header missing");
      },
    });

    await request(app).get("/resource").expect(200);
    // Still limited, and never misreported as a store outage.
    await request(app).get("/resource").expect(429);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Rate limit key generator failed; falling back to client IP.",
      expect.objectContaining({ error: "header missing" })
    );
  });

  it("falls back to the client IP when a custom key generator returns an empty key", async () => {
    const logger = createLogger();
    const app = createTestApp(logger, { windowMs: 60_000, max: 1, keyGenerator: () => "  " });

    await request(app).get("/resource").expect(200);
    await request(app).get("/resource").expect(429);
  });

  it("hashes oversized keys so clients cannot inflate store memory", async () => {
    const seen: string[] = [];
    const store: Store = {
      increment: async (key) => {
        seen.push(key);
        return { totalHits: 1, resetTime: new Date(Date.now() + 60_000) };
      },
      decrement: async () => undefined,
      resetKey: async () => undefined,
    };
    const app = createTestApp(createLogger(), {
      windowMs: 60_000,
      max: 10,
      store,
      keyGenerator: () => "x".repeat(5_000),
    });

    await request(app).get("/resource").expect(200);
    expect(seen[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    [{ windowMs: 1_000, max: 1, store: {} as Store }, "store must implement increment()"],
    [{ windowMs: 1_000, max: 1, storeTimeoutMs: -5 }, "storeTimeoutMs must be a positive integer"],
    [{ windowMs: "1000" as unknown as number, max: 1 }, "windowMs must be a positive integer"],
  ])("rejects invalid configuration at startup: %j", (options, error) => {
    expect(() => createRateLimitMiddleware(createLogger(), options)).toThrow(error);
  });
});

describe("rate limiter factories", () => {
  it("applyRateLimiters ignores undefined overrides instead of erasing defaults", () => {
    const use = jest.fn();
    expect(() =>
      applyRateLimiters({ use }, createLogger(), { global: { max: undefined, windowMs: 1_000 } })
    ).not.toThrow();
    expect(use).toHaveBeenCalledTimes(1);
  });

  it("keeps the challenge defaults and accepts overrides", async () => {
    const app = express();
    app.use(createChallengeRateLimitMiddleware(createLogger(), { max: 1 }));
    app.get("/resource", (_req, res) => res.json({ ok: true }));
    app.use(createErrorMiddleware(createLogger()));

    await request(app).get("/resource").expect(200);
    const response = await request(app).get("/resource").expect(429);
    expect(response.body.error.code).toBe("CHALLENGE_RATE_LIMIT_EXCEEDED");
  });
});
