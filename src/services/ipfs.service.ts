import type { AppConfig } from "../config/env";
import { ServiceError } from "../utils/service-error";
import type { AppLogger } from "../observability/logger";
import { withCorrelationHeaders } from "../observability/request-context";

export interface IPFSUploadResult {
  hash: string;
  size: number;
  timestamp: string;
}

export interface IPFSServiceDependencies {
  config: AppConfig["ipfs"];
  logger: AppLogger;
  fetchImplementation?: typeof fetch;
}

export interface PinataResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

export class IPFSService {
  private readonly config: AppConfig["ipfs"];
  private readonly logger: AppLogger;
  private readonly fetchImplementation: typeof fetch;

  constructor(dependencies: IPFSServiceDependencies) {
    this.config = dependencies.config;
    this.logger = dependencies.logger;
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch;
  }

  async uploadFile(
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
    invoiceId?: string,
    attemptNumber: number = 1
  ): Promise<IPFSUploadResult> {
    // Validate file size
    const fileSizeMB = fileBuffer.length / (1024 * 1024);
    if (fileSizeMB > this.config.maxFileSizeMB) {
      throw new ServiceError(
        "file_too_large",
        `File size ${fileSizeMB.toFixed(2)}MB exceeds maximum allowed size of ${this.config.maxFileSizeMB}MB`,
        400
      );
    }

    // Validate MIME type
    if (!this.config.allowedMimeTypes.includes(mimeType)) {
      throw new ServiceError(
        "invalid_file_type",
        `File type ${mimeType} is not allowed. Allowed types: ${this.config.allowedMimeTypes.join(", ")}`,
        400
      );
    }

    // Log upload attempt before making the HTTP call
    const gateway = new URL(this.config.apiUrl).hostname;
    this.logger.info("IPFS document upload attempt", {
      operation: "pin_file_to_ipfs",
      invoice_id: invoiceId,
      file_size_bytes: fileBuffer.length,
      gateway,
      attempt_number: attemptNumber,
      initiated_at: new Date().toISOString(),
    });

    try {
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(fileBuffer)], { type: mimeType });
      formData.append("file", blob, filename);

      const response = await this.fetchImplementation(
        `${this.config.apiUrl}/pinning/pinFileToIPFS`,
        {
          method: "POST",
          headers: withCorrelationHeaders({
            Authorization: `Bearer ${this.config.jwt}`,
          }),
          body: formData,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        const errorReason = `${response.status} ${response.statusText}`;

        this.logger.warn("IPFS document upload failed", {
          operation: "pin_file_to_ipfs",
          invoice_id: invoiceId,
          error_reason: errorReason,
          attempt_number: attemptNumber,
          retry_state: attemptNumber > 1 ? "retry" : "initial",
          next_action: "retry_or_surface_failure",
          terminal: true,
          failed_at: new Date().toISOString(),
        });

        throw new ServiceError(
          "ipfs_upload_failed",
          `IPFS upload failed: ${errorReason} - ${errorText}`,
          502
        );
      }

      const result = (await response.json()) as PinataResponse;

      this.logger.info("IPFS document upload completed", {
        cid: result.IpfsHash,
        invoice_id: invoiceId,
        file_size_bytes: result.PinSize,
        uploaded_at: result.Timestamp,
      });

      return {
        hash: result.IpfsHash,
        size: result.PinSize,
        timestamp: result.Timestamp,
      };
    } catch (error) {
      if (error instanceof ServiceError) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      this.logger.warn("IPFS document upload failed", {
        operation: "pin_file_to_ipfs",
        invoice_id: invoiceId,
        error_reason: errorMessage,
        attempt_number: attemptNumber,
        retry_state: attemptNumber > 1 ? "retry" : "initial",
        next_action: "retry_or_surface_failure",
        terminal: true,
        failed_at: new Date().toISOString(),
      });

      throw new ServiceError(
        "ipfs_upload_error",
        `Failed to upload file to IPFS: ${errorMessage}`,
        500
      );
    }
  }

  async generateSignedUrl(cid: string): Promise<string> {
    const gatewayUrl = this.config.gatewayUrl;
    // Pinata V3 uses /files/CID, but /ipfs/CID is often supported on gateways. 
    // We'll use /ipfs/CID as default for backward compatibility with v2 uploads.
    const targetUrl = `${gatewayUrl}/ipfs/${cid}`;
    const expires = this.config.gatewayTokenTtlSeconds;

    this.logger.info("Generating signed IPFS gateway URL", {
      cid,
      expires_in_seconds: expires,
    });

    try {
      const response = await this.fetchImplementation(
        `${this.config.apiUrl}/v3/files/private/download_link`,
        {
          method: "POST",
          headers: withCorrelationHeaders({
            Authorization: `Bearer ${this.config.jwt}`,
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({
            url: targetUrl,
            expires,
            date: Math.floor(Date.now() / 1000),
            method: "GET"
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pinata API returned ${response.status}: ${errorText}`);
      }

      const result = await response.json() as { data?: string; url?: string };
      // Pinata V3 usually returns the url directly or inside a data wrapper
      const signedUrl = result.data || result.url;
      
      if (!signedUrl) {
         throw new Error("Pinata API did not return a valid URL in response");
      }

      return signedUrl;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      
      this.logger.error("Failed to generate signed IPFS URL", {
        cid,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new ServiceError(
        "ipfs_document_unavailable",
        "The requested IPFS document is currently unavailable from the gateway. Please try again in a few moments.",
        503
      );
    }
  }
}

export function createIPFSService(config: AppConfig["ipfs"], logger: AppLogger): IPFSService {
  return new IPFSService({ config, logger });
}
