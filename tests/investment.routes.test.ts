import request from "supertest";
import express from "express";
import { createInvestmentRouter } from "../src/routes/investment.routes";
import { createErrorMiddleware } from "../src/middleware/error.middleware";
import { logger } from "../src/observability/logger";
import { KYCStatus } from "../src/types/enums";

describe("Investment Routes", () => {
  let app: express.Application;
  let mockInvestmentService: any;
  let mockAuthService: any;

  const mockUser = {
    id: "user-1",
    stellarAddress: "GUSER1",
    kycStatus: KYCStatus.APPROVED,
  };

  beforeEach(() => {
    mockInvestmentService = {
      createInvestment: jest.fn(),
    };

    mockAuthService = {
      getCurrentUser: jest.fn().mockResolvedValue(mockUser),
    };

    app = express();
    app.use(express.json());
    app.use(
      "/api/v1/investments",
      createInvestmentRouter({
        investmentService: mockInvestmentService,
        authService: mockAuthService,
      })
    );
    app.use(createErrorMiddleware(logger));
  });

  describe("POST /api/v1/investments", () => {
    const validPayload = {
      invoiceId: "invoice-1",
      investmentAmount: "500.0000",
    };

    it("should create an investment and return 201", async () => {
      const mockInvestment = {
        id: "investment-1",
        ...validPayload,
        investorId: mockUser.id,
        status: "pending",
      };

      mockInvestmentService.createInvestment.mockResolvedValue(mockInvestment);

      const response = await request(app)
        .post("/api/v1/investments")
        .set("Authorization", "Bearer mock-token")
        .send(validPayload)
        .expect(201);

      expect(response.body).toEqual({
        success: true,
        data: mockInvestment,
      });

      expect(mockInvestmentService.createInvestment).toHaveBeenCalledWith({
        invoiceId: "invoice-1",
        investorId: mockUser.id,
        investmentAmount: "500.0000",
        investorWallet: mockUser.stellarAddress,
      });
    });

    it("should return 400 if fields are missing", async () => {
      await request(app)
        .post("/api/v1/investments")
        .set("Authorization", "Bearer mock-token")
        .send({ invoiceId: "invoice-1" }) // Missing investmentAmount
        .expect(400);
    });

    it("should return 403 if KYC is not approved", async () => {
      mockAuthService.getCurrentUser.mockResolvedValue({
        ...mockUser,
        kycStatus: KYCStatus.PENDING,
      });

      const response = await request(app)
        .post("/api/v1/investments")
        .set("Authorization", "Bearer mock-token")
        .send(validPayload)
        .expect(403);

      expect(response.body.error.code).toBe("KYC_NOT_APPROVED");
    });
  });
});
