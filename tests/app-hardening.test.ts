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

describe("App hardening", () => {
  it("fails closed for browser origins when production CORS allowlist is empty", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      http: {
        nodeEnv: "production",
        corsAllowedOrigins: [],
      },
    });

    const response = await request(app)
      .get("/health")
      .set("Origin", "https://evil.example")
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows configured production origins and sets trust proxy", async () => {
    const app = createApp({
      authService: createAuthServiceStub(),
      http: {
        nodeEnv: "production",
        trustProxy: 1,
        corsAllowedOrigins: ["https://app.stellarstate.example"],
        corsAllowCredentials: true,
      },
    });

    const response = await request(app)
      .get("/health")
      .set("Origin", "https://app.stellarstate.example")
      .expect(200);

    expect(app.get("trust proxy")).toBe(1);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://app.stellarstate.example"
    );
  });

  it("waits for in-flight requests to drain before resolving shutdown tracking", async () => {
    const tracker = createRequestLifecycleTracker();

    tracker.onRequestStart();
    const drainPromise = tracker.waitForDrain(100);

    setTimeout(() => {
      tracker.onRequestEnd();
    }, 20);

    await expect(drainPromise).resolves.toBe(true);
  });
});
