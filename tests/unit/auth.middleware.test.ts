import jwt from "jsonwebtoken";

import {
  MAX_BEARER_TOKEN_LENGTH,
  authenticateJWT,
  createAuthMiddleware,
  extractBearerToken,
} from "@/middleware/auth.middleware";
import type { AuthService } from "@/services/auth.service";
import type { AuthenticatedRequest } from "@/types/auth";
import { AppError, HttpError } from "@/utils/http-error";

const SECRET = "test-secret";
const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

function silentLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };
}

function createRequest(authorization?: unknown) {
  return {
    method: "GET",
    path: "/resource",
    headers: authorization === undefined ? {} : { authorization },
  } as unknown as AuthenticatedRequest;
}

function forwardedError(next: jest.Mock) {
  expect(next).toHaveBeenCalledTimes(1);
  return next.mock.calls[0][0] as HttpError | AppError | undefined;
}

function authService(getCurrentUser: jest.Mock): AuthService {
  return { getCurrentUser } as unknown as AuthService;
}

describe("extractBearerToken", () => {
  it.each([
    ["Bearer abc.def.ghi", "abc.def.ghi"],
    ["bearer abc.def.ghi", "abc.def.ghi"],
    ["BEARER   abc.def.ghi  ", "abc.def.ghi"],
    ["  Bearer abc", "abc"],
  ])("accepts %j", (header, token) => {
    expect(extractBearerToken(header)).toEqual({ ok: true, token });
  });

  it.each([undefined, "", "Bearer", "Bearer    ", "Basic abc", "Bearerabc", ["Bearer abc"], 42])(
    "treats %j as a missing token",
    (header) => {
      expect(extractBearerToken(header)).toEqual({ ok: false, reason: "missing_token" });
    }
  );

  it("rejects oversized tokens without returning them", () => {
    const result = extractBearerToken(`Bearer ${"a".repeat(MAX_BEARER_TOKEN_LENGTH + 1)}`);
    expect(result).toEqual({ ok: false, reason: "unparseable_token" });
  });
});

describe("authenticateJWT", () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  });

  it("attaches the user for a valid token", () => {
    const token = jwt.sign({ stellarAddress: WALLET, userId: "user-1" }, SECRET, {
      subject: WALLET,
    });
    const req = createRequest(`Bearer ${token}`);
    const next = jest.fn();

    authenticateJWT(req, {} as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toMatchObject({ id: "user-1", stellarAddress: WALLET });
  });

  it("accepts a lower-case bearer scheme", () => {
    const token = jwt.sign({ stellarAddress: WALLET }, SECRET, { subject: WALLET });
    const req = createRequest(`bearer ${token}`);
    const next = jest.fn();

    authenticateJWT(req, {} as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user?.id).toBe(WALLET);
  });

  it("falls back to the subject when stellarAddress is absent", () => {
    const token = jwt.sign({}, SECRET, { subject: WALLET });
    const req = createRequest(`Bearer ${token}`);
    const next = jest.fn();

    authenticateJWT(req, {} as never, next);

    expect(req.user?.stellarAddress).toBe(WALLET);
  });

  it("returns 401 missing_token without a bearer header", () => {
    const next = jest.fn();
    authenticateJWT(createRequest(), {} as never, next);

    const error = forwardedError(next);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      statusCode: 401,
      message: "Authorization token is required.",
      details: { authFailure: expect.objectContaining({ reason: "missing_token" }) },
    });
  });

  it("returns 401 unparseable_token for something that is not a JWT", () => {
    const next = jest.fn();
    authenticateJWT(createRequest("Bearer not a jwt"), {} as never, next);

    expect(forwardedError(next)).toMatchObject({
      statusCode: 401,
      details: { authFailure: expect.objectContaining({ reason: "unparseable_token" }) },
    });
  });

  it("returns 401 expired_token for an expired token", () => {
    const token = jwt.sign({}, SECRET, { subject: WALLET, expiresIn: -10 });
    const next = jest.fn();

    authenticateJWT(createRequest(`Bearer ${token}`), {} as never, next);

    expect(forwardedError(next)).toMatchObject({
      statusCode: 401,
      details: { authFailure: expect.objectContaining({ reason: "expired_token" }) },
    });
  });

  it("returns 401 invalid_signature for a token signed with another secret", () => {
    const token = jwt.sign({}, "other-secret", { subject: WALLET });
    const next = jest.fn();

    authenticateJWT(createRequest(`Bearer ${token}`), {} as never, next);

    expect(forwardedError(next)).toMatchObject({
      statusCode: 401,
      details: { authFailure: expect.objectContaining({ reason: "invalid_signature" }) },
    });
  });

  it("rejects tokens signed with an algorithm other than HS256", () => {
    const token = jwt.sign({}, SECRET, { subject: WALLET, algorithm: "HS512" });
    const next = jest.fn();

    authenticateJWT(createRequest(`Bearer ${token}`), {} as never, next);

    expect(forwardedError(next)).toMatchObject({ statusCode: 401 });
  });

  it("rejects unsigned tokens", () => {
    const token = jwt.sign({}, "", { subject: WALLET, algorithm: "none" });
    const next = jest.fn();

    authenticateJWT(createRequest(`Bearer ${token}`), {} as never, next);

    expect(forwardedError(next)).toMatchObject({ statusCode: 401 });
  });

  it.each([
    ["no subject", {}],
    ["a blank subject", { sub: "   " }],
    ["a numeric subject", { sub: 42 }],
  ])("returns 401 for a verified token with %s", (_label, claims) => {
    const token = jwt.sign(claims, SECRET);
    const req = createRequest(`Bearer ${token}`);
    const next = jest.fn();

    authenticateJWT(req, {} as never, next);

    expect(forwardedError(next)).toMatchObject({
      statusCode: 401,
      message: "Invalid token payload.",
    });
    expect(req.user).toBeUndefined();
  });

  it("reports a missing JWT_SECRET as a server error, not a bad token", () => {
    delete process.env.JWT_SECRET;
    const token = jwt.sign({}, SECRET, { subject: WALLET });
    const next = jest.fn();

    authenticateJWT(createRequest(`Bearer ${token}`), {} as never, next);

    const error = forwardedError(next);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 500, code: "AUTH_MISCONFIGURED" });
  });
});

