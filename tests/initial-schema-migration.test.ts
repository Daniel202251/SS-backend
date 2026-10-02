import { InitialSchema1731513600000 } from "../src/migrations/1731513600000-InitialSchema";
import { AppError } from "../src/utils/http-error";

interface QueryRunnerMock {
  query: jest.Mock;
}

function createQueryRunnerMock(overrides: Partial<QueryRunnerMock> = {}): QueryRunnerMock {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes("to_regclass")) {
      return [];
    }
    return [];
  });
  return { query, ...overrides };
}

describe("InitialSchema1731513600000", () => {
  const migration = new InitialSchema1731513600000();

  it("reports the expected migration name", () => {
    expect(migration.name).toBe("InitialSchema1731513600000");
  });

  it("creates all expected tables on up", async () => {
    const runner = createQueryRunnerMock();
    await migration.up(runner as never);

    const ddl = runner.query.mock.calls.map(([sql]) => String(sql)).join("\n");

    expect(ddl).toContain('CREATE TABLE "users"');
    expect(ddl).toContain('CREATE TABLE "invoices"');
    expect(ddl).toContain('CREATE TABLE "investments"');
    expect(ddl).toContain('CREATE TABLE "transactions"');
    expect(ddl).toContain('CREATE TABLE "kyc_verifications"');
    expect(ddl).toContain('CREATE TABLE "notifications"');
  });

  it("creates all enum types and expected indexes on up", async () => {
    const runner = createQueryRunnerMock();
    await migration.up(runner as never);

    const ddl = runner.query.mock.calls.map(([sql]) => String(sql)).join("\n");

    expect(ddl).toContain('CREATE TYPE "public"."users_usertype_enum"');
    expect(ddl).toContain('CREATE TYPE "public"."transactions_transactiontype_enum"');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS "idx_transactions_user_id"');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS "idx_invoices_seller_id"');
  });

  it("skips table creation when the table already exists", async () => {
    const runner = createQueryRunnerMock({
      query: jest.fn(async (sql: string) => {
        if (sql.includes("to_regclass")) {
          return [{ table: 'public."users"' }];
        }
        return [];
      }),
    });

    await migration.up(runner as never);

    const ddl = runner.query.mock.calls.map(([sql]) => String(sql)).join("\n");
    expect(ddl).not.toContain('CREATE TABLE "users"');
  });

  it("drops all tables and enum types on down", async () => {
    const runner = createQueryRunnerMock({
      query: jest.fn(async (sql: string) => {
        if (sql.includes("to_regclass")) {
          return [{ table: 'public."notifications"' }];
        }
        return [];
      }),
    });

    await migration.down(runner as never);

    const ddl = runner.query.mock.calls.map(([sql]) => String(sql)).join("\n");
    expect(ddl).toContain('DROP TABLE "public"."notifications"');
    expect(ddl).toContain('DROP TABLE "public"."users"');
    expect(ddl).toContain('DROP TYPE "public"."users_usertype_enum"');
  });

  it("wraps a failed up in an AppError with MIGRATION_FAILED code", async () => {
    const runner = createQueryRunnerMock({
      query: jest.fn(async (sql: string) => {
        if (sql.includes("to_regclass")) {
          return [];
        }
        throw new Error("connection lost");
      }),
    });

    await expect(migration.up(runner as never)).rejects.toBeInstanceOf(AppError);
    await expect(migration.up(runner as never)).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
      statusCode: 500,
    });
  });

  it("wraps a failed down in an AppError with MIGRATION_ROLLBACK_FAILED code", async () => {
    const runner = createQueryRunnerMock({
      query: jest.fn(async () => {
        throw new Error("connection lost");
      }),
    });

    await expect(migration.down(runner as never)).rejects.toBeInstanceOf(AppError);
    await expect(migration.down(runner as never)).rejects.toMatchObject({
      code: "MIGRATION_ROLLBACK_FAILED",
      statusCode: 500,
    });
  });
});
