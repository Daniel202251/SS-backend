import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createInvoiceRouter } from "../src/routes/invoice.routes";
import { adminNotificationQueue } from "../src/services/admin-notification-queue.service";
import { createErrorMiddleware } from "../src/middleware/error.middleware";
import { logger } from "../src/observability/logger";
import { InvoiceStatus, UserType } from "../src/types/enums";

describe("POST /invoices - Invoice Submission for Admin Review (Issue #448)", () => {
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
      skipVerification: true,
    },
  };

  const sellerId = "seller-uuid-123";
  const sellerWallet = "GAXYZ1234567890STELLARSELLER";
  const sellerToken = jwt.sign(
    { sub: sellerId, stellarAddress: sellerWallet, userType: UserType.SELLER },
    "test-secret"
  );
  const investorToken = jwt.sign(
    { sub: "investor-123", stellarAddress: "GBINVESTOR123", userType: UserType.INVESTOR },
    "test-secret"
  );

  const futureDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const validPayload = {
    title: "Supplier Inventory Batch #4092",
    description: "Purchase order for electronics components",
    faceValue: 50000,
    fundingTarget: 47500,
    yieldBps: 500,
    fundingDeadline: futureDeadline,
    ipfsDocumentUrl: "ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
  };

  beforeEach(() => {
    adminNotificationQueue.clear();
    process.env.JWT_SECRET = "test-secret";

    mockInvoiceService = {
      createInvoice: jest.fn(),
      getInvoiceById: jest.fn(),
      getInvoicesBySellerId: jest.fn(),
      updateInvoice: jest.fn(),
      deleteInvoice: jest.fn(),
      publishInvoice: jest.fn(),
      uploadDocument: jest.fn(),
    };

    app = express();
    app.use(express.json());
    app.use(
      "/invoices",
      createInvoiceRouter({
        invoiceService: mockInvoiceService,
        config: mockConfig as any,
      })
    );
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

  it("should successfully submit invoice and store with status pending and seller wallet", async () => {
    const res = await request(app)
      .post("/invoices")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send(validPayload)
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.status).toBe(InvoiceStatus.PENDING);
    expect(res.body.data.sellerWallet).toBe(sellerWallet);
    expect(res.body.data.title).toBe(validPayload.title);
    expect(res.body.data.fundingTarget).toBe("47500");
    expect(res.body.data.faceValue).toBe("50000");

    // Check admin notification queue received event
    const events = adminNotificationQueue.getEvents("invoice_submitted");
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("invoice_submitted");
    expect(events[0].payload.sellerWallet).toBe(sellerWallet);
    expect(events[0].payload.title).toBe(validPayload.title);
    expect(events[0].payload.fundingTarget).toBe(47500);
  });

  it("should successfully submit invoice via /api/v1/invoices as well", async () => {
    const res = await request(app)
      .post("/api/v1/invoices")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send(validPayload)
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe(InvoiceStatus.PENDING);
    expect(res.body.data.sellerWallet).toBe(sellerWallet);

    const events = adminNotificationQueue.getEvents("invoice_submitted");
    expect(events.length).toBe(1);
  });

  it("should return 422 when required fields are missing", async () => {
    const res = await request(app)
      .post("/invoices")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({
        description: "Missing title, faceValue, etc.",
      })
      .expect(422);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.length).toBeGreaterThan(0);
    const fields = res.body.error.details.map((d: any) => d.field);
    expect(fields).toContain("title");
    expect(fields).toContain("faceValue");
    expect(fields).toContain("fundingTarget");
    expect(fields).toContain("yieldBps");
    expect(fields).toContain("fundingDeadline");
    expect(fields).toContain("ipfsDocumentUrl");
  });

  it("should return 422 when yieldBps is above 5000", async () => {
    const res = await request(app)
      .post("/invoices")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({
        ...validPayload,
        yieldBps: 5001,
      })
      .expect(422);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.details.some((d: any) => d.field === "yieldBps")).toBe(true);
  });

  it("should return 422 when yieldBps is 0 or negative", async () => {
    const res = await request(app)
      .post("/invoices")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({
        ...validPayload,
        yieldBps: 0,
      })
      .expect(422);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.details.some((d: any) => d.field === "yieldBps")).toBe(true);
  });

  it("should return 422 when fundingDeadline is in the past", async () => {
    const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
    const res = await request(app)
      .post("/invoices")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({
        ...validPayload,
        fundingDeadline: pastDate,
      })
      .expect(422);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.details.some((d: any) => d.field === "fundingDeadline")).toBe(true);
  });

  it("should return 422 when faceValue or fundingTarget is not positive", async () => {
    const res = await request(app)
      .post("/invoices")
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({
        ...validPayload,
        faceValue: -100,
        fundingTarget: 0,
      })
      .expect(422);

    expect(res.body.error).toBeDefined();
    const fields = res.body.error.details.map((d: any) => d.field);
    expect(fields).toContain("faceValue");
    expect(fields).toContain("fundingTarget");
  });

  it("should return 401 when request is unauthenticated", async () => {
    await request(app)
      .post("/invoices")
      .send(validPayload)
      .expect(401);
  });

  it("should return 403 when user is an investor", async () => {
    await request(app)
      .post("/invoices")
      .set("Authorization", `Bearer ${investorToken}`)
      .send(validPayload)
      .expect(403);
  });
});
