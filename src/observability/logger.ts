import winston from "winston";
import { redactionFormat } from "./redaction-formatter";
import { getCorrelationId } from "./request-context";

export type LogMetadata = Record<string, unknown>;

export interface AppLogger {
  debug(message: string, metadata?: LogMetadata): void;
  info(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  error(message: string, metadata?: LogMetadata): void;
  child(metadata: LogMetadata): AppLogger;
}

/**
 * Recursively normalizes log metadata:
 * - Safely handles circular references (replaces them with "[Circular]")
 * - Safely serializes BigInts as strings to prevent JSON.stringify exceptions
 * - Extracts structured details from Error instances (name, message, stack, custom props)
 * - Coerces primitives or non-plain-objects into structured metadata objects
 */
function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (depth > 8) return "[DepthLimit]";

  if (value instanceof Error) {
    const errorObj: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const [k, v] of Object.entries(value)) {
      if (!(k in errorObj)) {
        errorObj[k] = sanitizeValue(v, seen, depth + 1);
      }
    }
    return errorObj;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = sanitizeValue(v, seen, depth + 1);
  }
  return result;
}

export function normalizeLogMetadata(
  metadata?: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): LogMetadata {
  if (metadata === undefined || metadata === null) {
    return {};
  }

  if (typeof metadata !== "object") {
    if (typeof metadata === "bigint") {
      return { value: metadata.toString() };
    }
    return { value: metadata };
  }

  if (Array.isArray(metadata)) {
    return {
      items: metadata.map((item) => sanitizeValue(item, seen, depth + 1)),
    };
  }

  const sanitized = sanitizeValue(metadata, seen, depth);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return sanitized as LogMetadata;
  }
  return { value: sanitized };
}

const MAX_METADATA_DEPTH = 8;
const MAX_DEPTH_PLACEHOLDER = "[MaxDepth]";
const CIRCULAR_PLACEHOLDER = "[Circular]";
const MAX_METADATA_KEYS = 64;

function sanitizeMetadataValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) return null;

  const type = typeof value;
  if (type === "string") return value;
  if (type === "number" || type === "boolean") return value;
  if (type === "bigint") return `${value}n`;
  if (type === "function") return "[Function]";
  if (type === "symbol") return String(value);
  if (type === "undefined") return undefined;

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  if (depth <= 0) return MAX_DEPTH_PLACEHOLDER;

  const asObject = value as object;
  if (seen.has(asObject)) return CIRCULAR_PLACEHOLDER;
  seen.add(asObject);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadataValue(item, depth - 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = sanitizeMetadataValue(item, depth - 1, seen);
  }
  return out;
}

export function sanitizeLogMetadata(metadata: LogMetadata | undefined): LogMetadata {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  try {
    const sanitized = sanitizeMetadataValue(metadata, MAX_METADATA_DEPTH, new WeakSet()) as LogMetadata;
    const keys = Object.keys(sanitized);
    if (keys.length <= MAX_METADATA_KEYS) return sanitized;

    const bounded: Record<string, unknown> = {};
    for (const key of Object.keys(sanitized).slice(0, MAX_METADATA_KEYS)) {
      bounded[key] = sanitized[key];
    }
    bounded.droppedMetadataKeys = Object.keys(sanitized).length - MAX_METADATA_KEYS;
    return bounded;
  } catch {
    return { metadata: "[Unserializable log metadata]" };
  }
}

class WinstonAppLogger implements AppLogger {
  /**
   * Issue #409 — memoized child loggers. winston's `child()` builds a whole
   * new Logger instance, which is far too expensive to repeat per call; cache
   * the wrapper per serialized binding so hot paths reuse one instance.
   */
  private readonly children = new Map<string, AppLogger>();

  constructor(private readonly baseLogger: winston.Logger) {}

  private safeLog(
    level: "debug" | "info" | "warn" | "error",
    message: unknown,
    metadata?: LogMetadata
  ): void {
    try {
      if (typeof (this.baseLogger as { isLevelEnabled?: (lvl: string) => boolean }).isLevelEnabled === "function") {
        if (!(this.baseLogger as { isLevelEnabled?: (lvl: string) => boolean }).isLevelEnabled!(level)) {
          return;
        }
      }
      const msg = typeof message === "string" ? message : String(message ?? "");
      const meta = normalizeLogMetadata(metadata);
      this.baseLogger[level](msg, meta);
    } catch (err) {
      // Emergency failsafe: logging operations must never throw and crash downstream caller flows
      try {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (typeof this.baseLogger.error === "function") {
          this.baseLogger.error("Log emission failed; original entry dropped.", {
            failedLevel: level,
            reason: errorMsg,
          });
        }
        process.stderr.write(
          `[Logger Fallback: ${level.toUpperCase()}] ${String(message)} | Logging Error: ${errorMsg}\n`
        );
      } catch {
        // Ignore if stderr is unavailable
      }
    }
  }

  debug(message: string, metadata: LogMetadata = {}): void {
    this.safeLog("debug", message, metadata);
  }

  info(message: string, metadata: LogMetadata = {}): void {
    this.safeLog("info", message, metadata);
  }

  warn(message: string, metadata: LogMetadata = {}): void {
    this.safeLog("warn", message, metadata);
  }

  error(message: string, metadata: LogMetadata = {}): void {
    this.safeLog("error", message, metadata);
  }

  child(metadata: LogMetadata = {}): AppLogger {
    try {
      const meta = normalizeLogMetadata(metadata);
      const cacheKey = JSON.stringify(meta);
      const cached = this.children.get(cacheKey);
      if (cached) return cached;

      const child = new WinstonAppLogger(this.baseLogger.child(meta));
      this.children.set(cacheKey, child);
      return child;
    } catch {
      return this;
    }
  }
}

/**
 * Stamps every log line written while handling a request with that request's
 * correlation ID, so service-level logs can be joined to the HTTP access log
 * without each call site passing the ID along.
 */
export const correlationIdFormat = winston.format((info) => {
  const correlationId = getCorrelationId();
  if (correlationId && info.correlationId === undefined) {
    info.correlationId = correlationId;
  }
  return info;
});

function createBaseLogger(): winston.Logger {
  const base = winston.createLogger({
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
    defaultMeta: {
      service: "stellarsettle-api",
    },
    format: winston.format.combine(
      correlationIdFormat(),
      redactionFormat(),
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    transports: [new winston.transports.Console()],
  });

  // Handle unhandled transport errors to prevent process aborts
  base.on("error", (error) => {
    try {
      process.stderr.write(`[Winston Error] ${error?.message ?? error}\n`);
    } catch {
      // Ignore write errors during shutdown
    }
  });

  return base;
}

export function createLogger(baseLogger: winston.Logger = createBaseLogger()): AppLogger {
  return new WinstonAppLogger(baseLogger);
}

export const logger = createLogger();

/**
 * Helper to execute an async operation with standardized error logging.
 * Re-throws the error so upstream handlers or callers can handle it.
 */
export async function withErrorLogging<T>(
  fn: () => Promise<T>,
  errorMessage: string,
  metadata?: LogMetadata,
  appLogger: AppLogger = logger
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    appLogger.error(errorMessage, { ...metadata, error });
    throw error;
  }
}
