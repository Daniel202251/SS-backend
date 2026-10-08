import { IPFSService } from "../src/services/ipfs.service";
import { ServiceError } from "../src/utils/service-error";
import { logger } from "../src/observability/logger";

describe("IPFSService", () => {
  const mockConfig = {
    apiUrl: "https://api.pinata.cloud",
    jwt: "test-jwt-token",
    gatewayUrl: "https://gateway.pinata.cloud",
    gatewayTokenTtlSeconds: 3600,
    maxFileSizeMB: 10,
    allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
    uploadRateLimit: {
      windowMs: 900000,
      maxUploads: 10,
    },
  };

  let mockFetch: jest.MockedFunction<typeof fetch>;
  let ipfsService: IPFSService;

  beforeEach(() => {
    mockFetch = jest.fn();
    ipfsService = new IPFSService({
      config: mockConfig,
      logger: logger.child({ test: "ipfs-service" }),
      fetchImplementation: mockFetch,
    });
  });

  describe("uploadFile", () => {
    const validFileBuffer = Buffer.from("test file content");
    const validFilename = "test.pdf";
    const validMimeType = "application/pdf";

    it("should successfully upload a valid file", async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          IpfsHash: "QmTestHash123",
          PinSize: 1024,
          Timestamp: "2024-01-01T00:00:00.000Z",
        }),
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      const result = await ipfsService.uploadFile(validFileBuffer, validFilename, validMimeType);

      expect(result).toEqual({
        hash: "QmTestHash123",
        size: 1024,
        timestamp: "2024-01-01T00:00:00.000Z",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.pinata.cloud/pinning/pinFileToIPFS",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer test-jwt-token",
          },
          body: expect.any(FormData),
        })
      );
    });

    it("should reject files that are too large", async () => {
      const largeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB

      await expect(
        ipfsService.uploadFile(largeBuffer, validFilename, validMimeType)
      ).rejects.toThrow(ServiceError);

      await expect(
        ipfsService.uploadFile(largeBuffer, validFilename, validMimeType)
      ).rejects.toMatchObject({
        code: "file_too_large",
        statusCode: 400,
      });
    });

    it("should reject files with invalid MIME types", async () => {
      await expect(
        ipfsService.uploadFile(validFileBuffer, "test.txt", "text/plain")
      ).rejects.toThrow(ServiceError);

      await expect(
        ipfsService.uploadFile(validFileBuffer, "test.txt", "text/plain")
      ).rejects.toMatchObject({
        code: "invalid_file_type",
        statusCode: 400,
      });
    });

    it("should handle IPFS API errors", async () => {
      const mockResponse = {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: jest.fn().mockResolvedValue("Invalid file"),
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      await expect(
        ipfsService.uploadFile(validFileBuffer, validFilename, validMimeType)
      ).rejects.toThrow(ServiceError);

      await expect(
        ipfsService.uploadFile(validFileBuffer, validFilename, validMimeType)
      ).rejects.toMatchObject({
        code: "ipfs_upload_failed",
        statusCode: 502,
      });
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      await expect(
        ipfsService.uploadFile(validFileBuffer, validFilename, validMimeType)
      ).rejects.toThrow(ServiceError);

      await expect(
        ipfsService.uploadFile(validFileBuffer, validFilename, validMimeType)
      ).rejects.toMatchObject({
        code: "ipfs_upload_error",
        statusCode: 500,
      });
    });
  });
});
