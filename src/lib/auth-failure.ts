import jwt from "jsonwebtoken";

export type AuthFailureReason =
  | "missing_token"
  | "expired_token"
  | "invalid_signature"
  | "invalid_token"
  | "unparseable_token";

export interface AuthFailureDetails {
  reason: AuthFailureReason;
  truncatedAddress: string | null;
  failedAt: string;
}

export function truncateWalletAddress(address: string | null | undefined): string | null {
  if (typeof address !== "string") {
    return null;
  }

  const trimmed = address.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length <= 8) {
    return trimmed;
  }

  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function extractWalletFromUnverifiedToken(token?: string): string | null {
  if (typeof token !== "string") {
    return null;
  }

  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  let decoded: string | jwt.JwtPayload | null;
  try {
    decoded = jwt.decode(trimmed);
  } catch {
    return null;
  }
  if (!decoded || typeof decoded === "string") {
    return null;
  }

  const sub = decoded.sub;
  if (typeof sub !== "string") {
    return null;
  }

  const trimmedSub = sub.trim();
  return trimmedSub.length > 0 ? trimmedSub : null;
}

export function buildAuthFailureDetails(
  token: string | undefined,
  reason: AuthFailureReason
): { authFailure: AuthFailureDetails } {
  return {
    authFailure: {
      reason,
      truncatedAddress: truncateWalletAddress(extractWalletFromUnverifiedToken(token)),
      failedAt: new Date().toISOString(),
    },
  };
}

export function classifyJwtError(error: unknown): AuthFailureReason {
  if (error instanceof jwt.TokenExpiredError) {
    return "expired_token";
  }

  if (error instanceof jwt.JsonWebTokenError) {
    return "invalid_signature";
  }

  return "invalid_token";
}
