import jwt from "jsonwebtoken";

/**
 * Safely extracts the wallet address (sub claim) from a JWT token.
 *
 * Returns the `sub` claim string on a valid, unexpired token.
 * Returns null for: missing token, expired token, invalid signature,
 * missing `sub` claim. Never throws.
 */
export function extractWalletFromToken(token: string | undefined, secret: string): string | null {
  if (!token) {
    return null;
  }

  try {
    const payload = jwt.verify(token, secret) as jwt.JwtPayload;

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return null;
    }

    return payload.sub;
  } catch {
    return null;
  }
}
