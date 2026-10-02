import { InitialSchema1731513600000 } from "@/migrations/1731513600000-InitialSchema";
import { AppError } from "@/utils/http-error";
import type { QueryRunner } from "typeorm";

describe("InitialSchema Migration", () => {
  let migration: InitialSchema1731513600000;
  let mockQueryRunner: Partial<QueryRunner>;

  beforeEach(() => {
    migration = new InitialSchema1731513600000();
    mockQueryRunner = {
      query: jest.fn().mockResolvedValue([]),
    };
  });

  describe("up", () => {
    it("executes schema creation queries with table and index definitions", async () => {
      await migration.up(mockQueryRunner as QueryRunner);

      expect(mockQueryRunner.query).toHaveBeenCalled();
      const queries = (mockQueryRunner.query as jest.Mock).mock.calls.map((c) => c[0]);

      // Verify enum types, tables, and composite indexes are created
      expect(queries.some((q) => q.includes("users_usertype_enum"))).toBe(true);
      expect(queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS \"users\""))).toBe(true);
      expect(queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS \"invoices\""))).toBe(true);
      expect(queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS \"investments\""))).toBe(true);
      expect(queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS \"transactions\""))).toBe(true);
      expect(queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS \"kyc_verifications\""))).toBe(true);
      expect(queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS \"notifications\""))).toBe(true);

      // Verify composite indexes for high-volume queries
      expect(queries.some((q) => q.includes("idx_invoices_seller_status_created"))).toBe(true);
      expect(queries.some((q) => q.includes("idx_invoices_status_due_date"))).toBe(true);
      expect(queries.some((q) => q.includes("idx_invoices_status_created_at"))).toBe(true);
      expect(queries.some((q) => q.includes("idx_invoices_status_amount"))).toBe(true);
      expect(queries.some((q) => q.includes("idx_investments_investor_status"))).toBe(true);
      expect(queries.some((q) => q.includes("idx_transactions_user_type_status"))).toBe(true);
    });

    it("wraps and logs errors when queryRunner fails during up", async () => {
      (mockQueryRunner.query as jest.Mock).mockRejectedValue(new Error("Database connection lost"));

      await expect(migration.up(mockQueryRunner as QueryRunner)).rejects.toBeInstanceOf(AppError);
      await expect(migration.up(mockQueryRunner as QueryRunner)).rejects.toMatchObject({
        statusCode: 500,
        code: expect.stringMatching(/^MIGRATION_(EXECUTION_)?FAILED$/),
      });
    });
  });

  describe("down", () => {
    it("executes safe idempotent drop statements with CASCADE", async () => {
      await migration.down(mockQueryRunner as QueryRunner);

      expect(mockQueryRunner.query).toHaveBeenCalled();
      const queries = (mockQueryRunner.query as jest.Mock).mock.calls.map((c) => c[0]);

      expect(queries.some((q) => q.includes("DROP TABLE IF EXISTS \"invoices\" CASCADE"))).toBe(true);
      expect(queries.some((q) => q.includes("DROP TABLE IF EXISTS \"users\" CASCADE"))).toBe(true);
      expect(queries.some((q) => q.includes("DROP TYPE IF EXISTS \"public\".\"users_usertype_enum\" CASCADE"))).toBe(true);
    });

    it("wraps and logs errors when queryRunner fails during down", async () => {
      (mockQueryRunner.query as jest.Mock).mockRejectedValue(new Error("Permission denied"));

      await expect(migration.down(mockQueryRunner as QueryRunner)).rejects.toBeInstanceOf(AppError);
      await expect(migration.down(mockQueryRunner as QueryRunner)).rejects.toMatchObject({
        statusCode: 500,
        code: "MIGRATION_ROLLBACK_FAILED",
      });
    });
  });
});
