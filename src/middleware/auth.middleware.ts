import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import type { AuthService } from "../services/auth.service";
import type { AuthenticatedRequest } from "../types/auth";

import { AppError, HttpError } from "../utils/http-error";
import { UserType, KYCStatus } from "../types/enums";
import { buildAuthFailureDetails, classifyJwtError } from "../lib/auth-failure";

interface AuthTokenPayload {
  sub: string;
  stellarAddress: string;
  userId?: string;
}

export function createAuthMiddleware(authService: AuthService) {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      next(
        new HttpError(
          401,
          "Authorization token is required.",
          buildAuthFailureDetails(undefined, "missing_token")
        )
      );
      return;
    }

    const token = authHeader.slice(7);

    try {
      req.user = await authService.getCurrentUser(token);
      next();
    } catch (error) {
      if (error instanceof HttpError) {
        next(error);
        return;
      }

      next(
        new HttpError(
          401,
          "Invalid or expired token.",
          buildAuthFailureDetails(token, classifyJwtError(error))
        )
      );
    }
  };
}

export function authenticateJWT(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    next(
      new HttpError(
        401,
        "Authorization token is required.",
        buildAuthFailureDetails(undefined, "missing_token")
      )
    );
    return;
  }

  const token = authHeader.slice(7);

  // A missing JWT_SECRET is a server misconfiguration, not a client auth
  // failure — checked outside the try/catch below so it can never be
  // reported as a 401 "invalid token" (#387). It also isn't a per-request
  // dependency on `token`, so there's no need to re-check it on every call.
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    next(new AppError(500, "Server authentication is misconfigured.", "JWT_SECRET_MISSING"));
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as AuthTokenPayload;

    (req as AuthenticatedRequest).user = {
      id: payload.userId || payload.sub,
      stellarAddress: payload.stellarAddress,
      email: null,
      userType: null as unknown as UserType,
      kycStatus: null as unknown as KYCStatus,
      isKycVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    next();
  } catch (error) {
    next(
      new HttpError(
        401,
        "Invalid or expired token.",
        buildAuthFailureDetails(token, classifyJwtError(error))
      )
    );
  }
}

export function requireKYC(skipVerification = false) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (skipVerification) {
      next();
      return;
    }

    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      next(new HttpError(401, "Authentication required"));
      return;
    }

    if (authReq.user.kycStatus !== KYCStatus.APPROVED) {
      next(new HttpError(403, "KYC approval required for this action"));
      return;
    }

    next();
  };
}

export function checkKycVerified(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).user;
  if (!user) {
    next(new HttpError(401, "Authentication required"));
    return;
  }
  if (user.kycStatus !== KYCStatus.APPROVED) {
    next(new AppError(403, "KYC approval required for this action", "KYC_NOT_APPROVED"));
    return;
  }
  next();
}
