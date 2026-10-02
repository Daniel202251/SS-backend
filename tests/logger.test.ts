/**
 * Unit tests for the hardened logger (issue #406).
 *
 * Uses a stub winston-style base logger to observe exactly what the
 * sanitized emission path passes through.
 */

import {
  AppLogger,
  createLogger,
  sanitizeLogMetadata,
} from "../src/observability/logger";

function makeBaseLogger(): any {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    isLevelEnabled: jest.fn(() => true),
    child: jest.fn((metadata: unknown) => makeBaseLogger()),
  };
}

describe("logger hardening (issue #406)", () => {
  describe("sanitizeLogMetadata", () => {
    it("passes plain values through untouched", () => {
      const metadata = { userId: "u1", count: 3, ok: true, note: null };
      expect(sanitizeLogMetadata(metadata)).toEqual(metadata);
    });

    it("breaks circular references instead of throwing", () => {
      const circular: Record<string, unknown> = { name: "node" };
      circular.circular = circular;

      expect(() => sanitizeLogMetadata({ nested: circular })).not.toThrow();
      expect(sanitizeLogMetadata({ circular })).toEqual({
        circular: { name: "node", circular: "[Circular]" },
      });
    });

    it("normalizes Error values to plain serializable fields", () => {
      const error = new Error("boom");
      const [sanitized] = Object.values(
        sanitizeLogMetadata({ error }) as { error: { name: string; message: string } }
      );

      expect((sanitized as { name: string; message: string }).name).toBe("Error");
      expect((sanitized as { message: string }).message).toBe("boom");
    });

    it("replaces functions, symbols and bigints with safe stand-ins", () => {
      const metadata = { fn: () => 1, sym: Symbol("x"), big: 10n };
      const sanitized = sanitizeLogMetadata(metadata);

      expect(sanitized.fn).toBe("[Function]");
      expect(String(sanitized.sym)).toBe("Symbol(x)");
      expect(sanitized.big).toBe("10n");
    });

    it("truncates metadata nested too deeply", () => {
      const deep: Record<string, unknown> = { level: 0 };
      let cursor = deep;
      for (let i = 1; i <= 20; i++) {
        const next = { level: i };
        cursor.child = next;
        cursor = next;
      }

      const sanitized = sanitizeLogMetadata(deep) as { child: Record<string, unknown> };
      expect(JSON.stringify(sanitized)).toContain("[MaxDepth]");
    });

    it("returns a fallback object for malformed call arguments", () => {
      expect(sanitizeLogMetadata(null as unknown as Record<string, unknown>)).toEqual({});
      expect(sanitizeLogMetadata("nope" as unknown as Record<string, unknown>)).toEqual({});
    });
  });

  describe("error-safe emission", () => {
    it("never throws when the underlying logger explodes", () => {
      const exploding = {
        debug: () => {
          throw new Error("sink is on fire");
        },
        info: () => {
          throw new Error("transport down");
        },
        warn: () => undefined,
        error: jest.fn(),
        isLevelEnabled: () => true,
        child: jest.fn(),
      };

      const logger: AppLogger = createLogger(exploding as never);

      expect(() => logger.info("hello", { key: "value" })).not.toThrow();
      // A single fallback error line is emitted instead.
      expect(exploding.error).toHaveBeenCalledWith(
        "Log emission failed; original entry dropped.",
        expect.anything()
      );
    });

    it("stringifies non-string messages instead of crashing", () => {
      const base = makeBaseLogger();
      const logger: AppLogger = createLogger(base as never);

      expect(() => logger.error(42 as unknown as string)).not.toThrow();
      expect(base.error).toHaveBeenCalledWith("42", {});
    });
  });
});

describe("logger performance hardening (issue #409)", () => {
  function makeLevelAwareBase(level: string): any {
    return {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      isLevelEnabled: jest.fn((lvl: string) => {
        const order = ["error", "warn", "info", "debug"];
        return order.indexOf(lvl) <= order.indexOf(level);
      }),
      child: jest.fn(() => makeLevelAwareBase(level)),
    };
  }

  it("skips sanitization/emission work entirely for suppressed levels", () => {
    // "warn" base: info/debug are suppressed.
    const base = makeLevelAwareBase("warn");
    const logger: AppLogger = createLogger(base as never);

    logger.debug("cheap check", { deep: { nested: "payload" } });
    logger.info("not emitted", { key: "value" });

    expect(base.debug).not.toHaveBeenCalled();
    expect(base.info).not.toHaveBeenCalled();
  });

  it("still emits enabled levels with sanitized metadata", () => {
    const base = makeLevelAwareBase("warn");
    const logger: AppLogger = createLogger(base as never);

    logger.warn("visible", { key: "value" });
    expect(base.warn).toHaveBeenCalledWith("visible", { key: "value" });
  });

  it("caches child loggers per binding instead of rebuilding winston children", () => {
    const base = makeLevelAwareBase("info");
    const logger: AppLogger = createLogger(base as never);

    const first = logger.child({ requestId: "r1" });
    const second = logger.child({ requestId: "r1" });
    const different = logger.child({ requestId: "r2" });

    expect(first).toBe(first); // stable identity
    expect(first).toBe(second);
    expect(different).not.toBe(first);
    expect(base.child).toHaveBeenCalledTimes(2); // once per distinct binding
  });

  it("bounds oversized metadata instead of serializing unbounded entries", () => {
    const metadata: Record<string, number> = {};
    for (let i = 0; i < 100; i++) metadata[`key${i}`] = i;

    const sanitized = sanitizeLogMetadata(metadata) as Record<string, unknown> & {
      droppedMetadataKeys?: number;
    };
    expect(Object.keys(sanitized).length).toBeLessThanOrEqual(65); // 64 kept + drop marker
    expect(sanitized.droppedMetadataKeys).toBe(36);
  });
});
