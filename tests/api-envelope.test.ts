import request from "supertest";
import { createApp, createRequestLifecycleTracker } from "../src/app";
import type { AuthService } from "../src/services/auth.service";

function createAuthServiceStub(): AuthService {
  return {
    createChallenge: async () => {
      throw new Error("Not implemented.");
    },
    verifyChallenge: async () => {
      throw new Error("Not implemented.");
    },
    getCurrentUser: async () => {
      throw new Error("Not implemented.");
    },
  } as unknown as AuthService;
}

describe("Response envelope", () => {
  it("returns success envelope from /health", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      metricsEnabled: false,
      http: {
        rateLimit: {
          enabled: false,
        },
      },
    });

    const response = await request(app).get("/health").expect(200);

    expect(response.body).toMatchObject({
      success: true,
      data: {
        status: "ok",
        timestamp: expect.any(String),
        uptimeSeconds: expect.any(Number),
        requestId: expect.any(String),
      },
    });
    expect(response.body.error).toBeUndefined();
  });

  it("returns error envelope for unknown routes (404)", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      metricsEnabled: false,
      http: {
        rateLimit: {
          enabled: false,
        },
      },
    });

    const response = await request(app).get("/nonexistent-route").expect(404);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: expect.any(String),
        message: expect.any(String),
      },
    });
    expect(response.body.data).toBeUndefined();
  });

  it("returns error envelope for unhandled errors (500)", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      metricsEnabled: false,
      http: {
        rateLimit: {
          enabled: false,
        },
      },
    });

    // Add a route that throws an error before the error middleware is applied
    // We use the router pattern to ensure the route is matched before notFoundMiddleware
    const router = request.agent(app);

    // Simulate an internal error by accessing a route that will throw
    // Since we can't add routes after app creation, we'll test via the auth routes
    // which will throw an error from the stub service
    const response = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: "test" })
      .expect(500);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: expect.any(String),
        message: expect.any(String),
      },
    });
  });
});

describe("Health endpoints", () => {
  it("GET /health returns 200 with status ok", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      metricsEnabled: false,
      http: {
        rateLimit: {
          enabled: false,
        },
      },
    });

    const response = await request(app).get("/health").expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data?.status).toBe("ok");
    expect(response.body.data?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(typeof response.body.data?.uptimeSeconds).toBe("number");
  });

  it("GET /health/db returns 503 when DB is not initialized", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      metricsEnabled: false,
      http: {
        rateLimit: {
          enabled: false,
        },
      },
    });

    const response = await request(app).get("/health/db").expect(503);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: "DB_NOT_INITIALIZED",
        message: "Database connection is not initialized.",
      },
    });
  }, 15000);
});

describe("Rate limiting", () => {
  it("applies global rate limiter when enabled", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      metricsEnabled: false,
      http: {
        rateLimit: {
          enabled: true,
          windowMs: 1000,
          max: 2,
        },
      },
    });

    await request(app).get("/health").expect(200);
    await request(app).get("/health").expect(200);

    const response = await request(app).get("/health").expect(429);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: expect.any(String),
        message: expect.any(String),
      },
    });
  });

  it("skips rate limiting when disabled", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      metricsEnabled: false,
      http: {
        rateLimit: {
          enabled: false,
        },
      },
    });

    for (let i = 0; i < 10; i++) {
      await request(app).get("/health").expect(200);
    }
  });
});

describe("CORS configuration", () => {
  it("allows configured CORS origins", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      metricsEnabled: false,
      http: {
        nodeEnv: "production",
        corsAllowedOrigins: ["https://example.com"],
        corsAllowCredentials: true,
        rateLimit: {
          enabled: false,
        },
      },
    });

    const response = await request(app)
      .get("/health")
      .set("Origin", "https://example.com")
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBe("https://example.com");
  });

  it("blocks unconfigured origins in production", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      metricsEnabled: false,
      http: {
        nodeEnv: "production",
        corsAllowedOrigins: [],
        corsAllowCredentials: false,
        rateLimit: {
          enabled: false,
        },
      },
    });

    const response = await request(app)
      .get("/health")
      .set("Origin", "https://evil.com")
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("Security headers (helmet)", () => {
  it("sets security headers via helmet", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      metricsEnabled: false,
      http: {
        rateLimit: {
          enabled: false,
        },
      },
    });

    const response = await request(app).get("/health").expect(200);

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});

describe("API v1 routing", () => {
  it("mounts auth routes under /api/v1/auth", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      metricsEnabled: false,
      http: {
        rateLimit: {
          enabled: false,
        },
      },
    });

    const response = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" })
      .expect(500);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: expect.any(String),
        message: expect.any(String),
      },
    });
  });

  it("returns 404 for routes outside /api/v1", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      metricsEnabled: false,
      http: {
        rateLimit: {
          enabled: false,
        },
      },
    });

    const response = await request(app).get("/api/v2/unknown").expect(404);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: expect.any(String),
        message: expect.any(String),
      },
    });
  });
});
