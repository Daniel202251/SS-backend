import winston from "winston";

const STELLAR_SECRET_KEY_PATTERN = /S[A-Z0-9]{55}/g;

const STELLAR_SECRET_KEY_REDACTED = "S*******************************************************";

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g;

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9_\-.~+/]+=*/g;

// Compared after normalising the key (lowercased, "-" and "_" removed), so
// "Authorization", "x-admin-key" and "wallet_secret_key" all match regardless
// of how the caller spelled them.
const SENSITIVE_KEY_NAMES = new Set(
  [
    "password",
    "secret",
    "secretKey",
    "privateKey",
    "platformSecretKey",
    "jwt",
    "token",
    "accessToken",
    "refreshToken",
    "idToken",
    "authorization",
    "proxyAuthorization",
    "auth",
    "cookie",
    "setCookie",
    "credential",
    "credentials",
    "apiKey",
    "adminKey",
    "xAdminKey",
    "xApiKey",
    "seed",
    "seedPhrase",
    "mnemonic",
    "passphrase",
    "walletKey",
    "walletSecret",
    "walletSecretKey",
    "walletPrivateKey",
    "signingKey",
    "signature",
    "xSignature",
  ].map(normalizeKey)
);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(normalizeKey(key));
}

function redactStringValue(value: string): string {
  let result = value;
  result = result.replace(STELLAR_SECRET_KEY_PATTERN, STELLAR_SECRET_KEY_REDACTED);
  result = result.replace(BEARER_PATTERN, "Bearer ***");
  result = result.replace(JWT_PATTERN, "eyJ***.eyJ***.***");
  return result;
}

function redactObjectValues(obj: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key)) {
      redacted[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      redacted[key] = redactStringValue(value);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      redacted[key] = redactObjectValues(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      redacted[key] = value.map((item) => {
        if (typeof item === "string") return redactStringValue(item);
        if (item !== null && typeof item === "object")
          return redactObjectValues(item as Record<string, unknown>);
        return item;
      });
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

export function redactionFormat(): winston.Logform.Format {
  return winston.format((info) => {
    if (info.message && typeof info.message === "string") {
      info.message = redactStringValue(info.message);
    }

    const {
      level: _level,
      message: _message,
      timestamp: _timestamp,
      stack: _stack,
      ...rest
    } = info as Record<string, unknown>;

    // Redact in place rather than returning a rebuilt object: winston keeps
    // the entry's level under Symbol.for("level"), and redactObjectValues
    // (built on Object.entries) drops symbol keys. Losing it made every
    // transport filter every entry out, so nothing was ever logged.
    for (const [key, value] of Object.entries(redactObjectValues(rest))) {
      (info as Record<string, unknown>)[key] = value;
    }

    return info;
  })();
}

export function redactString(input: string): string {
  return redactStringValue(input);
}
