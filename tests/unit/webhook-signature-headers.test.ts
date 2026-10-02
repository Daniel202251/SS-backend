import {
  computeWebhookSignature,
  computeWebhookSignatureForTimestamp,
  WebhookSignatureError,
  verifyWebhookSignatureHeaders,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "../../src/utils/webhook-signature";

/**
 * Unit coverage for issue #223: webhook authentication must accept only
 * correctly signed payloads with the configured secret, and every rejection
 * (modified payload / signature / timestamp, missing or malformed headers)
 * must be surfaced as a typed, addressable validation error.
 */

/** Asserts that `fn` throws a WebhookSignatureError carrying `code`. */
function expectWebhookError(fn: () => unknown, code: WebhookSignatureError["code"]): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect((error as WebhookSignatureError).code).toBe(code);
    return;
  }
  throw new Error(`Expected a WebhookSignatureError with code "${code}" but it did not throw.`);
}

describe("computeWebhookSignatureForTimestamp", () => {
  it("signs `<timestamp>.<payload>` with the given secret", () => {
    const secret = "whsec_test_secret_12345";
    const payload = '{"event":"invoice.paid","amount":6000}';
    const timestamp = "1700000000000";

    const signature = computeWebhookSignatureForTimestamp(payload, timestamp, secret);

    expect(signature).toBe(computeWebhookSignature(`${timestamp}.${payload}`, secret));
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyWebhookSignatureHeaders", () => {
  const SECRET = "whsec_test_secret_12345";
  const PAYLOAD = '{"event":"invoice.paid","amount":6000}';
  const NOW_MS = 1_700_000_000_000;

  const now = () => NOW_MS;

  function validSignature(timestamp: number = NOW_MS): string {
    return computeWebhookSignatureForTimestamp(PAYLOAD, String(timestamp), SECRET);
  }

  describe("acceptance", () => {
    it("accepts a correctly signed payload within the timestamp window", () => {
      const timestamp = String(NOW_MS - 1_000);

      const result = verifyWebhookSignatureHeaders({
        payload: PAYLOAD,
        signature: validSignature(NOW_MS - 1_000),
        timestamp,
        secret: SECRET,
        now,
      });

      expect(result).toBe(timestamp);
    });

    it("accepts the exact-now timestamp", () => {
      expect(
        verifyWebhookSignatureHeaders({
          payload: PAYLOAD,
          signature: validSignature(NOW_MS),
          timestamp: String(NOW_MS),
          secret: SECRET,
          now,
        })
      ).toBe(String(NOW_MS));
    });
  });

  describe("rejecting modifications", () => {
    it("rejects a payload that no longer matches the signature", () => {
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: '{"event":"invoice.paid","amount":9999}',
            signature: validSignature(),
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "INVALID_SIGNATURE"
      );
    });

    it("rejects a modified signature", () => {
      const tampered = `${validSignature().slice(0, 63)}0`;

      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: tampered,
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "INVALID_SIGNATURE"
      );
    });

    it("rejects a signature produced with the wrong secret", () => {
      const wrongSig = computeWebhookSignatureForTimestamp(
        PAYLOAD,
        String(NOW_MS),
        "different-secret"
      );

      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: wrongSig,
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "INVALID_SIGNATURE"
      );
    });

    it("rejects a timestamp that was changed after signing", () => {
      const signedTimestamp = String(NOW_MS - 2_000);

      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(NOW_MS - 2_000),
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "INVALID_SIGNATURE"
      );
    });
  });

  describe("missing headers", () => {
    it("throws MISSING_SIGNATURE when the signature header is absent", () => {
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: undefined,
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "MISSING_SIGNATURE"
      );
    });

    it("throws MISSING_SIGNATURE when the signature header is empty", () => {
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: "",
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "MISSING_SIGNATURE"
      );
    });

    it("throws MISSING_SIGNATURE when the signature header is an empty string / null", () => {
      for (const missing of [null, ""]) {
        expectWebhookError(
          () =>
            verifyWebhookSignatureHeaders({
              payload: PAYLOAD,
              signature: missing,
              timestamp: String(NOW_MS),
              secret: SECRET,
              now,
            }),
          "MISSING_SIGNATURE"
        );
      }
    });

    it("throws MISSING_TIMESTAMP when the timestamp header is absent/null/empty", () => {
      for (const missing of [undefined, null, ""]) {
        expectWebhookError(
          () =>
            verifyWebhookSignatureHeaders({
              payload: PAYLOAD,
              signature: validSignature(),
              timestamp: missing,
              secret: SECRET,
              now,
            }),
          "MISSING_TIMESTAMP"
        );
      }
    });
  });

  describe("malformed headers", () => {
    it("throws MALFORMED_SIGNATURE for a non-hex signature", () => {
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: "not-a-hex-signature",
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "MALFORMED_SIGNATURE"
      );
    });

    it("throws MALFORMED_SIGNATURE for a signature of the wrong length", () => {
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: "a".repeat(10),
            timestamp: String(NOW_MS),
            secret: SECRET,
            now,
          }),
        "MALFORMED_SIGNATURE"
      );
    });

    it("throws TIMESTAMP_OUT_OF_RANGE for an unparseable timestamp", () => {
      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(),
            timestamp: "not-a-timestamp",
            secret: SECRET,
            now,
          }),
        "TIMESTAMP_OUT_OF_RANGE"
      );
    });

    it("throws TIMESTAMP_SKEWED for a timestamp too far in the past", () => {
      const oldTs = NOW_MS - 11 * 60 * 1000; // 11 minutes old, default window is 5 mins

      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(oldTs),
            timestamp: String(oldTs),
            secret: SECRET,
            now,
          }),
        "TIMESTAMP_SKEWED"
      );
    });

    it("throws TIMESTAMP_SKEWED for a timestamp too far in the future", () => {
      const futureTs = NOW_MS + 11 * 60 * 1000;

      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(futureTs),
            timestamp: String(futureTs),
            secret: SECRET,
            now,
          }),
        "TIMESTAMP_SKEWED"
      );
    });
  });

  describe("configured skew window", () => {
    it("honours a custom maxTimestampSkewMs", () => {
      const withinWindow = NOW_MS - 2_000;

      expect(() =>
        verifyWebhookSignatureHeaders({
          payload: PAYLOAD,
          signature: validSignature(withinWindow),
          timestamp: String(withinWindow),
          secret: SECRET,
          maxTimestampSkewMs: 5_000,
          now,
        })
      ).not.toThrow();

      const outsideWindow = NOW_MS - 10_000;

      expectWebhookError(
        () =>
          verifyWebhookSignatureHeaders({
            payload: PAYLOAD,
            signature: validSignature(outsideWindow),
            timestamp: String(outsideWindow),
            secret: SECRET,
            maxTimestampSkewMs: 5_000,
            now,
          }),
        "TIMESTAMP_SKEWED"
      );
    });
  });
});
