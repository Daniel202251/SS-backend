import { computeWebhookSignature, verifyWebhookSignature } from "../../src/utils/webhook-signature";

describe("verifyWebhookSignature", () => {
  const SECRET_A = "whsec_test_secret_a_12345";
  const SECRET_B = "whsec_test_secret_b_67890";
  const PAYLOAD = '{"event":"invoice.paid","amount":6000}';

  it("should return true for correct payload + correct secret", () => {
    const signature = computeWebhookSignature(PAYLOAD, SECRET_A);
    expect(verifyWebhookSignature(PAYLOAD, signature, SECRET_A)).toBe(true);
  });

  it("should return false for correct payload + wrong secret", () => {
    const signature = computeWebhookSignature(PAYLOAD, SECRET_A);
    expect(verifyWebhookSignature(PAYLOAD, signature, SECRET_B)).toBe(false);
  });

  it("should return false for wrong payload + correct secret", () => {
    const signature = computeWebhookSignature(PAYLOAD, SECRET_A);
    const tamperedPayload = '{"event":"invoice.paid","amount":9999}';
    expect(verifyWebhookSignature(tamperedPayload, signature, SECRET_A)).toBe(false);
  });

  it("should return false for a completely fabricated signature", () => {
    expect(verifyWebhookSignature(PAYLOAD, "not-a-real-signature", SECRET_A)).toBe(false);
  });

  it("should return false for empty inputs", () => {
    expect(verifyWebhookSignature("", computeWebhookSignature(PAYLOAD, SECRET_A), SECRET_A)).toBe(
      false
    );
    expect(verifyWebhookSignature(PAYLOAD, "", SECRET_A)).toBe(false);
    expect(verifyWebhookSignature(PAYLOAD, computeWebhookSignature(PAYLOAD, SECRET_A), "")).toBe(
      false
    );
  });

  it("should never throw an exception", () => {
    // Various malformed inputs should all return false, never throw
    expect(verifyWebhookSignature(PAYLOAD, "zzz", SECRET_A)).toBe(false);
    expect(verifyWebhookSignature(PAYLOAD, "abc123", SECRET_A)).toBe(false);
    expect(verifyWebhookSignature("{}", "0000000000000000", SECRET_A)).toBe(false);
  });

  it("should return false when signature length differs from expected", () => {
    const signature = computeWebhookSignature(PAYLOAD, SECRET_A);
    // Truncate the signature
    expect(verifyWebhookSignature(PAYLOAD, signature.slice(0, 10), SECRET_A)).toBe(false);
  });

  it("should produce deterministic signatures", () => {
    const sig1 = computeWebhookSignature(PAYLOAD, SECRET_A);
    const sig2 = computeWebhookSignature(PAYLOAD, SECRET_A);
    expect(sig1).toBe(sig2);
  });

  it("should produce different signatures for different secrets", () => {
    const sigA = computeWebhookSignature(PAYLOAD, SECRET_A);
    const sigB = computeWebhookSignature(PAYLOAD, SECRET_B);
    expect(sigA).not.toBe(sigB);
  });
});
