import "reflect-metadata";
import request from "supertest";
import { DataSource, getMetadataArgsStorage } from "typeorm";
import { createApp } from "../../src/app";
import { User } from "../../src/models/User.model";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { InvoiceStatus } from "../../src/types/enums";
import type { AppConfig } from "../../src/config/env";

function patchEntityMetadataForSQLite(): void {
  const columns = getMetadataArgsStorage().columns;
  for (const col of columns) {
    if (col.options.type === "timestamptz") {
      col.options.type = "datetime" as any;
    }
    if (col.options.type === "jsonb") {
      col.options.type = "text" as any;
    }
    if (col.options.type === "enum") {
      col.options.type = "varchar" as any;
    }
  }
}

import { createAuthService } from "../../src/services/auth.service";
import { createInvoiceService } from "../../src/services/invoice.service";
import { AuthChallenge } from "../../src/models/AuthChallenge.model";
import { Transaction } from "../../src/models/Transaction.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { Notification } from "../../src/models/Notification.model";

describe("Integration: Invoice Token Holders Authorization", () => {
  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;
  let config: AppConfig;
  let authService: ReturnType<typeof createAuthService>;

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-secret";
    patchEntityMetadataForSQLite();
    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [User, Invoice, Investment, AuthChallenge, Transaction, KYCVerification, Notification],
      synchronize: true,
      dropSchema: true,
    });
    await dataSource.initialize();

    config = {
      port: 3000,
      nodeEnv: "test",
      jwt: { secret: "test-secret", expiresIn: "1h" },
      auth: { challengeTtlMs: 5 * 60 * 1000 },
      observability: { metricsEnabled: false },
      http: {
        trustProxy: false,
        corsAllowedOrigins: [],
        corsAllowCredentials: false,
        bodySizeLimit: "1mb",
        shutdownTimeoutMs: 15000,
        rateLimit: { enabled: false, windowMs: 60000, max: 1000 },
      },
      reconciliation: { enabled: false, intervalMs: 30000, batchSize: 25, gracePeriodMs: 60000, maxRuntimeMs: 10000 },
      stellar: { network: "testnet", networkPassphrase: "Test SDF Network ; September 2015" },
      sorobanEscrow: { enabled: false, contractId: null, fundingMode: "wallet_xdr", settlementMode: "wallet_xdr" },
      admin: { apiKey: "test-admin-key" },
      ipfs: {
        pinataJwt: "test",
        pinataGateway: "test",
        timeoutMs: 5000,
        maxRetries: 3,
        baseRetryDelayMs: 100,
        maxFileSizeMB: 10,
        allowedMimeTypes: ["application/pdf", "image/png", "image/jpeg"],
        uploadRateLimit: { windowMs: 15 * 60 * 1000, maxUploads: 10 },
      },
      kyc: {
        skipVerification: true,
        webhookSecret: "",
      },
    } as unknown as AppConfig;

    authService = createAuthService(dataSource, config);
    const invoiceService = createInvoiceService(dataSource, {} as any);
    app = createApp({ authService, invoiceService, config });
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("should return 403 when seller B tries to access seller A's invoice token holders", async () => {
    const userRepo = dataSource.getRepository(User);
    const invoiceRepo = dataSource.getRepository(Invoice);

    const sellerA = await userRepo.save(userRepo.create({ stellarAddress: "GA-SELLER-A", isKycVerified: true }));
    const sellerB = await userRepo.save(userRepo.create({ stellarAddress: "GA-SELLER-B", isKycVerified: true }));

    const invoice = await invoiceRepo.save(
      invoiceRepo.create({
        sellerId: sellerA.id,
        invoiceNumber: "INV-TOKENS-001",
        customerName: "Test Customer",
        amount: "1000.0000",
        discountRate: "5.00",
        netAmount: "950.0000",
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status: InvoiceStatus.PUBLISHED,
        ipfsHash: "QmTestHash123",
      })
    );

    const tokenB = authService.generateToken({ id: sellerB.id, stellarAddress: sellerB.stellarAddress });

    const res = await request(app)
      .get(`/api/v1/invoices/${invoice.id}/tokens`)
      .set("Authorization", `Bearer ${tokenB}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("should return 200 when seller A accesses their own invoice token holders", async () => {
    const userRepo = dataSource.getRepository(User);
    const invoiceRepo = dataSource.getRepository(Invoice);

    const sellerA = await userRepo.save(userRepo.create({ stellarAddress: "GA-SELLER-A2", isKycVerified: true }));

    const invoice = await invoiceRepo.save(
      invoiceRepo.create({
        sellerId: sellerA.id,
        invoiceNumber: "INV-TOKENS-002",
        customerName: "Test Customer 2",
        amount: "2000.0000",
        discountRate: "5.00",
        netAmount: "1900.0000",
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status: InvoiceStatus.PUBLISHED,
        ipfsHash: "QmTestHash456",
      })
    );

    const tokenA = authService.generateToken({ id: sellerA.id, stellarAddress: sellerA.stellarAddress });

    const res = await request(app)
      .get(`/api/v1/invoices/${invoice.id}/tokens`)
      .set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  it("should return 401 when unauthenticated request accesses invoice token holders", async () => {
    const userRepo = dataSource.getRepository(User);
    const invoiceRepo = dataSource.getRepository(Invoice);

    const sellerA = await userRepo.save(userRepo.create({ stellarAddress: "GA-SELLER-A3", isKycVerified: true }));

    const invoice = await invoiceRepo.save(
      invoiceRepo.create({
        sellerId: sellerA.id,
        invoiceNumber: "INV-TOKENS-003",
        customerName: "Test Customer 3",
        amount: "3000.0000",
        discountRate: "5.00",
        netAmount: "2850.0000",
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status: InvoiceStatus.PUBLISHED,
        ipfsHash: "QmTestHash789",
      })
    );

    const res = await request(app).get(`/api/v1/invoices/${invoice.id}/tokens`);

    expect(res.status).toBe(401);
  });
});