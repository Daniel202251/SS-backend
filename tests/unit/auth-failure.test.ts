import jwt from "jsonwebtoken";
import {
  buildAuthFailureDetails,
  classifyJwtError,
  truncateWalletAddress,
} from "../../src/lib/auth-failure";

describe("auth failure helpers", () => {
  it("truncates wallet addresses consistently", () => {
    expect(truncateWalletAddress("GABCDEFGHIJKLMNO1234567890")).toBe("GABC...7890");
    expect(truncateWalletAddress("G123")).toBe("G123");
    expect(truncateWalletAddress(null)).toBeNull();
  });

  it("extracts a truncated address from a parseable token", () => {
    const token = jwt.sign({ sub: "GABCDEFGHIJKLMNO1234567890" }, "test-secret", {
      expiresIn: "1h",
    });

    expect(buildAuthFailureDetails(token, "invalid_signature")).toEqual({
      authFailure: {
        reason: "invalid_signature",
        truncatedAddress: "GABC...7890",
        failedAt: expect.any(String),
      },
    });
  });

  it("returns null truncated addresses for unparseable tokens", () => {
    expect(buildAuthFailureDetails("not-a-jwt", "invalid_token")).toEqual({
      authFailure: {
        reason: "invalid_token",
        truncatedAddress: null,
        failedAt: expect.any(String),
      },
    });
  });

  describe("classifyJwtError", () => {
    it("classifies TokenExpiredError as expired_token", () => {
      const token = jwt.sign({ sub: "GABC" }, "test-secret", { expiresIn: -1 });
      let caught: unknown;
      try {
        jwt.verify(token, "test-secret");
      } catch (error) {
        caught = error;
      }
      expect(classifyJwtError(caught)).toBe("expired_token");
    });

    it("classifies a bad-signature JsonWebTokenError as invalid_signature", () => {
      const token = jwt.sign({ sub: "GABC" }, "correct-secret");
      let caught: unknown;
      try {
        jwt.verify(token, "wrong-secret");
      } catch (error) {
        caught = error;
      }
      expect(classifyJwtError(caught)).toBe("invalid_signature");
    });

    it("classifies a structurally malformed token as unparseable_token, not invalid_token (#386)", () => {
      let caught: unknown;
      try {
        jwt.verify("not-a-jwt-at-all", "test-secret");
      } catch (error) {
        caught = error;
      }
      expect(classifyJwtError(caught)).toBe("unparseable_token");
    });

    it("classifies any other JsonWebTokenError as invalid_token", () => {
      let caught: unknown;
      try {
        jwt.verify("a.b.c", "test-secret");
      } catch (error) {
        caught = error;
      }
      expect(classifyJwtError(caught)).toBe("invalid_token");
    });

    it("falls back to invalid_token for a non-jwt error", () => {
      expect(classifyJwtError(new Error("something else"))).toBe("invalid_token");
    });
  });
});
