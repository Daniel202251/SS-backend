import { createUserController, type UserRepositoryContract } from "@/controllers/user.controller";
import { UserType, KYCStatus } from "@/types/enums";
import { HttpError, AppError } from "@/utils/http-error";
import type { AuthenticatedRequest } from "@/types/auth";
import type { Response, NextFunction } from "express";
import type { AppLogger } from "@/observability/logger";

describe("UserController", () => {
  const mockUser = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    stellarAddress: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
    email: "user@example.com",
    userType: UserType.INVESTOR,
    kycStatus: KYCStatus.APPROVED,
    isKycVerified: true,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    invoices: [],
    investments: [],
    transactions: [],
    kycVerifications: [],
    notifications: [],
  };

  let mockRepo: jest.Mocked<UserRepositoryContract>;
  let mockLogger: AppLogger;
  let mockRes: Partial<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockRepo = {
      findById: jest.fn().mockResolvedValue(mockUser),
      findByStellarAddress: jest.fn().mockResolvedValue(mockUser),
      findByEmail: jest.fn().mockResolvedValue(null),
      findAll: jest.fn().mockResolvedValue([mockUser]),
      count: jest.fn().mockResolvedValue(1),
      save: jest.fn().mockImplementation(async (u) => ({ ...mockUser, ...u })),
    };

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
    };

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockNext = jest.fn();
  });

  describe("getProfile", () => {
    it("returns 401 when unauthenticated", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: undefined } as unknown as AuthenticatedRequest;

      await controller.getProfile(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(HttpError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 401 });
    });

    it("returns 404 when user is not found in database", async () => {
      mockRepo.findById.mockResolvedValue(null);
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: "non-existent-id", walletAddress: "GBZ..." } } as unknown as AuthenticatedRequest;

      await controller.getProfile(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(HttpError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 404 });
    });

    it("returns 200 with public user DTO when authenticated", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: mockUser.id, walletAddress: mockUser.stellarAddress } } as unknown as AuthenticatedRequest;

      await controller.getProfile(req, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: {
          id: mockUser.id,
          stellarAddress: mockUser.stellarAddress,
          email: mockUser.email,
          userType: mockUser.userType,
          kycStatus: mockUser.kycStatus,
          isKycVerified: true,
          createdAt: mockUser.createdAt,
          updatedAt: mockUser.updatedAt,
        },
      });
    });

    it("logs error and passes AppError 500 when repository throws unexpected error", async () => {
      mockRepo.findById.mockRejectedValue(new Error("DB connection timeout"));
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: mockUser.id, walletAddress: mockUser.stellarAddress } } as unknown as AuthenticatedRequest;

      await controller.getProfile(req, mockRes as Response, mockNext);

      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to fetch user profile",
        expect.objectContaining({ error: "DB connection timeout", userId: mockUser.id }),
      );
      expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 500 });
    });
  });

  describe("getUserById", () => {
    it("returns 401 when request is unauthenticated", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: undefined, params: { id: mockUser.id } } as unknown as AuthenticatedRequest & { params: { id: string } };

      await controller.getUserById(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(HttpError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 401 });
    });

    it("returns 400 when id param is empty or whitespace", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: "req-user" }, params: { id: "   " } } as unknown as AuthenticatedRequest & { params: { id: string } };

      await controller.getUserById(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(HttpError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    });

    it("returns 404 when target user is not found", async () => {
      mockRepo.findById.mockResolvedValue(null);
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: "req-user" }, params: { id: "some-id" } } as unknown as AuthenticatedRequest & { params: { id: string } };

      await controller.getUserById(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(HttpError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 404 });
    });

    it("returns 200 with public user data when target user exists", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: "req-user" }, params: { id: mockUser.id } } as unknown as AuthenticatedRequest & { params: { id: string } };

      await controller.getUserById(req, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.objectContaining({ id: mockUser.id }) }));
    });
  });

  describe("updateProfile", () => {
    it("returns 401 when request is unauthenticated", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: undefined, body: { email: "new@example.com" } } as unknown as AuthenticatedRequest;

      await controller.updateProfile(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(HttpError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 401 });
    });

    it("returns 400 when email format is invalid", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: mockUser.id }, body: { email: "invalid-email" } } as unknown as AuthenticatedRequest;

      await controller.updateProfile(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(HttpError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 400, message: "Invalid email format" });
    });

    it("returns 400 when Stellar public key format is invalid", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: mockUser.id }, body: { stellarAddress: "INVALID_KEY" } } as unknown as AuthenticatedRequest;

      await controller.updateProfile(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(HttpError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 400, message: "Invalid Stellar public key" });
    });

    it("returns 400 when userType is invalid", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: mockUser.id }, body: { userType: "superadmin" } } as unknown as AuthenticatedRequest;

      await controller.updateProfile(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(HttpError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 400, message: "Invalid user type" });
    });

    it("returns 400 when no valid update fields are provided", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: mockUser.id }, body: {} } as unknown as AuthenticatedRequest;

      await controller.updateProfile(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(HttpError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 400, message: "No valid fields to update" });
    });

    it("returns 404 when user is not found in database", async () => {
      mockRepo.findById.mockResolvedValue(null);
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: "missing-id" }, body: { email: "valid@example.com" } } as unknown as AuthenticatedRequest;

      await controller.updateProfile(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(HttpError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 404 });
    });

    it("updates email in lowercase and returns 200 with updated DTO", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: mockUser.id }, body: { email: "  NEW.EMAIL@EXAMPLE.COM  " } } as unknown as AuthenticatedRequest;

      await controller.updateProfile(req, mockRes as Response, mockNext);

      expect(mockRepo.save).toHaveBeenCalledWith(expect.objectContaining({ email: "new.email@example.com" }));
      expect(mockLogger.info).toHaveBeenCalledWith("User profile updated", expect.objectContaining({ userId: mockUser.id }));
      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it("updates valid Stellar public key and returns 200", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const validAddress = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
      const req = { user: { id: mockUser.id }, body: { stellarAddress: validAddress } } as unknown as AuthenticatedRequest;

      await controller.updateProfile(req, mockRes as Response, mockNext);

      expect(mockRepo.save).toHaveBeenCalledWith(expect.objectContaining({ stellarAddress: validAddress }));
      expect(mockRes.status).toHaveBeenCalledWith(200);
    });
  });

  describe("listUsers", () => {
    it("returns 401 when request is unauthenticated", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: undefined, query: {} } as unknown as AuthenticatedRequest & { query: { page?: string; limit?: string } };

      await controller.listUsers(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(HttpError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 401 });
    });

    it("fetches users and total count concurrently with default pagination", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: mockUser.id }, query: {} } as unknown as AuthenticatedRequest & { query: { page?: string; limit?: string } };

      await controller.listUsers(req, mockRes as Response, mockNext);

      expect(mockRepo.findAll).toHaveBeenCalledWith({ skip: 0, take: 20 });
      expect(mockRepo.count).toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: expect.arrayContaining([expect.objectContaining({ id: mockUser.id })]),
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      });
    });

    it("handles clamped pagination bounds correctly", async () => {
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: mockUser.id }, query: { page: "-5", limit: "5000" } } as unknown as AuthenticatedRequest & { query: { page?: string; limit?: string } };

      await controller.listUsers(req, mockRes as Response, mockNext);

      expect(mockRepo.findAll).toHaveBeenCalledWith({ skip: 0, take: 100 });
      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it("falls back gracefully when repository does not define count method", async () => {
      const repoWithoutCount: UserRepositoryContract = {
        findById: mockRepo.findById,
        findByStellarAddress: mockRepo.findByStellarAddress,
        findByEmail: mockRepo.findByEmail,
        findAll: mockRepo.findAll,
        save: mockRepo.save,
      };

      const controller = createUserController({ userRepository: repoWithoutCount, logger: mockLogger });
      const req = { user: { id: mockUser.id }, query: { page: "1", limit: "10" } } as unknown as AuthenticatedRequest & { query: { page?: string; limit?: string } };

      await controller.listUsers(req, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ meta: { total: 1, page: 1, limit: 10, totalPages: 1 } }));
    });

    it("catches repository errors and forwards AppError 500", async () => {
      mockRepo.findAll.mockRejectedValue(new Error("Database offline"));
      const controller = createUserController({ userRepository: mockRepo, logger: mockLogger });
      const req = { user: { id: mockUser.id }, query: {} } as unknown as AuthenticatedRequest & { query: { page?: string; limit?: string } };

      await controller.listUsers(req, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(AppError));
      expect(mockNext.mock.calls[0][0]).toMatchObject({ statusCode: 500 });
    });
  });
});
