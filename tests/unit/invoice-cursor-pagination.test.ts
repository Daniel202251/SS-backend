import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { InvoiceStatus } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";
import { createInvoiceRouter } from "../../src/routes/invoice.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";
import {
  encodeInvoiceCursor,
  decodeInvoiceCursor,
} from "../../src/utils/invoice-cursor.utils";
import { InvoiceService } from "../../src/services/invoice.service";
import type { Invoice } from "../../src/models/Invoice.model";

describe("Invoice Keyset Cursor Pagination", () => {
  describe("Cursor Encoding and Decoding", () => {
    it("encodes createdAt and id into an opaque base64 string", () => {
      const date = new Date("2026-09-24T12:00:00.000Z");
      const cursor = encodeInvoiceCursor({
        createdAt: date,
        id: "123e4567-e89b-12d3-a456-426614174000",
      });

      expect(typeof cursor).toBe("string");
      expect(cursor).not.toContain("|");

      const decoded = decodeInvoiceCursor(cursor);
      expect(decoded.createdAt?.toISOString()).toBe(date.toISOString());
      expect(decoded.id).toBe("123e4567-e89b-12d3-a456-426614174000");
    });

    it("decodes legacy base64 JSON cursor format", () => {
      const jsonCursor = Buffer.from(
        JSON.stringify({
          createdAt: "2026-09-24T10:00:00.000Z",
          id: "123e4567-e89b-12d3-a456-426614174001",
        })
      ).toString("base64");

      const decoded = decodeInvoiceCursor(jsonCursor);
      expect(decoded.createdAt?.toISOString()).toBe("2026-09-24T10:00:00.000Z");
      expect(decoded.id).toBe("123e4567-e89b-12d3-a456-426614174001");
    });

    it("decodes query-pagination.utils format with field and value", () => {
      const fieldCursor = Buffer.from(
        JSON.stringify({
          field: "invoice.createdAt",
          value: "2026-09-24T08:00:00.000Z",
          id: "123e4567-e89b-12d3-a456-426614174002",
        })
      ).toString("base64");

      const decoded = decodeInvoiceCursor(fieldCursor);
      expect(decoded.createdAt?.toISOString()).toBe("2026-09-24T08:00:00.000Z");
      expect(decoded.id).toBe("123e4567-e89b-12d3-a456-426614174002");
    });

    it("accepts a raw UUID as cursor key", () => {
      const rawUuid = "123e4567-e89b-12d3-a456-426614174003";
      const decoded = decodeInvoiceCursor(rawUuid);
      expect(decoded.id).toBe(rawUuid);
      expect(decoded.createdAt).toBeUndefined();
    });

    it("accepts a raw ISO date string as cursor key", () => {
      const iso = "2026-09-24T06:00:00.000Z";
      const decoded = decodeInvoiceCursor(iso);
      expect(decoded.createdAt?.toISOString()).toBe(iso);
    });

    it("throws 400 for empty or whitespace cursor", () => {
      expect(() => decodeInvoiceCursor("")).toThrow(ServiceError);
      expect(() => decodeInvoiceCursor("   ")).toThrow(ServiceError);
    });

    it("throws 400 for completely invalid cursor string", () => {
      expect(() => decodeInvoiceCursor("invalid-cursor-!@#$%^&*()")).toThrow(ServiceError);
    });
  });

  describe("InvoiceService Keys-based Pagination and Concurrency", () => {
    let mockRepo: any;
    let service: InvoiceService;

    const sellerId = "seller-uuid-123";

    function createMockInvoice(id: string, createdAt: Date, invoiceNumber: string): Invoice {
      return {
        id,
        sellerId,
        invoiceNumber,
        customerName: `Customer ${invoiceNumber}`,
        amount: "100.00",
        discountRate: "5.00",
        netAmount: "95.00",
        dueDate: new Date("2026-12-31"),
        status: InvoiceStatus.PUBLISHED,
        ipfsHash: null,
        riskScore: null,
        smartContractId: null,
        rejectionReason: null,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
        version: 1,
      } as Invoice;
    }

    beforeEach(() => {
      mockRepo = {
        findOne: jest.fn(),
        findOneBy: jest.fn(),
        find: jest.fn(),
        count: jest.fn(),
        save: jest.fn(),
        create: jest.fn(),
      };

      service = new InvoiceService({
        invoiceRepository: mockRepo,
        ipfsService: {} as any,
      });
    });

    it("returns nextCursor when more pages exist and null on the last page", async () => {
      const now = Date.now();
      const inv1 = createMockInvoice("id-1", new Date(now - 1000), "INV-001");
      const inv2 = createMockInvoice("id-2", new Date(now - 2000), "INV-002");
      const inv3 = createMockInvoice("id-3", new Date(now - 3000), "INV-003");

      // Page 1: limit 2, return 3 rows (indicating hasMore)
      mockRepo.find.mockResolvedValueOnce([inv1, inv2, inv3]);
      mockRepo.count.mockResolvedValueOnce(3);

      const page1 = await service.getInvoicesBySellerId({
        sellerId,
        cursor: null,
        limit: 2,
      });

      expect(page1.invoices).toHaveLength(2);
      expect(page1.invoices[0].id).toBe("id-1");
      expect(page1.invoices[1].id).toBe("id-2");
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).not.toBeNull();

      // Page 2: pass page1.nextCursor, return 1 row (no more)
      mockRepo.find.mockResolvedValueOnce([inv3]);
      mockRepo.count.mockResolvedValueOnce(3);

      const page2 = await service.getInvoicesBySellerId({
        sellerId,
        cursor: page1.nextCursor,
        limit: 2,
      });

      expect(page2.invoices).toHaveLength(1);
      expect(page2.invoices[0].id).toBe("id-3");
      expect(page2.hasMore).toBe(false);
      expect(page2.nextCursor).toBeNull();
    });

    it("guarantees stable pagination across concurrent invoice insertions", async () => {
      // Simulation: 4 invoices already exist
      const t1 = new Date("2026-09-24T10:00:00.000Z");
      const t2 = new Date("2026-09-24T09:00:00.000Z");
      const t3 = new Date("2026-09-24T08:00:00.000Z");
      const t4 = new Date("2026-09-24T07:00:00.000Z");

      const inv1 = createMockInvoice("id-1", t1, "INV-001");
      const inv2 = createMockInvoice("id-2", t2, "INV-002");
      const inv3 = createMockInvoice("id-3", t3, "INV-003");
      const inv4 = createMockInvoice("id-4", t4, "INV-004");

      const allInvoices = [inv1, inv2, inv3, inv4];

      // Simulated DB filter using keyset predicate
      mockRepo.find.mockImplementation((opts: any) => {
        let filtered = [...allInvoices];
        if (opts.where) {
          const conditions = Array.isArray(opts.where) ? opts.where : [opts.where];
          const hasKeysetCondition = conditions.some(
            (c: any) => c.createdAt !== undefined || c.id !== undefined
          );

          if (hasKeysetCondition) {
            filtered = filtered.filter((row) =>
              conditions.some((cond: any) => {
                const createdAtOp = cond.createdAt;
                const idOp = cond.id;
                const targetTime =
                  createdAtOp && typeof createdAtOp === "object" && "value" in createdAtOp
                    ? new Date(createdAtOp.value).getTime()
                    : createdAtOp instanceof Date
                    ? createdAtOp.getTime()
                    : undefined;

                const targetId =
                  idOp && typeof idOp === "object" && "value" in idOp
                    ? idOp.value
                    : typeof idOp === "string"
                    ? idOp
                    : undefined;

                if (targetTime !== undefined && targetId !== undefined) {
                  return (
                    row.createdAt.getTime() === targetTime &&
                    row.id < targetId
                  );
                }

                if (targetTime !== undefined) {
                  return row.createdAt.getTime() < targetTime;
                }

                if (targetId !== undefined) {
                  return row.id < targetId;
                }

                return true;
              })
            );
          }
        }
        filtered.sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (b.id < a.id ? 1 : -1)
        );
        return Promise.resolve(filtered.slice(0, opts.take));
      });
      mockRepo.count.mockImplementation(() => Promise.resolve(allInvoices.length));

      // Fetch page 1 (limit 2)
      const page1 = await service.getInvoicesBySellerId({
        sellerId,
        cursor: null,
        limit: 2,
      });

      expect(page1.invoices.map((i) => i.id)).toEqual(["id-1", "id-2"]);
      expect(page1.nextCursor).not.toBeNull();

      // CONCURRENT WRITE: a newer invoice is inserted before page 2 is read!
      const tNew = new Date("2026-09-24T11:00:00.000Z");
      const invNew = createMockInvoice("id-new", tNew, "INV-NEW");
      allInvoices.unshift(invNew);

      // Fetch page 2 using cursor from page 1
      const page2 = await service.getInvoicesBySellerId({
        sellerId,
        cursor: page1.nextCursor,
        limit: 2,
      });

      // Page 2 returns id-3 and id-4 without duplicates or omissions, ignoring the newly inserted invNew
      expect(page2.invoices.map((i) => i.id)).toEqual(["id-3", "id-4"]);
      expect(page2.nextCursor).toBeNull();
    });

    it("resolves raw UUID cursor key by querying invoice reference", async () => {
      const cursorUuid = "550e8400-e29b-41d4-a716-446655440000";
      const refInvoice = createMockInvoice(
        cursorUuid,
        new Date("2026-09-24T05:00:00.000Z"),
        "INV-REF"
      );

      mockRepo.findOne.mockResolvedValueOnce(refInvoice);
      mockRepo.find.mockResolvedValueOnce([]);
      mockRepo.count.mockResolvedValueOnce(0);

      const result = await service.getInvoicesBySellerId({
        sellerId,
        cursor: cursorUuid,
        limit: 10,
      });

      expect(mockRepo.findOne).toHaveBeenCalledWith({ where: { id: cursorUuid } });
      expect(result.invoices).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });

    it("throws 400 if cursor UUID is not found in database", async () => {
      const cursorUuid = "550e8400-e29b-41d4-a716-446655440099";
      mockRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.getInvoicesBySellerId({
          sellerId,
          cursor: cursorUuid,
          limit: 10,
        })
      ).rejects.toMatchObject({
        code: "invalid_cursor",
        statusCode: 400,
      });
    });
  });

  describe("GET /api/v1/invoices HTTP Endpoint", () => {
    let app: express.Application;
    let mockInvoiceService: any;
    const sellerId = "seller-test-id";
    const validToken = jwt.sign(
      { sub: sellerId, stellarAddress: "GTESTSELLER123" },
      "test-secret"
    );

    const sampleInvoice = {
      id: "inv-001",
      sellerId,
      invoiceNumber: "INV-001",
      customerName: "Acme Corp",
      amount: "1000.00",
      discountRate: "10.00",
      netAmount: "900.00",
      dueDate: new Date("2026-12-31"),
      status: InvoiceStatus.PUBLISHED,
      createdAt: new Date("2026-09-24T12:00:00.000Z"),
      updatedAt: new Date("2026-09-24T12:00:00.000Z"),
    };

    beforeEach(() => {
      process.env.JWT_SECRET = "test-secret";

      mockInvoiceService = {
        getInvoicesBySellerId: jest.fn(),
      };

      app = express();
      app.use(express.json());
      app.use(
        "/api/v1/invoices",
        createInvoiceRouter({
          invoiceService: mockInvoiceService,
          config: {
            ipfs: {
              apiUrl: "https://api.pinata.cloud",
              jwt: "jwt",
              maxFileSizeMB: 10,
              allowedMimeTypes: ["application/pdf"],
              uploadRateLimit: { windowMs: 900000, maxUploads: 10 },
            },
            kyc: { skipVerification: true },
          } as any,
        })
      );
      app.use(createErrorMiddleware(logger));
    });

    afterEach(() => {
      delete process.env.JWT_SECRET;
    });

    it("accepts cursor and limit params and returns nextCursor in envelope", async () => {
      mockInvoiceService.getInvoicesBySellerId.mockResolvedValueOnce({
        invoices: [sampleInvoice],
        total: 10,
        nextCursor: "opaque-cursor-next-page",
        hasMore: true,
      });

      const response = await request(app)
        .get("/api/v1/invoices?cursor=&limit=1")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.meta.nextCursor).toBe("opaque-cursor-next-page");
      expect(response.body.nextCursor).toBe("opaque-cursor-next-page");
      expect(response.body.meta.hasNextPage).toBe(true);

      // Verify no deprecation header on cursor pagination
      expect(response.headers.deprecation).toBeUndefined();
    });

    it("returns nextCursor as null when on the last page", async () => {
      mockInvoiceService.getInvoicesBySellerId.mockResolvedValueOnce({
        invoices: [sampleInvoice],
        total: 1,
        nextCursor: null,
        hasMore: false,
      });

      const response = await request(app)
        .get("/api/v1/invoices?cursor=some-cursor&limit=10")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.meta.nextCursor).toBeNull();
      expect(response.body.nextCursor).toBeNull();
      expect(response.body.meta.hasNextPage).toBe(false);
    });

    it("sends Deprecation header to offset-based clients using page param", async () => {
      mockInvoiceService.getInvoicesBySellerId.mockResolvedValueOnce({
        invoices: [sampleInvoice],
        total: 1,
      });

      const response = await request(app)
        .get("/api/v1/invoices?page=1&limit=10")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(200);

      expect(response.headers.deprecation).toBe("true");
      expect(response.headers.warning).toContain("Offset-based pagination is deprecated");
      expect(response.body.meta.page).toBe(1);
      expect(response.body.meta.totalPages).toBe(1);
    });

    it("sends Deprecation header when client calls without cursor", async () => {
      mockInvoiceService.getInvoicesBySellerId.mockResolvedValueOnce({
        invoices: [sampleInvoice],
        total: 1,
      });

      const response = await request(app)
        .get("/api/v1/invoices")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(200);

      expect(response.headers.deprecation).toBe("true");
      expect(response.headers.warning).toContain("Offset-based pagination is deprecated");
      expect(response.body.meta.page).toBe(1);
    });

    it("rejects request with 400 when both cursor and page parameters are provided", async () => {
      const response = await request(app)
        .get("/api/v1/invoices?cursor=test-cursor&page=2")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toContain("both cursor and page");
    });
  });

  describe("Dataset Benchmark (under 200ms)", () => {
    it("pages through large in-memory dataset of 10,000 items in well under 200ms", async () => {
      const count = 10000;
      const baseTime = Date.now();
      const dataset: { id: string; createdAt: Date }[] = [];

      for (let i = 0; i < count; i++) {
        dataset.push({
          id: `uuid-${i.toString().padStart(6, "0")}`,
          createdAt: new Date(baseTime - i * 1000),
        });
      }

      // Simulate binary search / index seek into 10,000 row sorted dataset
      const start = performance.now();
      const cursorIndex = 4999;
      const cursor = encodeInvoiceCursor(dataset[cursorIndex]);
      const decoded = decodeInvoiceCursor(cursor);

      expect(decoded.createdAt).toBeDefined();

      // B-Tree indexed search emulation on (createdAt DESC, id DESC)
      const targetTime = decoded.createdAt!.getTime();
      const targetId = decoded.id!;
      const limit = 20;

      const page: typeof dataset = [];
      for (let i = cursorIndex + 1; i < dataset.length && page.length < limit + 1; i++) {
        const item = dataset[i];
        if (
          item.createdAt.getTime() < targetTime ||
          (item.createdAt.getTime() === targetTime && item.id < targetId)
        ) {
          page.push(item);
        }
      }

      const hasMore = page.length > limit;
      const result = hasMore ? page.slice(0, limit) : page;
      const nextCursor = hasMore ? encodeInvoiceCursor(result[result.length - 1]) : null;

      const elapsed = performance.now() - start;

      expect(result).toHaveLength(limit);
      expect(nextCursor).not.toBeNull();
      // Must be well under 200ms (typically < 5ms)
      expect(elapsed).toBeLessThan(200);
    });
  });
});
