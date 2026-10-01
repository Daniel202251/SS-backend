import { AddMarketplaceIndexes1711000000000 } from "../../src/migrations/1711000000000-AddMarketplaceIndexes";
import { AppError } from "../../src/utils/http-error";
import { QueryRunner } from "typeorm";
import { jest } from "@jest/globals";

describe("AddMarketplaceIndexes Migration - Issue #144", () => {
  let migration: AddMarketplaceIndexes1711000000000;
  let mockQueryRunner: { query: any };

  beforeEach(() => {
    migration = new AddMarketplaceIndexes1711000000000();
    mockQueryRunner = {
      query: jest.fn(),
    };
    mockQueryRunner.query.mockResolvedValue(undefined);
  });

  it("should execute up migration successfully", async () => {
    await migration.up(mockQueryRunner as any);
    expect(mockQueryRunner.query).toHaveBeenCalledTimes(3);
  });

  it("should create idx_invoices_status_created_at_desc index", async () => {
    await migration.up(mockQueryRunner as any);
    const calls = mockQueryRunner.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((sql: string) => sql.includes("idx_invoices_status_created_at_desc"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("created_at\" DESC"))).toBe(true);
  });

  it("should create idx_invoices_status_amount_desc index", async () => {
    await migration.up(mockQueryRunner as any);
    const calls = mockQueryRunner.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((sql: string) => sql.includes("idx_invoices_status_amount_desc"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("amount\" DESC"))).toBe(true);
  });

  it("should create idx_investments_investor_id_status index", async () => {
    await migration.up(mockQueryRunner as any);
    const calls = mockQueryRunner.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((sql: string) => sql.includes("idx_investments_investor_id_status"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("investor_id") && sql.includes("status"))).toBe(true);
  });

  it("should throw AppError on up migration failure", async () => {
    mockQueryRunner.query.mockRejectedValueOnce(new Error("Database connection lost"));
    await expect(migration.up(mockQueryRunner as any)).rejects.toThrow("Database connection lost");
  });

  it("should execute down migration successfully", async () => {
    await migration.down(mockQueryRunner as any);
    expect(mockQueryRunner.query).toHaveBeenCalledTimes(3);
  });

  it("should drop indexes in reverse order on down migration", async () => {
    await migration.down(mockQueryRunner as any);
    const calls = mockQueryRunner.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls[0]).toContain("idx_investments_investor_id_status");
    expect(calls[1]).toContain("idx_invoices_status_amount_desc");
    expect(calls[2]).toContain("idx_invoices_status_created_at_desc");
  });

  it("should throw AppError on down migration failure", async () => {
    mockQueryRunner.query.mockRejectedValueOnce(new Error("Index drop constraint failed"));
    await expect(migration.down(mockQueryRunner as any)).rejects.toThrow("Index drop constraint failed");
  });
});