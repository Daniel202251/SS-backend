import { approveKYC } from "@/routes/admin/approve-kyc";
import { rejectKYC } from "@/routes/admin/reject-kyc";
import { revokeKYC } from "@/routes/admin/revoke-kyc";
import { KYCStatus } from "@/types/enums";
import { logger } from "@/observability/logger";

/**
 * Approve, reject and revoke all emit the same structured KYC status-change
 * entry (#181). These tests pin the field set, the truncation, the fact that
 * `previous_status` is read before the write, and the log-after-persist
 * ordering that makes the entry trustworthy as an audit trail.
 */
describe("KYC admin routes — structured logging", () => {
  const ADMIN_KEY = "test-admin-key";
  const REVIEWER = { id: "reviewer-1", stellarAddress: "GREVIEWERWALLET01" };
  let mockUserRepo: any;
  let mockDataSource: any;
  let req: any;
  let res: any;
  let logSpy: jest.SpyInstance;

  /** Resolve `findOneBy` per id so the reviewer and subject differ. */
  function stubUsers(users: Array<{ id: string; stellarAddress: string; kycStatus?: KYCStatus }>) {
    mockUserRepo.findOneBy.mockImplementation(async ({ id }: { id: string }) => {
      return users.find((u) => u.id === id) ?? null;
    });
  }

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;

    mockUserRepo = {
      findOneBy: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };
    mockDataSource = {
      getRepository: jest.fn().mockReturnValue(mockUserRepo),
    };

    req = {
      headers: { "x-admin-key": ADMIN_KEY },
      body: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    logSpy = jest.spyOn(logger, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe("approveKYC", () => {
    it("emits a status-change log with all five audit fields after the DB update", async () => {
      const callOrder: string[] = [];
      stubUsers([
        { id: "user-1", stellarAddress: "GABCDEFGHIJKLMNOP", kycStatus: KYCStatus.IN_REVIEW },
        REVIEWER,
      ]);
      mockUserRepo.update.mockImplementation(async () => {
        callOrder.push("db_update");
      });
      logSpy.mockImplementation(() => {
        callOrder.push("log");
      });

      req.body = { userId: "user-1", reviewerId: REVIEWER.id };

      await approveKYC(req, res, mockDataSource);

      expect(mockUserRepo.update).toHaveBeenCalledWith("user-1", { kycStatus: KYCStatus.APPROVED });
      expect(logSpy).toHaveBeenCalledTimes(1);

      const [message, metadata] = logSpy.mock.calls[0];
      expect(message).toBe("KYC status change");
      expect(metadata).toMatchObject({
        wallet: "GABC...MNOP",
        previous_status: KYCStatus.IN_REVIEW,
        new_status: KYCStatus.APPROVED,
        reviewer_wallet: "GREV...ET01",
        reviewer_id: REVIEWER.id,
        action: "approve",
      });
      expect(typeof metadata.changed_at).toBe("string");
      expect(Number.isNaN(Date.parse(metadata.changed_at))).toBe(false);

      // The log must land after the write, never before it.
      expect(callOrder).toEqual(["db_update", "log"]);
    });

    it("records the pre-change status, not the new one", async () => {
      stubUsers([
        { id: "user-1", stellarAddress: "GABCDEFGHIJKLMNOP", kycStatus: KYCStatus.PENDING },
        REVIEWER,
      ]);
      req.body = { userId: "user-1", reviewerId: REVIEWER.id };

      await approveKYC(req, res, mockDataSource);

      const [, metadata] = logSpy.mock.calls[0];
      expect(metadata.previous_status).toBe(KYCStatus.PENDING);
      expect(metadata.new_status).toBe(KYCStatus.APPROVED);
      expect(metadata.previous_status).not.toBe(metadata.new_status);
    });

    it("falls back to the reviewer id when the reviewer has no user record", async () => {
      stubUsers([
        { id: "user-1", stellarAddress: "GABCDEFGHIJKLMNOP", kycStatus: KYCStatus.PENDING },
      ]);
      req.body = { userId: "user-1", reviewerId: "external-reviewer" };

      await approveKYC(req, res, mockDataSource);

      const [, metadata] = logSpy.mock.calls[0];
      expect(metadata.reviewer_wallet).toBe("exte...ewer");
      expect(metadata.reviewer_id).toBe("external-reviewer");
    });

    it("does not log when the admin key is invalid", async () => {
      req.headers["x-admin-key"] = "wrong-key";
      req.body = { userId: "user-1", reviewerId: REVIEWER.id };

      await approveKYC(req, res, mockDataSource);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("does not log when the user does not exist", async () => {
      stubUsers([REVIEWER]);
      req.body = { userId: "missing-user", reviewerId: REVIEWER.id };

      await approveKYC(req, res, mockDataSource);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockUserRepo.update).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe("rejectKYC", () => {
    it("emits a status-change log including the rejection reason after the DB update", async () => {
      stubUsers([
        { id: "user-2", stellarAddress: "GZYXWVUTSRQPONML", kycStatus: KYCStatus.IN_REVIEW },
        REVIEWER,
      ]);

      req.body = {
        userId: "user-2",
        reviewerId: REVIEWER.id,
        rejectionReason: "Document expired",
      };

      await rejectKYC(req, res, mockDataSource);

      expect(mockUserRepo.update).toHaveBeenCalledWith("user-2", { kycStatus: KYCStatus.REJECTED });
      expect(logSpy).toHaveBeenCalledTimes(1);

      const [message, metadata] = logSpy.mock.calls[0];
      expect(message).toBe("KYC status change");
      expect(metadata).toMatchObject({
        wallet: "GZYX...ONML",
        previous_status: KYCStatus.IN_REVIEW,
        new_status: KYCStatus.REJECTED,
        reviewer_wallet: "GREV...ET01",
        action: "reject",
        reason: "Document expired",
      });
      expect(typeof metadata.changed_at).toBe("string");
    });
  });

  describe("revokeKYC", () => {
    it("moves an approved user back to pending and logs the change", async () => {
      const callOrder: string[] = [];
      stubUsers([
        { id: "user-3", stellarAddress: "GQQQQWWWWEEEERRRR", kycStatus: KYCStatus.APPROVED },
        REVIEWER,
      ]);
      mockUserRepo.update.mockImplementation(async () => {
        callOrder.push("db_update");
      });
      logSpy.mockImplementation(() => {
        callOrder.push("log");
      });

      req.body = {
        userId: "user-3",
        reviewerId: REVIEWER.id,
        revocationReason: "Sanctions screening hit",
      };

      await revokeKYC(req, res, mockDataSource);

      expect(mockUserRepo.update).toHaveBeenCalledWith("user-3", { kycStatus: KYCStatus.PENDING });
      expect(logSpy).toHaveBeenCalledTimes(1);

      const [message, metadata] = logSpy.mock.calls[0];
      expect(message).toBe("KYC status change");
      expect(metadata).toMatchObject({
        wallet: "GQQQ...RRRR",
        previous_status: KYCStatus.APPROVED,
        new_status: KYCStatus.PENDING,
        reviewer_wallet: "GREV...ET01",
        action: "revoke",
        reason: "Sanctions screening hit",
      });
      expect(typeof metadata.changed_at).toBe("string");
      expect(callOrder).toEqual(["db_update", "log"]);
    });

    it("refuses to revoke a user who is not approved, and logs nothing", async () => {
      stubUsers([
        { id: "user-4", stellarAddress: "GQQQQWWWWEEEERRRR", kycStatus: KYCStatus.PENDING },
        REVIEWER,
      ]);
      req.body = { userId: "user-4", reviewerId: REVIEWER.id, revocationReason: "n/a" };

      await revokeKYC(req, res, mockDataSource);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(mockUserRepo.update).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("does not log when the admin key is invalid", async () => {
      req.headers["x-admin-key"] = "wrong-key";
      req.body = { userId: "user-3", reviewerId: REVIEWER.id, revocationReason: "n/a" };

      await revokeKYC(req, res, mockDataSource);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe("field contract", () => {
    it("emits exactly the audit fields, in the same shape, for every action", async () => {
      stubUsers([
        { id: "user-5", stellarAddress: "GABCDEFGHIJKLMNOP", kycStatus: KYCStatus.APPROVED },
        REVIEWER,
      ]);

      req.body = { userId: "user-5", reviewerId: REVIEWER.id, revocationReason: "reason" };
      await revokeKYC(req, res, mockDataSource);
      const revokeKeys = Object.keys(logSpy.mock.calls[0][1]).sort();

      logSpy.mockClear();
      stubUsers([
        { id: "user-5", stellarAddress: "GABCDEFGHIJKLMNOP", kycStatus: KYCStatus.PENDING },
        REVIEWER,
      ]);
      req.body = { userId: "user-5", reviewerId: REVIEWER.id, rejectionReason: "reason" };
      await rejectKYC(req, res, mockDataSource);
      const rejectKeys = Object.keys(logSpy.mock.calls[0][1]).sort();

      const expected = [
        "action",
        "changed_at",
        "new_status",
        "previous_status",
        "reason",
        "reviewer_id",
        "reviewer_wallet",
        "wallet",
      ];
      expect(revokeKeys).toEqual(expected);
      expect(rejectKeys).toEqual(expected);
    });

    it("omits the reason field for approvals, which carry none", async () => {
      stubUsers([
        { id: "user-6", stellarAddress: "GABCDEFGHIJKLMNOP", kycStatus: KYCStatus.PENDING },
        REVIEWER,
      ]);
      req.body = { userId: "user-6", reviewerId: REVIEWER.id };

      await approveKYC(req, res, mockDataSource);

      expect(Object.keys(logSpy.mock.calls[0][1]).sort()).toEqual([
        "action",
        "changed_at",
        "new_status",
        "previous_status",
        "reviewer_id",
        "reviewer_wallet",
        "wallet",
      ]);
    });
  });
});
