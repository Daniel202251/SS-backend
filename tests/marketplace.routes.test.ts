import request from "supertest";
import express from "express";
import { createMarketplaceRouter } from "../src/routes/marketplace.routes";
import { createErrorMiddleware } from "../src/middleware/error.middleware";
import { logger } from "../src/observability/logger";
import { InvoiceStatus } from "../src/types/enums";

describe("Marketplace Routes", () => {
  let app: express.Application;
  let mockMarketplaceService: any;

  beforeEach(() => {
    mockMarketplaceService = {
      getPublishedInvoices: jest.fn(),
    };

    app = express();
    app.use(express.json());
    app.use(
      "/api/v1/marketplace",
      createMarketplaceRouter({
        marketplaceService: mockMarketplaceService,
      })
    );
    app.use(createErrorMiddleware(logger));
  });

  describe("GET /api/v1/marketplace/invoices", () => {
    const mockResponse = {
      data: [
        {
          id: "invoice-1",
          invoiceNumber: "INV-001",
          customerName: "Customer A",
          amount: "1000.00",
          discountRate: "5.00",
          netAmount: "950.00",
          dueDate: "2024-12-31T00:00:00.000Z",
          status: InvoiceStatus.PUBLISHED,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      meta: {
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      },
    };

    it("should return published invoices with default parameters", async () => {
      mockMarketplaceService.getPublishedInvoices.mockResolvedValue(mockResponse);

      const response = await request(app).get("/api/v1/marketplace/invoices").expect(200);

      expect(response.body).toEqual({
        success: true,
        data: mockResponse.data,
        meta: mockResponse.meta,
      });

      expect(mockMarketplaceService.getPublishedInvoices).toHaveBeenCalledWith(
        {
          status: undefined,
          dueBefore: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          sort: "amount",
          sortOrder: "DESC",
        },
        { page: 1, limit: 20 }
      );
    });

    it("should handle pagination parameters", async () => {
      mockMarketplaceService.getPublishedInvoices.mockResolvedValue(mockResponse);

      await request(app)
        .get("/api/v1/marketplace/invoices")
        .query({ page: 2, limit: 10 })
        .expect(200);

      expect(mockMarketplaceService.getPublishedInvoices).toHaveBeenCalledWith(expect.any(Object), {
        page: 2,
        limit: 10,
      });
    });

    it("should handle status filter as single value", async () => {
      mockMarketplaceService.getPublishedInvoices.mockResolvedValue(mockResponse);

      await request(app)
        .get("/api/v1/marketplace/invoices")
        .query({ status: "published" })
        .expect(200);

      expect(mockMarketplaceService.getPublishedInvoices).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ["published"],
        }),
        expect.any(Object)
      );
    });

    it("should handle status filter as array", async () => {
      mockMarketplaceService.getPublishedInvoices.mockResolvedValue(mockResponse);

      await request(app)
        .get("/api/v1/marketplace/invoices")
        .query({ status: ["published", "funded"] })
        .expect(200);

      expect(mockMarketplaceService.getPublishedInvoices).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ["published", "funded"],
        }),
        expect.any(Object)
      );
    });

    it("should handle amount filters", async () => {
      mockMarketplaceService.getPublishedInvoices.mockResolvedValue(mockResponse);

      await request(app)
        .get("/api/v1/marketplace/invoices")
        .query({ minAmount: 500, maxAmount: 2000 })
        .expect(200);

      expect(mockMarketplaceService.getPublishedInvoices).toHaveBeenCalledWith(
        expect.objectContaining({
          minAmount: 500,
          maxAmount: 2000,
        }),
        expect.any(Object)
      );
    });

    it("should handle date filter", async () => {
      mockMarketplaceService.getPublishedInvoices.mockResolvedValue(mockResponse);

      await request(app)
        .get("/api/v1/marketplace/invoices")
        .query({ dueBefore: "2024-12-31T23:59:59.999Z" })
        .expect(200);

      expect(mockMarketplaceService.getPublishedInvoices).toHaveBeenCalledWith(
        expect.objectContaining({
          dueBefore: new Date("2024-12-31T23:59:59.999Z"),
        }),
        expect.any(Object)
      );
    });

    it("should handle sorting parameters", async () => {
      mockMarketplaceService.getPublishedInvoices.mockResolvedValue(mockResponse);

      await request(app)
        .get("/api/v1/marketplace/invoices")
        .query({ sort: "discount_rate", sortOrder: "DESC" })
        .expect(200);

      expect(mockMarketplaceService.getPublishedInvoices).toHaveBeenCalledWith(
        expect.objectContaining({
          sort: "discount_rate",
          sortOrder: "DESC",
        }),
        expect.any(Object)
      );
    });

    it("should validate query parameters", async () => {
      await request(app)
        .get("/api/v1/marketplace/invoices")
        .query({ page: -1, limit: 200, status: "invalid_status" })
        .expect(400);
    });

    it("should validate amount range", async () => {
      await request(app)
        .get("/api/v1/marketplace/invoices")
        .query({ minAmount: 2000, maxAmount: 1000 })
        .expect(400);
    });

    it("should validate date format", async () => {
      await request(app)
        .get("/api/v1/marketplace/invoices")
        .query({ dueBefore: "invalid-date" })
        .expect(400);
    });

    it("should validate sort parameters", async () => {
      await request(app)
        .get("/api/v1/marketplace/invoices")
        .query({ sort: "invalid_sort", sortOrder: "INVALID" })
        .expect(400);
    });

    it("should handle service errors", async () => {
      mockMarketplaceService.getPublishedInvoices.mockRejectedValue(
        new Error("Database connection failed")
      );

      await request(app).get("/api/v1/marketplace/invoices").expect(500);
    });

    it("should strip unknown query parameters", async () => {
      mockMarketplaceService.getPublishedInvoices.mockResolvedValue(mockResponse);

      await request(app)
        .get("/api/v1/marketplace/invoices")
        .query({
          page: 1,
          limit: 10,
          unknownParam: "should-be-stripped",
          anotherUnknown: 123,
        })
        .expect(200);

      // Should only receive known parameters
      expect(mockMarketplaceService.getPublishedInvoices).toHaveBeenCalledWith(
        {
          status: undefined,
          dueBefore: undefined,
          minAmount: undefined,
          maxAmount: undefined,
          search: undefined,
          sort: "amount",
          sortOrder: "DESC",
        },
        { page: 1, limit: 10 }
      );
    });

    it("should handle complex query combinations", async () => {
      mockMarketplaceService.getPublishedInvoices.mockResolvedValue(mockResponse);

      await request(app)
        .get("/api/v1/marketplace/invoices")
        .query({
          page: 2,
          limit: 5,
          status: ["published", "funded"],
          dueBefore: "2024-12-31T23:59:59.999Z",
          minAmount: 100,
          maxAmount: 5000,
          sort: "amount",
          sortOrder: "DESC",
        })
        .expect(200);

      expect(mockMarketplaceService.getPublishedInvoices).toHaveBeenCalledWith(
        {
          status: ["published", "funded"],
          dueBefore: new Date("2024-12-31T23:59:59.999Z"),
          minAmount: 100,
          maxAmount: 5000,
          sort: "amount",
          sortOrder: "DESC",
        },
        { page: 2, limit: 5 }
      );
    });
  });
});
