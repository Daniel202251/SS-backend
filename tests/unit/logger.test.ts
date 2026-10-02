import winston from "winston";
import {
  createLogger,
  normalizeLogMetadata,
  withErrorLogging,
  correlationIdFormat,
} from "../../src/observability/logger";
import { runWithRequestContext } from "../../src/observability/request-context";

describe("Logger and Observability Hardening", () => {
  describe("normalizeLogMetadata", () => {
    it("returns empty object for undefined or null", () => {
      expect(normalizeLogMetadata(undefined)).toEqual({});
      expect(normalizeLogMetadata(null)).toEqual({});
    });

    it("wraps primitives in value property", () => {
      expect(normalizeLogMetadata("some string")).toEqual({ value: "some string" });
      expect(normalizeLogMetadata(42)).toEqual({ value: 42 });
      expect(normalizeLogMetadata(true)).toEqual({ value: true });
    });

    it("converts BigInt values to string to prevent JSON serialization crash", () => {
      const metadata = {
        amountStroops: 10000000n,
        details: { fee: 500n },
        list: [1n, 2n],
      };
      const normalized = normalizeLogMetadata(metadata);
      expect(normalized).toEqual({
        amountStroops: "10000000",
        details: { fee: "500" },
        list: ["1", "2"],
      });
      expect(() => JSON.stringify(normalized)).not.toThrow();
    });

    it("safely handles circular references without throwing", () => {
      const circular: Record<string, unknown> = { name: "test" };
      circular.self = circular;

      expect(() => normalizeLogMetadata(circular)).not.toThrow();
      const normalized = normalizeLogMetadata(circular);
      expect(normalized.name).toBe("test");
      expect(normalized.self).toBe("[Circular]");
    });

    it("extracts Error properties including stack and custom properties", () => {
      const err = new Error("Something exploded");
      (err as unknown as { code: string; status: number }).code = "EXPLOSION";
      (err as unknown as { code: string; status: number }).status = 500;

      const normalized = normalizeLogMetadata(err);
      expect(normalized.name).toBe("Error");
      expect(normalized.message).toBe("Something exploded");
      expect(normalized.stack).toBeDefined();
      expect(normalized.code).toBe("EXPLOSION");
      expect(normalized.status).toBe(500);
    });

    it("handles deeply nested structures without crashing", () => {
      let current: Record<string, unknown> = { level: 0 };
      const root = current;
      for (let i = 1; i <= 20; i++) {
        const next: Record<string, unknown> = { level: i };
        current.child = next;
        current = next;
      }

      expect(() => normalizeLogMetadata(root)).not.toThrow();
    });
  });

  describe("WinstonAppLogger resilience", () => {
    let mockWinston: winston.Logger;
    let entries: Array<{ level: string; msg: string; meta: unknown }>;

    beforeEach(() => {
      entries = [];
      mockWinston = {
        debug: jest.fn((msg, meta) => entries.push({ level: "debug", msg, meta })),
        info: jest.fn((msg, meta) => entries.push({ level: "info", msg, meta })),
        warn: jest.fn((msg, meta) => entries.push({ level: "warn", msg, meta })),
        error: jest.fn((msg, meta) => entries.push({ level: "error", msg, meta })),
        child: jest.fn(() => mockWinston),
      } as unknown as winston.Logger;
    });

    it("logs debug, info, warn, and error with normalized metadata", () => {
      const logger = createLogger(mockWinston);

      logger.debug("debug message", { debugKey: "val" });
      logger.info("info message", { count: 10n });
      logger.warn("warn message");
      logger.error("error message", { err: new Error("boom") });

      expect(entries).toHaveLength(4);
      expect(entries[0]).toEqual({
        level: "debug",
        msg: "debug message",
        meta: { debugKey: "val" },
      });
      expect(entries[1]).toEqual({
        level: "info",
        msg: "info message",
        meta: { count: "10" },
      });
      expect(entries[2]).toEqual({
        level: "warn",
        msg: "warn message",
        meta: {},
      });
      expect(entries[3].msg).toBe("error message");
      expect((entries[3].meta as { err: { message: string } }).err.message).toBe("boom");
    });

    it("does not throw when baseLogger throws an internal error", () => {
      const throwingWinston = {
        info: jest.fn(() => {
          throw new Error("Winston transport crashed");
        }),
      } as unknown as winston.Logger;

      const logger = createLogger(throwingWinston);
      const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);

      expect(() => logger.info("test message")).not.toThrow();
      expect(stderrSpy).toHaveBeenCalled();
      stderrSpy.mockRestore();
    });

    it("creates child logger and inherits child context", () => {
      const logger = createLogger(mockWinston);
      const child = logger.child({ module: "invoices" });
      expect(child).toBeDefined();
      expect(mockWinston.child).toHaveBeenCalledWith({ module: "invoices" });
    });
  });

  describe("withErrorLogging", () => {
    it("returns function result when successful", async () => {
      const mockLog = {
        error: jest.fn(),
      } as unknown as import("../../src/observability/logger").AppLogger;

      const result = await withErrorLogging(
        async () => "success",
        "Failed operation",
        { op: "test" },
        mockLog
      );

      expect(result).toBe("success");
      expect(mockLog.error).not.toHaveBeenCalled();
    });

    it("logs error and re-throws when operation fails", async () => {
      const mockLog = {
        error: jest.fn(),
      } as unknown as import("../../src/observability/logger").AppLogger;

      const failingFn = async () => {
        throw new Error("Database timeout");
      };

      await expect(
        withErrorLogging(failingFn, "Database query failed", { query: "SELECT" }, mockLog)
      ).rejects.toThrow("Database timeout");

      expect(mockLog.error).toHaveBeenCalledWith("Database query failed", {
        query: "SELECT",
        error: expect.any(Error),
      });
    });
  });

  describe("correlationIdFormat", () => {
    it("stamps correlationId when running inside request context", () => {
      const format = correlationIdFormat();
      const testId = "test-corr-id-12345";

      runWithRequestContext({ correlationId: testId }, () => {
        const info = format.transform({ level: "info", message: "hello" });
        expect(info).toMatchObject({
          correlationId: testId,
        });
      });
    });
  });
});
