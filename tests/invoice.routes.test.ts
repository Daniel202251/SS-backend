import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createInvoiceRouter } from "../src/routes/invoice.routes";
import { ServiceError } from "../src/utils/service-error";
import { createErrorMiddleware } from "../src/middleware/error.middleware";
import { logger } from "../src/observability/logger";
import { InvoiceStatus } from "../src/types/enums";

describe("Invoice Routes", () => {
  let app: express.Application;
  let mockInvoiceService: any;

  const mockConfig = {
    ipfs: {
      apiUrl: "https://api.pinata.cloud",
      jwt: "test-jwt-token",
      maxFileSizeMB: 10,
      allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
      uploadRateLimit: {
        windowMs: 900000,
        maxUploads: 10,
      },
    },
    kyc: {
      skipVerification: true, // Default to true for existing tests
    },
  };

  const sellerId = "seller-123";
  const validToken = jwt.sign({ sub: sellerId, stellarAddress: "GTEST123" }, "test-secret");

  const mockInvoice = {
    id: "invoice-123",
    sellerId,
    invoiceNumber: "INV-001",
    customerName: "Test Customer",
    amount: "1000.00",
    discountRate: "10.00",
    netAmount: "900.00",
    dueDate: "2024-12-31T00:00:00.000Z",
    status: InvoiceStatus.DRAFT,
    ipfsHash: null,
    riskScore: null,
    smartContractId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    mockInvoiceService = {
      createInvoice: jest.fn(),
      getInvoiceById: jest.fn(),
      getInvoicesBySellerId: jest.fn(),
      updateInvoice: jest.fn(),
      deleteInvoice: jest.fn(),
      publishInvoice: jest.fn(),
      uploadDocument: jest.fn(),
    };

    process.env.JWT_SECRET = "test-secret";

    app = express();
    app.use(express.json());
    app.use(
      "/api/v1/invoices",
      createInvoiceRouter({
        invoiceService: mockInvoiceService,
        config: mockConfig as any,
      })
    );
    app.use(createErrorMiddleware(logger));
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  // ============ CREATE INVOICE TESTS ============
  describe("POST /api/v1/invoices - Create Invoice", () => {
    it("should successfully create an invoice", async () => {
      mockInvoiceService.createInvoice.mockResolvedValue(mockInvoice);

      const response = await request(app)
        .post("/api/v1/invoices")
        .set("Authorization", `Bearer ${validToken}`)
        .send({
          invoiceNumber: "INV-001",
          customerName: "Test Customer",
          amount: "1000.00",
          discountRate: "10.00",
          dueDate: "2024-12-31",
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe("invoice-123");
      expect(response.body.data.invoiceNumber).toBe("INV-001");
      expect(response.body.data.status).toBe(InvoiceStatus.DRAFT);

      expect(mockInvoiceService.createInvoice).toHaveBeenCalledWith({
        sellerId,
        invoiceNumber: "INV-001",
        customerName: "Test Customer",
        amount: "1000.00",
        discountRate: "10.00",
        dueDate: expect.any(Date),
      });
    });

    it("should validate required fields", async () => {
      await request(app)
        .post("/api/v1/invoices")
        .set("Authorization", `Bearer ${validToken}`)
        .send({
          invoiceNumber: "INV-001",
          // missing customerName
          amount: "1000.00",
          discountRate: "10.00",
          dueDate: "2024-12-31",
        })
        .expect(400);
    });

    it("should validate decimal precision for amount", async () => {
      await request(app)
        .post("/api/v1/invoices")
        .set("Authorization", `Bearer ${validToken}`)
        .send({
          invoiceNumber: "INV-001",
          customerName: "Test Customer",
          amount: "1000.123456", // More than 4 decimal places
          discountRate: "10.00",
          dueDate: "2024-12-31",
        })
        .expect(400);
    });

    it("should validate discount rate max value", async () => {
      await request(app)
        .post("/api/v1/invoices")
        .set("Authorization", `Bearer ${validToken}`)
        .send({
          invoiceNumber: "INV-001",
          customerName: "Test Customer",
          amount: "1000.00",
          discountRate: "150.00", // Exceeds 100
          dueDate: "2024-12-31",
        })
        .expect(400);
    });

    it("should reject creation when KYC is required but not approved", async () => {
      // Create a new app instance with KYC enabled
      const kycConfig = {
        ...mockConfig,
        kyc: { skipVerification: false },
      };
      const kycApp = express();
      kycApp.use(express.json());
      kycApp.use(
        "/api/v1/invoices",
        createInvoiceRouter({
          invoiceService: mockInvoiceService,
          config: kycConfig as any,
        })
      );
      kycApp.use(createErrorMiddleware(logger));

      await request(kycApp)
        .post("/api/v1/invoices")
        .set("Authorization", `Bearer ${validToken}`)
        .send({
          invoiceNumber: "INV-001",
          customerName: "Test Customer",
          amount: "1000.00",
          discountRate: "10.00",
          dueDate: "2024-12-31",
        })
        .expect(403);
    });

    it("should reject unauthenticated requests", async () => {
      await request(app)
        .post("/api/v1/invoices")
        .send({
          invoiceNumber: "INV-001",
          customerName: "Test Customer",
          amount: "1000.00",
          discountRate: "10.00",
          dueDate: "2024-12-31",
        })
        .expect(401);
    });

    it("should handle duplicate invoice number", async () => {
      mockInvoiceService.createInvoice.mockRejectedValue(
        new ServiceError("invoice_number_exists", "Invoice number must be unique", 409)
      );

      await request(app)
        .post("/api/v1/invoices")
        .set("Authorization", `Bearer ${validToken}`)
        .send({
          invoiceNumber: "INV-001",
          customerName: "Test Customer",
          amount: "1000.00",
          discountRate: "10.00",
          dueDate: "2024-12-31",
        })
        .expect(409);
    });
  });

  // ============ GET INVOICES TESTS ============
  describe("GET /api/v1/invoices - List Invoices", () => {
    it("should list invoices for authenticated seller", async () => {
      mockInvoiceService.getInvoicesBySellerId.mockResolvedValue({
        invoices: [mockInvoice],
        total: 1,
      });

      const response = await request(app)
        .get("/api/v1/invoices")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: [mockInvoice],
        meta: {
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
        },
      });
    });

    it("should support pagination", async () => {
      mockInvoiceService.getInvoicesBySellerId.mockResolvedValue({
        invoices: [mockInvoice],
        total: 50,
      });

      const response = await request(app)
        .get("/api/v1/invoices?page=2&limit=10")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(200);

      expect(response.body.meta).toEqual({
        total: 50,
        page: 2,
        limit: 10,
        totalPages: 5,
      });

      expect(mockInvoiceService.getInvoicesBySellerId).toHaveBeenCalledWith({
        sellerId,
        skip: 10,
        take: 10,
      });
    });

    it("should support status filtering", async () => {
      mockInvoiceService.getInvoicesBySellerId.mockResolvedValue({
        invoices: [mockInvoice],
        total: 1,
      });

      await request(app)
        .get(`/api/v1/invoices?status=${InvoiceStatus.DRAFT}`)
        .set("Authorization", `Bearer ${validToken}`)
        .expect(200);

      expect(mockInvoiceService.getInvoicesBySellerId).toHaveBeenCalledWith({
        sellerId,
        status: InvoiceStatus.DRAFT,
        skip: 0,
        take: 20,
      });
    });

    it("should reject unauthenticated requests", async () => {
      await request(app).get("/api/v1/invoices").expect(401);
    });

    it("should validate pagination parameters", async () => {
      await request(app)
        .get("/api/v1/invoices?page=0&limit=20")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(422);
    });
  });

  // ============ GET SINGLE INVOICE TESTS ============
  describe("GET /api/v1/invoices/:id - Get Single Invoice", () => {
    it("should get invoice by id", async () => {
      mockInvoiceService.getInvoiceById.mockResolvedValue(mockInvoice);

      const response = await request(app)
        .get("/api/v1/invoices/invoice-123")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: mockInvoice,
      });

      expect(mockInvoiceService.getInvoiceById).toHaveBeenCalledWith("invoice-123", sellerId);
    });

    it("should return 404 when invoice not found", async () => {
      mockInvoiceService.getInvoiceById.mockResolvedValue(null);

      await request(app)
        .get("/api/v1/invoices/nonexistent")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(404);
    });

    it("should return 404 for unauthorized access (prevent info leakage)", async () => {
      mockInvoiceService.getInvoiceById.mockRejectedValue(
        new ServiceError(
          "unauthorized_invoice_access",
          "You do not have access to this invoice",
          403
        )
      );

      await request(app)
        .get("/api/v1/invoices/invoice-456")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(404);
    });

    it("should reject unauthenticated requests", async () => {
      await request(app).get("/api/v1/invoices/invoice-123").expect(401);
    });
  });

  // ============ UPDATE INVOICE TESTS ============
  describe("PUT /api/v1/invoices/:id - Update Invoice", () => {
    it("should update draft invoice", async () => {
      const updatedInvoice = { ...mockInvoice, customerName: "Updated Name" };
      mockInvoiceService.updateInvoice.mockResolvedValue(updatedInvoice);

      const response = await request(app)
        .put("/api/v1/invoices/invoice-123")
        .set("Authorization", `Bearer ${validToken}`)
        .send({
          customerName: "Updated Name",
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: updatedInvoice,
      });

      expect(mockInvoiceService.updateInvoice).toHaveBeenCalledWith({
        sellerId,
        invoiceId: "invoice-123",
        customerName: "Updated Name",
      });
    });

    it("should update multiple fields", async () => {
      const updatedInvoice = {
        ...mockInvoice,
        amount: "2000.00",
        netAmount: "1800.00",
        discountRate: "10.00",
      };
      mockInvoiceService.updateInvoice.mockResolvedValue(updatedInvoice);

      await request(app)
        .put("/api/v1/invoices/invoice-123")
        .set("Authorization", `Bearer ${validToken}`)
        .send({
          amount: "2000.00",
          discountRate: "10.00",
        })
        .expect(200);
    });

    it("should reject update of non-draft invoice", async () => {
      mockInvoiceService.updateInvoice.mockRejectedValue(
        new ServiceError(
          "invalid_invoice_status",
          "Cannot update invoice in published status. Only draft invoices can be updated.",
          400
        )
      );

      await request(app)
        .put("/api/v1/invoices/invoice-123")
        .set("Authorization", `Bearer ${validToken}`)
        .send({
          customerName: "Updated Name",
        })
        .expect(400);
    });

    it("should return 404 for unauthorized access", async () => {
      mockInvoiceService.updateInvoice.mockRejectedValue(
        new ServiceError(
          "unauthorized_invoice_access",
          "You can only update your own invoices",
          403
        )
      );

      await request(app)
        .put("/api/v1/invoices/invoice-456")
        .set("Authorization", `Bearer ${validToken}`)
        .send({ customerName: "Test" })
        .expect(404);
    });

    it("should reject invalid decimal precision", async () => {
      await request(app)
        .put("/api/v1/invoices/invoice-123")
        .set("Authorization", `Bearer ${validToken}`)
        .send({
          amount: "1000.12345", // More than 4 decimals
        })
        .expect(400);
    });
  });

  // ============ DELETE INVOICE TESTS ============
  describe("DELETE /api/v1/invoices/:id - Delete Invoice", () => {
    it("should delete draft invoice", async () => {
      mockInvoiceService.deleteInvoice.mockResolvedValue(undefined);

      await request(app)
        .delete("/api/v1/invoices/invoice-123")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(204);

      expect(mockInvoiceService.deleteInvoice).toHaveBeenCalledWith("invoice-123", sellerId);
    });

    it("should reject deletion of published invoice", async () => {
      mockInvoiceService.deleteInvoice.mockRejectedValue(
        new ServiceError("invalid_invoice_status", "Cannot delete invoice in published status", 400)
      );

      await request(app)
        .delete("/api/v1/invoices/invoice-123")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(400);
    });

    it("should return 404 for unauthorized access", async () => {
      mockInvoiceService.deleteInvoice.mockRejectedValue(
        new ServiceError(
          "unauthorized_invoice_access",
          "You can only delete your own invoices",
          403
        )
      );

      await request(app)
        .delete("/api/v1/invoices/invoice-456")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(404);
    });

    it("should reject unauthenticated requests", async () => {
      await request(app).delete("/api/v1/invoices/invoice-123").expect(401);
    });
  });

  // ============ PUBLISH INVOICE TESTS ============
  describe("POST /api/v1/invoices/:id/publish - Publish Invoice", () => {
    it("should publish draft invoice", async () => {
      const publishedInvoice = {
        ...mockInvoice,
        status: InvoiceStatus.PUBLISHED,
      };
      mockInvoiceService.publishInvoice.mockResolvedValue(publishedInvoice);

      const response = await request(app)
        .post("/api/v1/invoices/invoice-123/publish")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: publishedInvoice,
      });

      expect(mockInvoiceService.publishInvoice).toHaveBeenCalledWith({
        invoiceId: "invoice-123",
        sellerId,
      });
    });

    it("should reject invalid status transition", async () => {
      mockInvoiceService.publishInvoice.mockRejectedValue(
        new ServiceError(
          "invalid_status_transition",
          "Cannot transition from settled to published",
          400
        )
      );

      await request(app)
        .post("/api/v1/invoices/invoice-123/publish")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(400);
    });

    it("should return 404 for unauthorized access", async () => {
      mockInvoiceService.publishInvoice.mockRejectedValue(
        new ServiceError(
          "unauthorized_invoice_access",
          "You can only publish your own invoices",
          403
        )
      );

      await request(app)
        .post("/api/v1/invoices/invoice-456/publish")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(404);
    });

    it("should reject unauthenticated requests", async () => {
      await request(app).post("/api/v1/invoices/invoice-123/publish").expect(401);
    });
  });

  // ============ UPLOAD DOCUMENT TESTS ============
  describe("POST /api/v1/invoices/:id/document - Upload Document", () => {
    it("should successfully upload a document", async () => {
      mockInvoiceService.uploadDocument.mockResolvedValue({
        invoiceId: "invoice-123",
        ipfsHash: "QmTestHash123",
        fileSize: 1024,
        uploadedAt: "2024-01-01T00:00:00.000Z",
      });

      const response = await request(app)
        .post("/api/v1/invoices/invoice-123/document")
        .set("Authorization", `Bearer ${validToken}`)
        .attach("document", Buffer.from("test pdf content"), "test.pdf")
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          invoiceId: "invoice-123",
          ipfsHash: "QmTestHash123",
          fileSize: 1024,
          uploadedAt: "2024-01-01T00:00:00.000Z",
        },
      });

      expect(mockInvoiceService.uploadDocument).toHaveBeenCalledWith({
        invoiceId: "invoice-123",
        sellerId,
        fileBuffer: expect.any(Buffer),
        filename: "test.pdf",
        mimeType: "application/pdf",
      });
    });

    it("should reject requests without authentication", async () => {
      await request(app)
        .post("/api/v1/invoices/invoice-123/document")
        .attach("document", Buffer.from("test content"), "test.pdf")
        .expect(401);
    });

    it("should reject requests without a file", async () => {
      await request(app)
        .post("/api/v1/invoices/invoice-123/document")
        .set("Authorization", `Bearer ${validToken}`)
        .expect(400);
    });

    it("should handle service errors", async () => {
      mockInvoiceService.uploadDocument.mockRejectedValue(
        new ServiceError("invoice_not_found", "Invoice not found", 404)
      );

      await request(app)
        .post("/api/v1/invoices/invoice-123/document")
        .set("Authorization", `Bearer ${validToken}`)
        .attach("document", Buffer.from("test content"), "test.pdf")
        .expect(404);
    });

    it("should handle unauthorized access to invoice", async () => {
      mockInvoiceService.uploadDocument.mockRejectedValue(
        new ServiceError(
          "unauthorized_invoice_access",
          "You can only upload documents to your own invoices",
          403
        )
      );

      await request(app)
        .post("/api/v1/invoices/invoice-123/document")
        .set("Authorization", `Bearer ${validToken}`)
        .attach("document", Buffer.from("test content"), "test.pdf")
        .expect(403);
    });

    it("should handle invalid JWT tokens", async () => {
      await request(app)
        .post("/api/v1/invoices/invoice-123/document")
        .set("Authorization", "Bearer invalid-token")
        .attach("document", Buffer.from("test content"), "test.pdf")
        .expect(401);
    });
  });
});
