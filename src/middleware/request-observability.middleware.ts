import type { NextFunction, Request, Response } from "express";
import type { AppLogger } from "../observability/logger";
import type { MetricsRegistry } from "../observability/metrics";
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  resolveCorrelationId,
  runWithRequestContext,
} from "../observability/request-context";

interface RequestObservabilityDependencies {
  logger: AppLogger;
  metricsEnabled: boolean;
  metricsRegistry: MetricsRegistry;
}

function resolveRoutePrefix(req: Request): string {
  if (req.routeBasePath) {
    return req.routeBasePath;
  }

  if (req.baseUrl) {
    return req.baseUrl;
  }

  const originalPath = req.originalUrl.split("?")[0];

  if (!req.path || !originalPath.endsWith(req.path)) {
    return "";
  }

  return originalPath.slice(0, originalPath.length - req.path.length);
}

function resolveRouteLabel(req: Request): string {
  const routePath = req.route?.path;

  if (!routePath) {
    return "unmatched";
  }

  const normalizedRoutePath = Array.isArray(routePath) ? routePath[0] : routePath;
  const route = `${resolveRoutePrefix(req)}${normalizedRoutePath}`;

  return route || "/";
}

export function createRequestObservabilityMiddleware(
  dependencies: RequestObservabilityDependencies
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = resolveCorrelationId(
      req.headers[CORRELATION_ID_HEADER],
      req.headers[REQUEST_ID_HEADER]
    );
    const startedAt = process.hrtime.bigint();

    // The correlation ID doubles as the request ID so existing consumers of
    // X-Request-Id / req.requestId keep working unchanged.
    req.requestId = requestId;
    req.correlationId = requestId;
    res.setHeader("X-Correlation-Id", requestId);
    res.setHeader("X-Request-Id", requestId);

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const route = resolveRouteLabel(req);
      const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
      const metadata = {
        traceId: requestId,
        correlationId: requestId,
        requestId,
        method: req.method,
        // Query strings are left out on purpose: they can carry tokens.
        path: req.originalUrl.split("?")[0],
        route,
        statusCode: res.statusCode,
        statusClass,
        durationMs: Number(durationMs.toFixed(3)),
      };

      dependencies.logger.info("HTTP request completed.", metadata);

      if (dependencies.metricsEnabled) {
        dependencies.metricsRegistry.recordHttpRequest({
          method: req.method,
          route,
          statusClass,
          durationMs,
        });
      }
    });

    runWithRequestContext({ correlationId: requestId }, next);
  };
}
