import express from "express";
import request from "supertest";
import {
  InvoiceCacheService,
  createInvoiceCacheService,
} from "../../src/services/invoice-cache.service";
import { createInvoiceController } from "../../src/controllers/invoice.controller";
import type { InvoiceService } from "../../src/services/invoice.service";
import { InvoiceStatus } from "../../src/types/enums";

describe("Redis Caching Layer for Invoice Data (#461)", () => {
  describe("InvoiceCacheService unit tests", () => {
    it("respects default and custom TTLs", () => {
      const defaultCache = createInvoiceCacheService();
      expect(defaultCache.getListTtl()).toBe(30);
      expect(defaultCache.getDetailTtl()).toBe(60);

      const customCache = createInvoiceCacheService({
        listTtlSeconds: 15,
        detailTtlSeconds: 45,
      });
      expect(customCache.getListTtl()).toBe(15);
      expect(customCache.getDetailTtl()).toBe(45);
    });

    it("caches and retrieves invoice listing data", async () => {
      const cache = createInvoiceCacheService();
      const sellerId = "seller-123";
      const payload = { invoices: [{ id: "inv-1" }], total: 1 };

      expect(await cache.getInvoicesList(sellerId, 1, 20)).toBeNull();

      await cache.setInvoicesList(sellerId, 1, 20, undefined, payload);
      const cached = await cache.getInvoicesList(sellerId, 1, 20);
      expect(cached).not.toBeNull();
      expect(JSON.parse(cached!)).toEqual(payload);
    });

    it("caches and retrieves invoice detail data", async () => {
      const cache = createInvoiceCacheService();
      const sellerId = "seller-123";
      const invoiceId = "inv-456";
      const detailPayload = { id: invoiceId, amount: "1000.00" };

      expect(await cache.getInvoiceDetail(sellerId, invoiceId)).toBeNull();

      await cache.setInvoiceDetail(sellerId, invoiceId, detailPayload);
      const cached = await cache.getInvoiceDetail(sellerId, invoiceId);
      expect(cached).not.toBeNull();
      expect(JSON.parse(cached!)).toEqual(detailPayload);
    });

    it("invalidates invoice detail and listing keys on mutation", async () => {
      const cache = createInvoiceCacheService();
      const sellerId = "seller-123";
      const invoiceId = "inv-456";

      await cache.setInvoicesList(sellerId, 1, 20, undefined, { list: true });
      await cache.setInvoiceDetail(sellerId, invoiceId, { detail: true });

      expect(await cache.getInvoicesList(sellerId, 1, 20)).not.toBeNull();
      expect(await cache.getInvoiceDetail(sellerId, invoiceId)).not.toBeNull();

      await cache.invalidateInvoice(invoiceId, sellerId);

      expect(await cache.getInvoicesList(sellerId, 1, 20)).toBeNull();
      expect(await cache.getInvoiceDetail(sellerId, invoiceId)).toBeNull();
    });

    it("invalidates all seller caches on seller mutation", async () => {
      const cache = createInvoiceCacheService();
      const sellerId = "seller-123";
      const otherSeller = "seller-999";

      await cache.setInvoicesList(sellerId, 1, 20, undefined, { list: 1 });
      await cache.setInvoicesList(otherSeller, 1, 20, undefined, { list: 2 });

      await cache.invalidateSellerInvoices(sellerId);

      expect(await cache.getInvoicesList(sellerId, 1, 20)).toBeNull();
      expect(await cache.getInvoicesList(otherSeller, 1, 20)).not.toBeNull();
    });
  });

  describe("HTTP Caching and X-Cache Headers", () => {
    let mockInvoiceService: InvoiceService;
    let cacheService: InvoiceCacheService;
    let app: express.Express;

    const mockSeller = { id: "seller-test-id", stellarAddress: "GSELLER" };
    const mockInvoice = {
      id: "inv-test-id",
      sellerId: mockSeller.id,
      invoiceNumber: "INV-001",
      customerName: "Acme",
      amount: "5000",
      status: InvoiceStatus.DRAFT,
    };

    beforeEach(() => {
      cacheService = createInvoiceCacheService({ listTtlSeconds: 30, detailTtlSeconds: 60 });

      mockInvoiceService = {
        createInvoice: jest.fn(async (input) => ({ id: "new-inv", ...input })),
        getInvoicesBySellerId: jest.fn(async () => ({ invoices: [mockInvoice], total: 1 })),
        getInvoiceById: jest.fn(async (id) => (id === mockInvoice.id ? mockInvoice : null)),
        updateInvoice: jest.fn(async (input) => ({ ...mockInvoice, ...input })),
        deleteInvoice: jest.fn(async () => {}),
        publishInvoice: jest.fn(async () => ({ ...mockInvoice, status: InvoiceStatus.PUBLISHED })),
        submitInvoiceForReview: jest.fn(async () => ({
          ...mockInvoice,
          status: InvoiceStatus.PENDING,
        })),
        publishInvoicesBatch: jest.fn(async () => ({ successful: [mockInvoice.id], failed: [] })),
        uploadDocument: jest.fn(async () => ({ id: mockInvoice.id })),
      } as unknown as InvoiceService;

      const controller = createInvoiceController(mockInvoiceService, cacheService);

      app = express();
      app.use(express.json());
      // Mock auth middleware setting req.user
      app.use((req, _res, next) => {
        (req as any).user = mockSeller;
        next();
      });

      app.get("/invoices", controller.getInvoices);
      app.get("/invoices/:id", controller.getInvoice);
      app.post("/invoices", controller.createInvoice);
      app.put("/invoices/:id", controller.updateInvoice);
      app.delete("/invoices/:id", controller.deleteInvoice);
      app.post("/invoices/:id/publish", controller.publishInvoice);
    });

    it("returns X-Cache: MISS on first GET /invoices and X-Cache: HIT on second", async () => {
      const firstRes = await request(app).get("/invoices?page=1&limit=20");
      expect(firstRes.status).toBe(200);
      expect(firstRes.headers["x-cache"]).toBe("MISS");
      expect(mockInvoiceService.getInvoicesBySellerId).toHaveBeenCalledTimes(1);

      const secondRes = await request(app).get("/invoices?page=1&limit=20");
      expect(secondRes.status).toBe(200);
      expect(secondRes.headers["x-cache"]).toBe("HIT");
      expect(mockInvoiceService.getInvoicesBySellerId).toHaveBeenCalledTimes(1); // not called again
      expect(secondRes.body.data).toEqual([mockInvoice]);
    });

    it("returns X-Cache: MISS on first GET /invoices/:id and X-Cache: HIT on second", async () => {
      const firstRes = await request(app).get(`/invoices/${mockInvoice.id}`);
      expect(firstRes.status).toBe(200);
      expect(firstRes.headers["x-cache"]).toBe("MISS");
      expect(mockInvoiceService.getInvoiceById).toHaveBeenCalledTimes(1);

      const secondRes = await request(app).get(`/invoices/${mockInvoice.id}`);
      expect(secondRes.status).toBe(200);
      expect(secondRes.headers["x-cache"]).toBe("HIT");
      expect(mockInvoiceService.getInvoiceById).toHaveBeenCalledTimes(1);
      expect(secondRes.body.data).toEqual(mockInvoice);
    });

    it("invalidates cache on invoice creation", async () => {
      // Warm list cache
      await request(app).get("/invoices");

      // Create new invoice
      const createRes = await request(app).post("/invoices").send({
        invoiceNumber: "INV-002",
        customerName: "Buyer",
        amount: "1000",
        discountRate: "5",
        dueDate: new Date().toISOString(),
      });
      expect(createRes.status).toBe(201);

      // Next list request should be MISS
      const nextRes = await request(app).get("/invoices");
      expect(nextRes.headers["x-cache"]).toBe("MISS");
    });

    it("invalidates cache on invoice update", async () => {
      // Warm caches
      await request(app).get(`/invoices/${mockInvoice.id}`);
      await request(app).get("/invoices");

      // Update invoice
      await request(app).put(`/invoices/${mockInvoice.id}`).send({ customerName: "Updated Acme" });

      // Detail should be MISS
      const detailRes = await request(app).get(`/invoices/${mockInvoice.id}`);
      expect(detailRes.headers["x-cache"]).toBe("MISS");

      // List should be MISS
      const listRes = await request(app).get("/invoices");
      expect(listRes.headers["x-cache"]).toBe("MISS");
    });

    it("invalidates cache on invoice publish", async () => {
      // Warm cache
      await request(app).get(`/invoices/${mockInvoice.id}`);

      // Publish
      await request(app).post(`/invoices/${mockInvoice.id}/publish`);

      // Subsequent GET should be MISS
      const res = await request(app).get(`/invoices/${mockInvoice.id}`);
      expect(res.headers["x-cache"]).toBe("MISS");
    });

    it("falls back to database without error when cache fails", async () => {
      const failingCache = {
        getInvoicesList: jest.fn(async () => {
          throw new Error("Redis ECONNREFUSED");
        }),
        setInvoicesList: jest.fn(async () => {
          throw new Error("Redis connection closed");
        }),
        invalidateSellerInvoices: jest.fn(async () => {}),
      } as unknown as InvoiceCacheService;

      const failingController = createInvoiceController(mockInvoiceService, failingCache);
      const testApp = express();
      testApp.use((req, _res, next) => {
        (req as any).user = mockSeller;
        next();
      });
      testApp.get("/invoices", failingController.getInvoices);

      const res = await request(testApp).get("/invoices");
      expect(res.status).toBe(200);
      expect(res.headers["x-cache"]).toBe("MISS");
      expect(res.body.data).toEqual([mockInvoice]);
    });
  });
});
