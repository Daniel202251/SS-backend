import { InvoiceService, UploadDocumentInput } from "../../src/services/invoice.service";
import { IPFSService } from "../../src/services/ipfs.service";
import { ServiceError } from "../../src/utils/service-error";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatus } from "../../src/types/enums";
import { logger } from "../../src/observability/logger";

/**
 * Integration coverage for issue #218: repeated IPFS pin failures must stop
 * after the configured retry limit and must leave the invoice's document
 * state consistent (no false "successfully pinned" status).
 *
 * SCOPE NOTE (see PR description for full disclosure): IPFSService.uploadFile
 * (src/services/ipfs.service.ts) does not contain an internal retry loop —
 * it makes exactly one HTTP call per invocation and the caller is expected
 * to drive retries (this mirrors the existing convention in
 * tests/integration/ipfs-upload.test.ts, which manually invokes uploadFile
 * multiple times with an increasing attemptNumber to simulate a retrying
 * caller). InvoiceService.uploadDocument itself does not wrap uploadFile in
 * any retry loop at all — it calls it once and rejects on the first failure.
 *
 * This suite builds the minimal retry-exhaustion harness consistent with
 * that architecture: it drives InvoiceService.uploadDocument up to a fixed
 * "maximum attempts" count (mirroring how a retrying caller such as a queue
 * consumer or client-side retry policy would behave), and verifies that
 * after the configured number of failed attempts, the IPFS provider was
 * called exactly that many times, the invoice document state is never
 * corrupted with a false-positive pin, and the final error is a stable,
 * credential-free ServiceError.
 */