describe("createAuthMiddleware", () => {
  const user = { id: "user-1", stellarAddress: WALLET };

  it("attaches the user returned by the auth service", async () => {
    const getCurrentUser = jest.fn().mockResolvedValue(user);
    const req = createRequest("bearer  mock-token ");
    const next = jest.fn();

    await createAuthMiddleware(authService(getCurrentUser), { logger: silentLogger() })(
      req,
      {} as never,
      next
    );

    expect(getCurrentUser).toHaveBeenCalledWith("mock-token");
    expect(req.user).toBe(user);
    expect(next).toHaveBeenCalledWith();
  });

  it("does not call the service without a token", async () => {
    const getCurrentUser = jest.fn();
    const next = jest.fn();

    await createAuthMiddleware(authService(getCurrentUser))(createRequest(), {} as never, next);

    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(forwardedError(next)).toMatchObject({ statusCode: 401 });
  });

  it("does not call the service for an oversized token", async () => {
    const getCurrentUser = jest.fn();
    const next = jest.fn();

    await createAuthMiddleware(authService(getCurrentUser))(
      createRequest(`Bearer ${"a".repeat(MAX_BEARER_TOKEN_LENGTH + 1)}`),
      {} as never,
      next
    );

    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(forwardedError(next)).toMatchObject({
      statusCode: 401,
      details: { authFailure: expect.objectContaining({ reason: "unparseable_token" }) },
    });
  });

  it("passes HttpError and AppError from the service through unchanged", async () => {
    for (const failure of [
      new HttpError(500, "Failed to fetch current user."),
      new AppError(403, "Suspended", "ACCOUNT_SUSPENDED"),
    ]) {
      const next = jest.fn();
      await createAuthMiddleware(authService(jest.fn().mockRejectedValue(failure)))(
        createRequest("Bearer mock-token"),
        {} as never,
        next
      );
      expect(forwardedError(next)).toBe(failure);
    }
  });

  it("maps a JWT error from the service to a classified 401", async () => {
    const next = jest.fn();
    await createAuthMiddleware(
      authService(jest.fn().mockRejectedValue(new jwt.TokenExpiredError("jwt expired", new Date())))
    )(createRequest("Bearer mock-token"), {} as never, next);

    expect(forwardedError(next)).toMatchObject({
      statusCode: 401,
      details: { authFailure: expect.objectContaining({ reason: "expired_token" }) },
    });
  });

  it("keeps rejecting unexpected errors with 401 and logs them", async () => {
    const logger = silentLogger();
    const next = jest.fn();

    await createAuthMiddleware(authService(jest.fn().mockRejectedValue(new Error("boom"))), {
      logger,
    })(createRequest("Bearer mock-token"), {} as never, next);

    expect(forwardedError(next)).toMatchObject({ statusCode: 401 });
    expect(logger.warn).toHaveBeenCalledWith(
      "Unexpected error during authentication; rejecting token",
      expect.objectContaining({ error: "boom" })
    );
  });

  it("returns 503 AUTH_UNAVAILABLE when the lookup hangs", async () => {
    const logger = silentLogger();
    const next = jest.fn();

    await createAuthMiddleware(authService(jest.fn(() => new Promise(() => undefined))), {
      logger,
      timeoutMs: 20,
    })(createRequest("Bearer mock-token"), {} as never, next);

    const error = forwardedError(next);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 503, code: "AUTH_UNAVAILABLE" });
    expect(logger.error).toHaveBeenCalledWith(
      "Authentication lookup timed out",
      expect.objectContaining({ path: "/resource" })
    );
  });

  it("handles a synchronous throw from the service", async () => {
    const next = jest.fn();
    const getCurrentUser = jest.fn(() => {
      throw new HttpError(401, "Invalid token payload.");
    });

    await createAuthMiddleware(authService(getCurrentUser), { logger: silentLogger() })(
      createRequest("Bearer mock-token"),
      {} as never,
      next
    );

    expect(forwardedError(next)).toMatchObject({ statusCode: 401 });
  });

  it.each([
    ["a missing auth service", undefined, {}, "requires an authService"],
    ["a non-positive timeout", authService(jest.fn()), { timeoutMs: 0 }, "positive integer"],
  ])("rejects %s at construction", (_label, service, options, message) => {
    expect(() => createAuthMiddleware(service as AuthService, options)).toThrow(message);
  });
});
