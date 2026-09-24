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

/** Maximum metadata nesting depth before values are truncated (issue #406). */
const MAX_METADATA_DEPTH = 8;

/** Marker used for values removed by the metadata sanitizer. */
const MAX_DEPTH_PLACEHOLDER = "[MaxDepth]";
const CIRCULAR_PLACEHOLDER = "[Circular]";

/**
 * Maximum number of top-level metadata keys carried into a log entry
 * (issue #409): bound the per-entry serialization work so a runaway caller
 * cannot inflate every log line under heavy load. Dropped keys are reported
 * explicitly instead of disappearing silently.
 */
const MAX_METADATA_KEYS = 64;

/**
 * Make a single value safe for the JSON formatter winston applies to every
 * log line. Anything JSON cannot represent — circular structures, Error
 * instances, bigints, functions, symbols — is replaced with a stable,
 * readable stand-in instead of throwing at emission time.
 */
function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
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
    return value.map((item) => sanitizeValue(item, depth - 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = sanitizeValue(item, depth - 1, seen);
  }
  return out;
}

/**
 * Sanitize log metadata so winston's JSON formatter can always serialize it.
 *
 * Handles the edge cases that previously crashed emission (and therefore the
 * calling request handler): circular references, `Error` values handed in as
 * metadata (their `message`/`stack` are preserved as plain fields),
 * bigints, functions and symbols, and values nested too deeply.
 *
 * Redaction is intentionally NOT done here — it stays downstream in
 * {@link redactionFormat} so the two passes compose.
 */
export function sanitizeLogMetadata(metadata: LogMetadata | undefined): LogMetadata {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    // A malformed call argument must never take the process down.
    return {};
  }

  try {
    const sanitized = sanitizeValue(metadata, MAX_METADATA_DEPTH, new WeakSet()) as LogMetadata;
    const keys = Object.keys(sanitized);
    if (keys.length <= MAX_METADATA_KEYS) return sanitized;

    // Issue #409: keep the entry bounded. Drop the overflow keys but say so.
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

  debug(message: string, metadata?: LogMetadata): void {
    this.safeEmit("debug", message, metadata);
  }

  info(message: string, metadata: LogMetadata = {}): void {
    this.safeEmit("info", message, metadata);
  }

  warn(message: string, metadata: LogMetadata = {}): void {
    this.safeEmit("warn", message, metadata);
  }

  error(message: string, metadata: LogMetadata = {}): void {
    this.safeEmit("error", message, metadata);
  }

  child(metadata: LogMetadata): AppLogger {
    const binding = sanitizeLogMetadata(metadata);
    const cacheKey = JSON.stringify(binding);
    const cached = this.children.get(cacheKey);
    if (cached) return cached;

    const child = new WinstonAppLogger(this.baseLogger.child(binding));
    this.children.set(cacheKey, child);
    return child;
  }

  /**
   * Emit one log line without ever throwing out to the caller: a failing
   * transport or formatter must not cascade into a 500. If even the fallback
   * emission fails, the error is swallowed — logging can never be the reason
   * a request fails.
   *
   * Issue #409: suppressed levels short-circuit BEFORE any sanitization or
   * metadata traversal work happens, so a disabled level costs nothing under
   * heavy load.
   */
  private safeEmit(level: "debug" | "info" | "warn" | "error", message: string, metadata?: LogMetadata): void {
    try {
      if (!this.baseLogger.isLevelEnabled(level)) return;

      const text = typeof message === "string" ? message : String(message);
      this.baseLogger[level](text, sanitizeLogMetadata(metadata));
    } catch (emissionError) {
      try {
        const reason =
          emissionError instanceof Error ? emissionError.message : String(emissionError);
        this.baseLogger.error("Log emission failed; original entry dropped.", {
          failedLevel: level,
          reason,
        });
      } catch {
        // Last-resort guard: nothing more can be done safely here.
      }
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
  return winston.createLogger({
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
}

export function createLogger(baseLogger: winston.Logger = createBaseLogger()): AppLogger {
  return new WinstonAppLogger(baseLogger);
}

export const logger = createLogger();
