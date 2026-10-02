import { InitialSchema1731513600000 } from "../../src/migrations/1731513600000-InitialSchema";
import { AppError } from "../../src/utils/http-error";

describe("InitialSchema Migration - Issue #325", () => {
  let migration: InitialSchema1731513600000;
  let mockQueryRunner: any;

  beforeEach(() => {
    migration = new InitialSchema1731513600000();
    mockQueryRunner = {
      query: jest.fn().mockResolvedValue(undefined),
    };
  });

  it("should execute up migration successfully", async () => {
    await migration.up(mockQueryRunner);
    expect(mockQueryRunner.query).toHaveBeenCalled();
  });

  it("should throw AppError on up migration failure", async () => {
    mockQueryRunner.query.mockRejectedValue(new Error("Database connection lost"));
    await expect(migration.up(mockQueryRunner)).rejects.toThrow(AppError);
  });

  it("should execute down migration successfully", async () => {
    await migration.down(mockQueryRunner);
    expect(mockQueryRunner.query).toHaveBeenCalled();
  });

  it("should throw AppError on down migration failure", async () => {
    mockQueryRunner.query.mockRejectedValue(new Error("Table drop constraint failed"));
    await expect(migration.down(mockQueryRunner)).rejects.toThrow(AppError);
  });
});
