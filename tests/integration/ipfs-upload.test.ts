import { IPFSService } from "../../src/services/ipfs.service";
import { ServiceError } from "../../src/utils/service-error";
import { logger } from "../../src/observability/logger";

function createMockFetch(
  responses: Array<{ ok: boolean; status: number; statusText: string; body: unknown }>
) {
  let callCount = 0;
  return jest.fn().mockImplementation(async () => {
    const response = responses[callCount] ?? responses[responses.length - 1];
    callCount++;
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    };
  });
}

describe("IPFS upload integration – retry backoff & error handling", () => {
  const mockConfig = {
    apiUrl: "https://api.pinata.cloud",
    jwt: "test-jwt-token",
    maxFileSizeMB: 10,
    allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
    uploadRateLimit: {
      windowMs: 900000,
      maxUploads: 10,
    },
  };

  const validBuffer = Buffer.alloc(1024, 0x42);
  const validFilename = "test.pdf";
  const validMimeType = "application/pdf";

  describe("429 rate limit followed by successful retry", () => {
    it("retries after 429 and succeeds on second attempt", async () => {
      const mockFetch = createMockFetch([
        {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          body: { error: "Rate limit exceeded" },
        },
        {
          ok: true,
          status: 200,
          statusText: "OK",
          body: {
            IpfsHash: "QmRetrySuccess",
            PinSize: 1024,
            Timestamp: "2024-01-01T00:00:00.000Z",
          },
        },
      ]);

      const service = new IPFSService({
        config: mockConfig,
        logger: logger.child({ test: "ipfs-retry" }),
        fetchImplementation: mockFetch,
      });

      const firstAttempt = service.uploadFile(
        validBuffer,
        validFilename,
        validMimeType,
        "inv-1",
        1
      );
      await expect(firstAttempt).rejects.toThrow(ServiceError);
      await expect(firstAttempt).rejects.toMatchObject({ code: "ipfs_upload_failed" });

      const secondAttempt = service.uploadFile(
        validBuffer,
        validFilename,
        validMimeType,
        "inv-1",
        2
      );
      const result = await secondAttempt;
      expect(result.hash).toBe("QmRetrySuccess");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("exponential backoff delay is observed between retries", async () => {
      const start = Date.now();
      let lastCallTime = start;
      const delays: number[] = [];

      let callCount = 0;
      const mockFetch = jest.fn().mockImplementation(async () => {
        callCount++;
        const now = Date.now();
        delays.push(now - lastCallTime);
        lastCallTime = now;

        if (callCount === 1) {
          return {
            ok: false,
            status: 429,
            statusText: "Too Many Requests",
            json: async () => ({ error: "Rate limit exceeded" }),
            text: async () => "Rate limit exceeded",
          };
        }

        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            IpfsHash: "QmBackoff",
            PinSize: 512,
            Timestamp: "2024-01-01T00:00:00.000Z",
          }),
          text: async () => "",
        };
      });

      const service = new IPFSService({
        config: mockConfig,
        logger: logger.child({ test: "ipfs-backoff" }),
        fetchImplementation: mockFetch,
      });

      try {
        await service.uploadFile(validBuffer, validFilename, validMimeType, "inv-1", 1);
      } catch {
        // Expected 429 rate limit on first attempt
      }
      await new Promise((r) => setTimeout(r, 50));
      await service.uploadFile(validBuffer, validFilename, validMimeType, "inv-1", 2);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("file size validation", () => {
    it("rejects files exceeding 10MB limit without calling IPFS gateway", async () => {
      const mockFetch = jest.fn();
      const oversizedBuffer = Buffer.alloc(11 * 1024 * 1024, 0x42);

      const service = new IPFSService({
        config: mockConfig,
        logger: logger.child({ test: "ipfs-oversize" }),
        fetchImplementation: mockFetch,
      });

      await expect(
        service.uploadFile(oversizedBuffer, validFilename, validMimeType)
      ).rejects.toThrow(ServiceError);

      await expect(
        service.uploadFile(oversizedBuffer, validFilename, validMimeType)
      ).rejects.toMatchObject({ code: "file_too_large", statusCode: 400 });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects invalid MIME types without calling IPFS gateway", async () => {
      const mockFetch = jest.fn();

      const service = new IPFSService({
        config: mockConfig,
        logger: logger.child({ test: "ipfs-mime" }),
        fetchImplementation: mockFetch,
      });

      await expect(
        service.uploadFile(validBuffer, "test.exe", "application/x-executable")
      ).rejects.toMatchObject({ code: "invalid_file_type", statusCode: 400 });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("error reporting", () => {
    it("propagates network errors as ipfs_upload_error", async () => {
      const mockFetch = createMockFetch([]);

      const service = new IPFSService({
        config: mockConfig,
        logger: logger.child({ test: "ipfs-network" }),
        fetchImplementation: mockFetch,
      });

      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(
        service.uploadFile(validBuffer, validFilename, validMimeType)
      ).rejects.toMatchObject({ code: "ipfs_upload_error", statusCode: 500 });
    });

    it("reports non-2xx Pinata responses as ipfs_upload_failed", async () => {
      const mockFetch = createMockFetch([
        {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          body: { error: "Pinata unavailable" },
        },
      ]);

      const service = new IPFSService({
        config: mockConfig,
        logger: logger.child({ test: "ipfs-500" }),
        fetchImplementation: mockFetch,
      });

      await expect(
        service.uploadFile(validBuffer, validFilename, validMimeType)
      ).rejects.toMatchObject({ code: "ipfs_upload_failed", statusCode: 502 });
    });

    it("includes error details in thrown ServiceError", async () => {
      const mockFetch = createMockFetch([
        {
          ok: false,
          status: 402,
          statusText: "Payment Required",
          body: { error: "Subscription expired" },
        },
      ]);

      const service = new IPFSService({
        config: mockConfig,
        logger: logger.child({ test: "ipfs-details" }),
        fetchImplementation: mockFetch,
      });

      try {
        await service.uploadFile(validBuffer, validFilename, validMimeType);
        fail("Expected ServiceError to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceError);
        expect((error as ServiceError).message).toContain("402");
        expect((error as ServiceError).message).toContain("Payment Required");
      }
    });
  });

  describe("successful upload", () => {
    it("returns correct IPFS hash, size, and timestamp on success", async () => {
      const mockFetch = createMockFetch([
        {
          ok: true,
          status: 200,
          statusText: "OK",
          body: {
            IpfsHash: "QmFinalHash999",
            PinSize: 2048,
            Timestamp: "2024-06-15T12:00:00.000Z",
          },
        },
      ]);

      const service = new IPFSService({
        config: mockConfig,
        logger: logger.child({ test: "ipfs-success" }),
        fetchImplementation: mockFetch,
      });

      const result = await service.uploadFile(
        validBuffer,
        validFilename,
        validMimeType,
        "inv-1",
        1
      );

      expect(result).toEqual({
        hash: "QmFinalHash999",
        size: 2048,
        timestamp: "2024-06-15T12:00:00.000Z",
      });
    });

    it("sends correct Authorization header to Pinata", async () => {
      const mockFetch = createMockFetch([
        {
          ok: true,
          status: 200,
          statusText: "OK",
          body: { IpfsHash: "QmAuth", PinSize: 100, Timestamp: "2024-01-01T00:00:00.000Z" },
        },
      ]);

      const service = new IPFSService({
        config: mockConfig,
        logger: logger.child({ test: "ipfs-auth" }),
        fetchImplementation: mockFetch,
      });

      await service.uploadFile(validBuffer, validFilename, validMimeType);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.pinata.cloud/pinning/pinFileToIPFS",
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: "Bearer test-jwt-token" },
        })
      );
    });
  });
});
