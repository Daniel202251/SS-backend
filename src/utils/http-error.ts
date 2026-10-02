// ---------------- TYPES ----------------

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface ApiResponseEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: ErrorPayload;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
  };
}

// ---------------- APP ERROR ----------------

export class AppError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, message: string, code: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * AppError whose `details` are safe to return to the client, e.g. the
 * allowed next statuses on a rejected invoice transition. Plain AppError
 * details stay server-side because some carry internal context.
 */
export class PublicAppError extends AppError {
  constructor(statusCode: number, message: string, code: string, details?: unknown) {
    super(statusCode, message, code, details);
    this.name = "PublicAppError";
  }
}

// ---------------- HTTP ERROR ----------------

export class HttpError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = `HTTP_${statusCode}`;
    this.details = details;
  }
}
