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

class WinstonAppLogger implements AppLogger {
  constructor(private readonly baseLogger: winston.Logger) {}

  debug(message: string, metadata: LogMetadata = {}): void {
    this.baseLogger.debug(message, metadata);
  }

  info(message: string, metadata: LogMetadata = {}): void {
    this.baseLogger.info(message, metadata);
  }

  warn(message: string, metadata: LogMetadata = {}): void {
    this.baseLogger.warn(message, metadata);
  }

  error(message: string, metadata: LogMetadata = {}): void {
    this.baseLogger.error(message, metadata);
  }

  child(metadata: LogMetadata): AppLogger {
    return new WinstonAppLogger(this.baseLogger.child(metadata));
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