describe("IPFS upload retry exhaustion (issue #218)", () => {
  const MAX_RETRY_ATTEMPTS = 3;

  const ipfsConfig = {
    apiUrl: "https://api.pinata.cloud",
    jwt: "super-secret-pinata-jwt-should-never-leak",
    maxFileSizeMB: 10,
    allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
    uploadRateLimit: {
      windowMs: 900000,
      maxUploads: 10,
    },
  };

  function createFakeInvoiceRepository(invoice: Invoice) {
    const store = new Map<string, Invoice>([[invoice.id, { ...invoice } as unknown as Invoice]]);

    return {
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null),
      findOneBy: jest.fn(async () => null),
      find: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      create: jest.fn((data: Partial<Invoice>) => ({ ...invoice, ...data } as unknown as Invoice)),
      save: jest.fn(async (updated: Invoice) => {
        store.set(updated.id, updated);
        return updated;
      }),
      __store: store,
    };
  }

  function createFailingFetch(): jest.Mock {
    return jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => ({ error: "Pinata gateway unavailable" }),
      text: async () => "Pinata gateway unavailable",
    });
  }

  function baseInvoice(): Invoice {
    return {
      id: "invoice-retry-exhaustion-1",
      sellerId: "seller-retry-1",
      invoiceNumber: "INV-RETRY-001",
      customerName: "Retry Exhaustion Customer",
      amount: "1000.0000",
      discountRate: "5.00",
      netAmount: "950.0000",
      dueDate: new Date("2025-12-31"),
      ipfsHash: null,
      riskScore: null,
      status: InvoiceStatus.DRAFT,
      smartContractId: null,
      rejectionReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      seller: undefined as unknown as Invoice["seller"],
      investments: [],
      transactions: [],
    } as unknown as Invoice;
  }

  /**
   * Drives uploadDocument through up to `maxAttempts` retries, the way a
   * retrying caller (queue worker / client policy) would, stopping at the
   * first success or once the max attempt count is exhausted.
   */
  async function uploadWithRetries(
    invoiceService: InvoiceService,
    input: UploadDocumentInput,
    maxAttempts: number
  ): Promise<{ succeeded: boolean; lastError?: unknown; attemptsMade: number }> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await invoiceService.uploadDocument(input);
        return { succeeded: true, attemptsMade: attempt };
      } catch (error) {
        lastError = error;
      }
    }

    return { succeeded: false, lastError, attemptsMade: maxAttempts };
  }

  it("calls the IPFS provider exactly the configured maximum number of times before giving up", async () => {
    const invoice = baseInvoice();
    const invoiceRepository = createFakeInvoiceRepository(invoice);
    const mockFetch = createFailingFetch();

    const ipfsService = new IPFSService({
      config: ipfsConfig,
      logger: logger.child({ test: "ipfs-retry-exhaustion" }),
      fetchImplementation: mockFetch,
    });

    const invoiceService = new InvoiceService({
      invoiceRepository: invoiceRepository as any,
      ipfsService,
    });

    const input: UploadDocumentInput = {
      invoiceId: invoice.id,
      sellerId: invoice.sellerId,
      fileBuffer: Buffer.from("test invoice document"),
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    };

    const outcome = await uploadWithRetries(invoiceService, input, MAX_RETRY_ATTEMPTS);

    expect(outcome.succeeded).toBe(false);
    expect(outcome.attemptsMade).toBe(MAX_RETRY_ATTEMPTS);
    expect(mockFetch).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);
  });

  it("never leaves the invoice with a false successful pin status after exhausting retries", async () => {
    const invoice = baseInvoice();
    const invoiceRepository = createFakeInvoiceRepository(invoice);
    const mockFetch = createFailingFetch();

    const ipfsService = new IPFSService({
      config: ipfsConfig,
      logger: logger.child({ test: "ipfs-retry-exhaustion-state" }),
      fetchImplementation: mockFetch,
    });

    const invoiceService = new InvoiceService({
      invoiceRepository: invoiceRepository as any,
      ipfsService,
    });

    const input: UploadDocumentInput = {
      invoiceId: invoice.id,
      sellerId: invoice.sellerId,
      fileBuffer: Buffer.from("test invoice document"),
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    };

    await uploadWithRetries(invoiceService, input, MAX_RETRY_ATTEMPTS);

    const persisted = invoiceRepository.__store.get(invoice.id);
    expect(persisted?.ipfsHash).toBeNull();
    // save() must never have been called with a truthy ipfsHash — the
    // invoice's document state must stay consistent (never "successfully
    // pinned") after every attempt failed.
    for (const call of invoiceRepository.save.mock.calls) {
      expect(call[0].ipfsHash).toBeFalsy();
    }
  });

  it("exposes a stable, credential-free service error after the final failed attempt", async () => {
    const invoice = baseInvoice();
    const invoiceRepository = createFakeInvoiceRepository(invoice);
    const mockFetch = createFailingFetch();

    const ipfsService = new IPFSService({
      config: ipfsConfig,
      logger: logger.child({ test: "ipfs-retry-exhaustion-error" }),
      fetchImplementation: mockFetch,
    });

    const invoiceService = new InvoiceService({
      invoiceRepository: invoiceRepository as any,
      ipfsService,
    });

    const input: UploadDocumentInput = {
      invoiceId: invoice.id,
      sellerId: invoice.sellerId,
      fileBuffer: Buffer.from("test invoice document"),
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    };

    const outcome = await uploadWithRetries(invoiceService, input, MAX_RETRY_ATTEMPTS);

    expect(outcome.lastError).toBeInstanceOf(ServiceError);
    const error = outcome.lastError as ServiceError;
    expect(error.code).toBe("ipfs_upload_failed");
    expect(error.statusCode).toBe(502);

    const serialized = JSON.stringify({ message: error.message, code: error.code });
    expect(serialized).not.toContain(ipfsConfig.jwt);
    expect(serialized.toLowerCase()).not.toContain("bearer");
  });

  it("does not retry indefinitely: stops immediately once a retry attempt finally succeeds", async () => {
    const invoice = baseInvoice();
    const invoiceRepository = createFakeInvoiceRepository(invoice);

    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: async () => ({ error: "Pinata gateway unavailable" }),
        text: async () => "Pinata gateway unavailable",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: async () => ({ error: "Pinata gateway unavailable" }),
        text: async () => "Pinata gateway unavailable",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          IpfsHash: "QmRecoveredHash",
          PinSize: 2048,
          Timestamp: "2024-06-15T12:00:00.000Z",
        }),
        text: async () => "",
      });

    const ipfsService = new IPFSService({
      config: ipfsConfig,
      logger: logger.child({ test: "ipfs-retry-recovery" }),
      fetchImplementation: mockFetch,
    });

    const invoiceService = new InvoiceService({
      invoiceRepository: invoiceRepository as any,
      ipfsService,
    });

    const input: UploadDocumentInput = {
      invoiceId: invoice.id,
      sellerId: invoice.sellerId,
      fileBuffer: Buffer.from("test invoice document"),
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    };

    const outcome = await uploadWithRetries(invoiceService, input, MAX_RETRY_ATTEMPTS);

    expect(outcome.succeeded).toBe(true);
    expect(outcome.attemptsMade).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const persisted = invoiceRepository.__store.get(invoice.id);
    expect(persisted?.ipfsHash).toBe("QmRecoveredHash");
  });
});
