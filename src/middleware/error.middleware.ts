import type { NextFunction, Request, Response } from "express";
import type { AppLogger } from "../observability/logger";

import { AppError, HttpError, PublicAppError } from "../utils/http-error";
import type { AuthFailureDetails } from "../lib/auth-failure";

export function notFoundMiddleware(_req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(404, "Route not found."));
}

export function createErrorMiddleware(logger: AppLogger) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (error instanceof AppError || error instanceof HttpError) {
      res.status(error.statusCode).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error instanceof PublicAppError && error.details !== undefined
            ? { details: error.details }
            : {}),
        },
      });

      const authFailure = (error.details as { authFailure?: AuthFailureDetails } | undefined)
        ?.authFailure;

      if (error.statusCode === 401 && authFailure) {
        logger.warn("API authentication failure.", {
          method: req.method,
          path: req.path,
          reason: authFailure.reason,
          truncated_address: authFailure.truncatedAddress,
          failed_at: authFailure.failedAt,
          statusCode: error.statusCode,
        });
        return;
      }

      logger.warn("HTTP request failed.", {
        method: req.method,
        path: req.path,
        statusCode: error.statusCode,
        error: error.message,
      });

      return;
    }

    logger.error("Unhandled request error.", {
      method: req.method,
      path: req.path,
      statusCode: 500,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
      },
    });
  };
}
