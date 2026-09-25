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
  let truncatedAddress: string | null = null;
  try {
    truncatedAddress = truncateWalletAddress(extractWalletFromUnverifiedToken(token));
  } catch {
    truncatedAddress = null;
  }

  let failedAt: string;
  try {
    failedAt = new Date().toISOString();
  } catch {
    failedAt = "1970-01-01T00:00:00.000Z";
  }

  return {
    authFailure: {
      reason,
      truncatedAddress,
      failedAt,
    },
  };
}

export function classifyJwtError(error: unknown): AuthFailureReason {
  if (error instanceof jwt.TokenExpiredError) {
    return "expired_token";
  }

  if (error instanceof jwt.JsonWebTokenError) {
    const message = error.message.toLowerCase();
    if (message.includes("invalid signature")) {
      return "invalid_signature";
    }
    // jsonwebtoken throws this exact JsonWebTokenError message when the
    // token isn't even well-formed JWT (not base64/dot-delimited, or the
    // header/payload segments aren't valid JSON) — distinct from a
    // structurally valid token with a bad signature or claims.
    if (message.includes("malformed")) {
      return "unparseable_token";
    }
    return "invalid_token";
  }

  return "invalid_token";
}
