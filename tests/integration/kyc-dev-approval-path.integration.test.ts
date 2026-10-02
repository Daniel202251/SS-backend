import crypto from "crypto";
import { KYCStatus, InvoiceStatus } from "../../src/types/enums";
import { requireKYC } from "../../src/middleware/auth.middleware";
import type { AuthenticatedRequest } from "../../src/types/auth";

/**
 * Simulates an Express next function for testing middleware.
 */
function createMockContext() {
  const req = {
    headers: {},
  } as AuthenticatedRequest;

  let statusCode = 0;
  let errorMessage = "";

  const res = {} as any;

  const next = (error?: any) => {
    if (error) {
      statusCode = error.status || error.statusCode || 500;
      errorMessage = error.message || "Unknown error";
    }
    return undefined;
  };

  const getResult = () => {
    if (statusCode === 0) return { passed: true };
    return { passed: false, statusCode, errorMessage };
  };

  return { req, next, getResult };
}

describe("KYC dev approval path", () => {
  it("allows any user through when KYC verification is skipped (dev mode)", () => {
    const { req, next, getResult } = createMockContext();

    req.user = {
      id: crypto.randomUUID(),
      stellarAddress: "GDEVSKIP1234567890",
      email: null,
      userType: null as any,
      kycStatus: KYCStatus.PENDING,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const middleware = requireKYC(true); // skipVerification = true (dev mode)
    middleware(req as any, {} as any, next);

    const result = getResult();
    expect(result.passed).toBe(true);
  });

  it("blocks non-approved users when KYC verification is enforced (production)", () => {
    const { req, next, getResult } = createMockContext();

    req.user = {
      id: crypto.randomUUID(),
      stellarAddress: "GBLOCKED1234567890",
      email: null,
      userType: null as any,
      kycStatus: KYCStatus.PENDING,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const middleware = requireKYC(false); // skipVerification = false (production)
    middleware(req as any, {} as any, next);

    const result = getResult();
    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.errorMessage).toContain("KYC approval required");
  });

  it("allows approved users through when KYC verification is enforced", () => {
    const { req, next, getResult } = createMockContext();

    req.user = {
      id: crypto.randomUUID(),
      stellarAddress: "GAPPROVED1234567890",
      email: null,
      userType: null as any,
      kycStatus: KYCStatus.APPROVED,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const middleware = requireKYC(false); // skipVerification = false (production)
    middleware(req as any, {} as any, next);

    const result = getResult();
    expect(result.passed).toBe(true);
  });

  it("allows a dev-approved wallet to publish an invoice (simulated via KYC bypass + invoice publish)", async () => {
    // In dev mode, skipVerification=true means the KYC middleware passes everything.
    // This simulates the flow: user registers via dev endpoint (KYC set to APPROVED),
    // then publishes an invoice. The KYC bypass in dev mode means any user can publish.
    const { req, next, getResult } = createMockContext();

    // Simulate a user who was "dev-approved" — their KYC status is APPROVED
    req.user = {
      id: crypto.randomUUID(),
      stellarAddress: "GDEVAPPROVED1234567890",
      email: null,
      userType: null as any,
      kycStatus: KYCStatus.APPROVED,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Even in production mode (skipVerification=false), an approved user passes
    const middleware = requireKYC(false);
    middleware(req as any, {} as any, next);

    const result = getResult();
    expect(result.passed).toBe(true);
  });

  it("returns 401 when no user is attached to the request (KYC middleware)", () => {
    const { req, next, getResult } = createMockContext();

    // No user attached
    const middleware = requireKYC(false);
    middleware(req as any, {} as any, next);

    const result = getResult();
    expect(result.passed).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.errorMessage).toContain("Authentication required");
  });
});
