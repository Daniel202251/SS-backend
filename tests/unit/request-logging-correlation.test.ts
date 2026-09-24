import express from "express";
import request from "supertest";
import winston from "winston";
import Transport from "winston-transport";
import { MESSAGE } from "triple-beam";

import { createRequestObservabilityMiddleware } from "../../src/middleware/request-observability.middleware";
import { correlationIdFormat, createLogger } from "../../src/observability/logger";
import { MetricsRegistry } from "../../src/observability/metrics";
import { redactionFormat } from "../../src/observability/redaction-formatter";
import {
  CORRELATION_ID_HEADER,
  getCorrelationId,
  withCorrelationHeaders,
} from "../../src/observability/request-context";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Winston hands entries to its transports through piped streams, which
// deliver on a later tick; let them drain before reading the capture.
const flushLogs = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Builds a logger with the production format pipeline whose output is
 * captured as raw lines, so the tests check exactly what a log aggregator
 * would receive.
 */
function createCapturingLogger() {
  const lines: string[] = [];
  // Records the fully formatted line, i.e. the exact string the Console
  // transport would print.
  const transport = new (class extends Transport {
    log(info: Record<string | symbol, unknown>, callback: () => void) {
      lines.push(info[MESSAGE] as string);
      callback();
    }
  })();

  const base = winston.createLogger({
    level: "debug",
    defaultMeta: { service: "stellarsettle-api" },
    format: winston.format.combine(
      correlationIdFormat(),
      redactionFormat(),
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    transports: [transport],
  });

  return {
    logger: createLogger(base),
    entries: async () => {
      await flushLogs();
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    raw: async () => {
      await flushLogs();
      return lines.join("\n");
    },
  };
}

function buildApp(capture: ReturnType<typeof createCapturingLogger>) {
  const app = express();
  app.use(
    createRequestObservabilityMiddleware({
      logger: capture.logger,
      metricsEnabled: false,
      metricsRegistry: new MetricsRegistry(),
    })
  );
  app.use(express.json());

  app.get("/api/v1/things/:id", (req, res) => {
    res.status(200).json({ id: req.params.id });
  });

  // Logs from deep inside a handler, after an async hop, to prove the
  // correlation ID follows the request through the call chain.
  app.post("/api/v1/things", async (req, res) => {
    await new Promise((resolve) => setImmediate(resolve));
    capture.logger.info("Handling thing creation.", {
      authorization: req.headers.authorization,
      walletSecretKey: req.body.walletSecretKey,
      note: `seed is ${req.body.walletSecretKey}`,
    });
    res.status(201).json({
      correlationId: getCorrelationId(),
      outboundHeaders: withCorrelationHeaders({ "content-type": "application/json" }),
    });
  });

  app.get("/boom", () => {
    throw new Error("kaboom");
  });

  return app;
}

async function accessLogs(capture: ReturnType<typeof createCapturingLogger>) {
  return (await capture.entries()).filter((entry) => entry.message === "HTTP request completed.");
}

describe("structured request logging with correlation IDs (#466)", () => {
  it("logs method, path, status and duration for every request as JSON", async () => {
    const capture = createCapturingLogger();
    const app = buildApp(capture);

    await request(app).get("/api/v1/things/42?token=abc").expect(200);
    await request(app).get("/does-not-exist").expect(404);

    const logs = await accessLogs(capture);
    expect(logs).toHaveLength(2);

    expect(logs[0]).toMatchObject({
      level: "info",
      method: "GET",
      path: "/api/v1/things/42",
      route: "/api/v1/things/:id",
      statusCode: 200,
      service: "stellarsettle-api",
    });
    expect(typeof logs[0].durationMs).toBe("number");
    expect(logs[0].timestamp).toEqual(expect.any(String));

    expect(logs[1]).toMatchObject({ method: "GET", path: "/does-not-exist", statusCode: 404 });
  });

  it("never logs the query string, which can carry credentials", async () => {
    const capture = createCapturingLogger();
    await request(buildApp(capture)).get("/api/v1/things/1?token=super-secret").expect(200);

    expect(await capture.raw()).not.toContain("super-secret");
  });

  it("generates a UUID correlation ID and returns it in the response headers", async () => {
    const capture = createCapturingLogger();
    const response = await request(buildApp(capture)).get("/api/v1/things/1").expect(200);

    const correlationId = response.headers[CORRELATION_ID_HEADER];
    expect(correlationId).toMatch(UUID_PATTERN);
    expect(response.headers["x-request-id"]).toBe(correlationId);
    expect((await accessLogs(capture))[0].correlationId).toBe(correlationId);
  });

  it("gives concurrent requests distinct correlation IDs", async () => {
    const capture = createCapturingLogger();
    const app = buildApp(capture);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request(app).get("/api/v1/things/1"))
    );
    const ids = responses.map((response) => response.headers[CORRELATION_ID_HEADER]);

    expect(new Set(ids).size).toBe(5);
    expect((await accessLogs(capture)).map((entry) => entry.correlationId)).toEqual(
      expect.arrayContaining(ids)
    );
  });

  it("reuses an upstream X-Correlation-Id, falling back to X-Request-Id", async () => {
    const capture = createCapturingLogger();
    const app = buildApp(capture);

    const fromCorrelation = await request(app)
      .get("/api/v1/things/1")
      .set("X-Correlation-Id", "upstream-abc-123")
      .set("X-Request-Id", "ignored")
      .expect(200);
    expect(fromCorrelation.headers[CORRELATION_ID_HEADER]).toBe("upstream-abc-123");

    const fromRequestId = await request(app)
      .get("/api/v1/things/1")
      .set("X-Request-Id", "client-req-9")
      .expect(200);
    expect(fromRequestId.headers[CORRELATION_ID_HEADER]).toBe("client-req-9");
  });

  it("replaces inbound IDs that could inject into headers or logs", async () => {
    const capture = createCapturingLogger();
    const response = await request(buildApp(capture))
      .get("/api/v1/things/1")
      .set("X-Correlation-Id", '"}{"level":"error","forged":"yes')
      .expect(200);

    expect(response.headers[CORRELATION_ID_HEADER]).toMatch(UUID_PATTERN);
    expect(await capture.raw()).not.toContain("forged");
  });

  it("stamps logs written inside handlers and propagates the ID to downstream calls", async () => {
    const capture = createCapturingLogger();
    const response = await request(buildApp(capture))
      .post("/api/v1/things")
      .set("X-Correlation-Id", "trace-777")
      .send({ walletSecretKey: "S" + "A".repeat(55) })
      .expect(201);

    expect(response.body.correlationId).toBe("trace-777");
    expect(response.body.outboundHeaders).toEqual({
      "content-type": "application/json",
      [CORRELATION_ID_HEADER]: "trace-777",
    });

    const handlerLog = (await capture.entries()).find(
      (entry) => entry.message === "Handling thing creation."
    );
    expect(handlerLog?.correlationId).toBe("trace-777");
  });

  it("redacts authorization tokens and wallet keys from log output", async () => {
    const capture = createCapturingLogger();
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
    const walletSecret = "S" + "B".repeat(55);

    await request(buildApp(capture))
      .post("/api/v1/things")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ walletSecretKey: walletSecret })
      .expect(201);

    const raw = await capture.raw();
    expect(raw).not.toContain(jwt);
    expect(raw).not.toContain(walletSecret);

    const handlerLog = (await capture.entries()).find(
      (entry) => entry.message === "Handling thing creation."
    );
    expect(handlerLog).toMatchObject({
      authorization: "[REDACTED]",
      walletSecretKey: "[REDACTED]",
    });
  });

  it("redacts sensitive keys regardless of casing or separator style", async () => {
    const capture = createCapturingLogger();
    capture.logger.info("headers", {
      headers: { Authorization: "Bearer abc", "X-Admin-Key": "admin-secret", Cookie: "sid=1" },
      wallet_private_key: "pk-value",
      investorWallet: "GABCDEF",
    });

    const [entry] = await capture.entries();
    expect(entry.headers).toEqual({
      Authorization: "[REDACTED]",
      "X-Admin-Key": "[REDACTED]",
      Cookie: "[REDACTED]",
    });
    expect(entry.wallet_private_key).toBe("[REDACTED]");
    // Public wallet addresses are not secrets and stay readable.
    expect(entry.investorWallet).toBe("GABCDEF");
  });

  it("still logs requests that fail with an unhandled error", async () => {
    const capture = createCapturingLogger();
    const app = buildApp(capture);
    app.use(
      (
        _err: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
      ) => {
        res.status(500).json({ error: "internal" });
      }
    );

    const response = await request(app).get("/boom").expect(500);

    const [log] = await accessLogs(capture);
    expect(log).toMatchObject({ method: "GET", path: "/boom", statusCode: 500 });
    expect(log.correlationId).toBe(response.headers[CORRELATION_ID_HEADER]);
  });

  it("leaves outbound headers untouched outside a request", () => {
    expect(getCorrelationId()).toBeUndefined();
    expect(withCorrelationHeaders({ a: "b" })).toEqual({ a: "b" });
  });
});
