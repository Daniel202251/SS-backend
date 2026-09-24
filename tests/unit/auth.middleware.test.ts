import jwt from "jsonwebtoken";
import {
  authenticateJWT,
  createAuthMiddleware,
  requireKYC,
  checkKycVerified,
} from "../../src/middleware/auth.middleware";
import { AppError, HttpError } from "../../src/utils/http-error";
import { KYCStatus } from "../../src/types/enums";
import type { AuthenticatedRequest } from "../../src/types/auth";
import type { AuthService } from "../../src/services/auth.service";

function makeReq(overrides: Record<string, unknown> = {}): AuthenticatedRequest {
  return {
    headers: {},
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

describe("authenticateJWT", () => {
  const originalSecret = process.env.JWT_SECRET;

  afterEach(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  it("rejects a request with no Authorization header as missing_token (401)", () => {
    process.env.JWT_SECRET = "test-secret";
    const req = makeReq();
    const next = jest.fn();

    authenticateJWT(req, {} as never, next);

    expect(next).toHaveBeenCalledWith(expect.any(HttpError));
    const err = next.mock.calls[0][0] as HttpError;
    expect(err.statusCode).toBe(401);
    expect((err.details as { authFailure: { reason: string } }).authFailure.reason).toBe(
      "missing_token"
    );
  });

  it("returns 500 (not 401) when JWT_SECRET is unset — server misconfiguration, not a client auth failure (#387)", () => {
    delete process.env.JWT_SECRET;
    const req = makeReq({ headers: { authorization: "Bearer sometoken" } });
    const next = jest.fn();

    authenticateJWT(req, {} as never, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const err = next.mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe("JWT_SECRET_MISSING");
  });

  it("accepts a valid token and attaches req.user", () => {
    process.env.JWT_SECRET = "test-secret";
    const token = jwt.sign(
      { sub: "user-1", stellarAddress: "GABC" },
      "test-secret"
    );
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const next = jest.fn();

    authenticateJWT(req, {} as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toMatchObject({ id: "user-1", stellarAddress: "GABC" });
  });

  it("rejects an expired token with a 401 and expired_token reason", () => {
    process.env.JWT_SECRET = "test-secret";
    const token = jwt.sign({ sub: "user-1", stellarAddress: "GABC" }, "test-secret", {
      expiresIn: -1,
    });
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const next = jest.fn();

    authenticateJWT(req, {} as never, next);

    const err = next.mock.calls[0][0] as HttpError;
    expect(err.statusCode).toBe(401);
    expect((err.details as { authFailure: { reason: string } }).authFailure.reason).toBe(
      "expired_token"
    );
  });

  it("rejects a structurally malformed token with unparseable_token", () => {
    process.env.JWT_SECRET = "test-secret";
    const req = makeReq({ headers: { authorization: "Bearer not-a-jwt-at-all" } });
    const next = jest.fn();

    authenticateJWT(req, {} as never, next);

    const err = next.mock.calls[0][0] as HttpError;
    expect(err.statusCode).toBe(401);
    expect((err.details as { authFailure: { reason: string } }).authFailure.reason).toBe(
      "unparseable_token"
    );
  });
});

describe("createAuthMiddleware", () => {
  it("attaches req.user on success", async () => {
    const authService = {
      getCurrentUser: jest.fn().mockResolvedValue({ id: "user-1" }),
    } as unknown as AuthService;
    const middleware = createAuthMiddleware(authService);
    const req = makeReq({ headers: { authorization: "Bearer sometoken" } });
    const next = jest.fn();

    await middleware(req, {} as never, next);

    expect(req.user).toEqual({ id: "user-1" });
    expect(next).toHaveBeenCalledWith();
  });

  it("passes through an HttpError thrown by the service unchanged", async () => {
    const thrown = new HttpError(403, "forbidden");
    const authService = {
      getCurrentUser: jest.fn().mockRejectedValue(thrown),
    } as unknown as AuthService;
    const middleware = createAuthMiddleware(authService);
    const req = makeReq({ headers: { authorization: "Bearer sometoken" } });
    const next = jest.fn();

    await middleware(req, {} as never, next);

    expect(next).toHaveBeenCalledWith(thrown);
  });

  it("wraps a non-HttpError service failure into a 401", async () => {
    const authService = {
      getCurrentUser: jest.fn().mockRejectedValue(new Error("db unreachable")),
    } as unknown as AuthService;
    const middleware = createAuthMiddleware(authService);
    const req = makeReq({ headers: { authorization: "Bearer sometoken" } });
    const next = jest.fn();

    await middleware(req, {} as never, next);

    const err = next.mock.calls[0][0] as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(401);
  });

  it("rejects a missing Authorization header without calling the service", async () => {
    const authService = { getCurrentUser: jest.fn() } as unknown as AuthService;
    const middleware = createAuthMiddleware(authService);
    const req = makeReq();
    const next = jest.fn();

    await middleware(req, {} as never, next);

    expect(authService.getCurrentUser).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.any(HttpError));
  });
});

describe("requireKYC", () => {
  it("allows through when skipVerification is true, even with no user", () => {
    const req = makeReq();
    const next = jest.fn();

    requireKYC(true)(req, {} as never, next);

    expect(next).toHaveBeenCalledWith();
  });

  it("rejects with 401 when there is no authenticated user", () => {
    const req = makeReq();
    const next = jest.fn();

    requireKYC(false)(req, {} as never, next);

    const err = next.mock.calls[0][0] as HttpError;
    expect(err.statusCode).toBe(401);
  });

  it("rejects with 403 when the user's KYC is not approved", () => {
    const req = makeReq({ user: { kycStatus: KYCStatus.PENDING } });
    const next = jest.fn();

    requireKYC(false)(req, {} as never, next);

    const err = next.mock.calls[0][0] as HttpError;
    expect(err.statusCode).toBe(403);
  });

  it("allows through when the user's KYC is approved", () => {
    const req = makeReq({ user: { kycStatus: KYCStatus.APPROVED } });
    const next = jest.fn();

    requireKYC(false)(req, {} as never, next);

    expect(next).toHaveBeenCalledWith();
  });
});

describe("checkKycVerified", () => {
  it("rejects with 401 when there is no authenticated user", () => {
    const req = makeReq();
    const next = jest.fn();

    checkKycVerified(req, {} as never, next);

    const err = next.mock.calls[0][0] as HttpError;
    expect(err.statusCode).toBe(401);
  });

  it("rejects with an AppError(403) when KYC is not approved", () => {
    const req = makeReq({ user: { kycStatus: KYCStatus.PENDING } });
    const next = jest.fn();

    checkKycVerified(req, {} as never, next);

    const err = next.mock.calls[0][0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("KYC_NOT_APPROVED");
  });

  it("allows through when KYC is approved", () => {
    const req = makeReq({ user: { kycStatus: KYCStatus.APPROVED } });
    const next = jest.fn();

    checkKycVerified(req, {} as never, next);

    expect(next).toHaveBeenCalledWith();
  });
});
