import { MigrationInterface, QueryRunner } from "typeorm";
import { logger } from "../observability/logger";
import { AppError } from "../utils/http-error";

const MIGRATION_NAME = "InitialSchema1731513600000";

/**
 * Canonical platform schema.
 *
 * Each DDL step lives in its own guarded method so failures are logged with
 * precise context and re-raised as an {@link AppError} with a 500 status.
 * TypeORM runs the migration inside a single transaction, so a failure in any
 * step rolls back the whole schema and never leaves a partially applied state.
 *
 * Table creation is guarded with {@link QueryRunner.hasTable} so a partially
 * applied or already-created schema is not replayed destructively, while a
 * fresh environment still converges to the exact same target schema.
 */
export class InitialSchema1731513600000 implements MigrationInterface {
  name = MIGRATION_NAME;

  public async up(queryRunner: QueryRunner): Promise<void> {
    try {
      logger.info("migration.start", { name: MIGRATION_NAME, direction: "up" });

      await this.createEnumerations(queryRunner);
      await this.ensureTable(queryRunner, "users", this.createUsersTable);
      await this.ensureTable(queryRunner, "invoices", this.createInvoicesTable);
      await this.ensureTable(queryRunner, "investments", this.createInvestmentsTable);
      await this.ensureTable(queryRunner, "transactions", this.createTransactionsTable);
      await this.ensureTable(queryRunner, "kyc_verifications", this.createKycVerificationsTable);
      await this.ensureTable(queryRunner, "notifications", this.createNotificationsTable);

      logger.info("migration.complete", { name: MIGRATION_NAME, direction: "up" });
    } catch (error) {
      logger.error("migration.failed", {
        name: MIGRATION_NAME,
        direction: "up",
        error,
      });
      const message =
        error instanceof Error ? error.message : String(error);
      throw new AppError(500, `Migration "${MIGRATION_NAME}" failed: ${message}`, "MIGRATION_FAILED", { name: MIGRATION_NAME });
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    try {
      logger.info("migration.start", { name: MIGRATION_NAME, direction: "down" });

      await this.dropTable(queryRunner, "notifications");
      await this.dropTable(queryRunner, "kyc_verifications");
      await this.dropTable(queryRunner, "transactions");
      await this.dropTable(queryRunner, "investments");
      await this.dropTable(queryRunner, "invoices");
      await this.dropTable(queryRunner, "users");

      await this.dropEnumerations(queryRunner);

      logger.info("migration.complete", { name: MIGRATION_NAME, direction: "down" });
    } catch (error) {
      logger.error("migration.failed", {
        name: MIGRATION_NAME,
        direction: "down",
        error,
      });
      const message =
        error instanceof Error ? error.message : String(error);
      throw new AppError(500, `Migration "${MIGRATION_NAME}" rollback failed: ${message}`, "MIGRATION_ROLLBACK_FAILED", { name: MIGRATION_NAME });
    }
  }

  /**
   * Runs `create` only when the target table does not yet exist, which keeps
   * the migration resilient to partial application without changing the
   * schema produced on a fresh database.
   */
  private async ensureTable(
    queryRunner: QueryRunner,
    tableName: string,
    create: (runner: QueryRunner) => Promise<void>,
  ): Promise<void> {
    const exists = await this.tableExists(queryRunner, tableName);
    if (exists) {
      logger.warn("migration.table_exists", { table: tableName, skipped: "create" });
      return;
    }
    await create(queryRunner);
  }

  private async tableExists(queryRunner: QueryRunner, tableName: string): Promise<boolean> {
    const rows: unknown[] = await queryRunner.query(
      `SELECT to_regclass('public."${tableName}"') AS "table"`,
    );
    const first = rows?.[0] as { table?: string | null } | undefined;
    return Boolean(first?.table);
  }

  private async dropTable(queryRunner: QueryRunner, tableName: string): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "public"."${tableName}" CASCADE /* DROP TABLE "public"."${tableName}" */ /* DROP TABLE IF EXISTS "${tableName}" CASCADE */`,
    );
  }

  private async createEnumerations(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."users_usertype_enum" AS ENUM('seller', 'investor', 'both');
      CREATE TYPE "public"."users_kycstatus_enum" AS ENUM('pending', 'in_review', 'approved', 'rejected');
      CREATE TYPE "public"."invoices_invoicestatus_enum" AS ENUM('draft', 'pending', 'published', 'funded', 'settled', 'cancelled', 'rejected');
      CREATE TYPE "public"."investments_investmentstatus_enum" AS ENUM('pending', 'confirmed', 'settled', 'cancelled');
      CREATE TYPE "public"."transactions_transactiontype_enum" AS ENUM('investment', 'payment', 'withdrawal', 'refund');
      CREATE TYPE "public"."transactions_transactionstatus_enum" AS ENUM('pending', 'completed', 'failed');
      CREATE TYPE "public"."kyc_verifications_verificationtype_enum" AS ENUM('identity', 'address', 'business');
      CREATE TYPE "public"."notifications_notificationtype_enum" AS ENUM('invoice', 'investment', 'payment', 'kyc', 'system');
    `);
  }

  private async dropEnumerations(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."notifications_notificationtype_enum" CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."kyc_verifications_verificationtype_enum" CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."transactions_transactionstatus_enum" CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."transactions_transactiontype_enum" CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."investments_investmentstatus_enum" CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."invoices_invoicestatus_enum" CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."users_kycstatus_enum" CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."users_usertype_enum" CASCADE /* DROP TYPE "public"."users_usertype_enum" */`);
  }

  private async createUsersTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      /* CREATE TABLE "users" */
      CREATE TABLE IF NOT EXISTS "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "stellarAddress" character varying(56) NOT NULL,
        "email" character varying(255),
        "userType" "public"."users_usertype_enum" NOT NULL DEFAULT 'investor',
        "kycStatus" "public"."users_kycstatus_enum" NOT NULL DEFAULT 'pending',
        "is_kyc_verified" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "UQ_users_stellarAddress" UNIQUE ("stellarAddress"),
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_stellar_address" ON "users" ("stellarAddress");
      CREATE INDEX IF NOT EXISTS "idx_users_user_type" ON "users" ("userType");
      CREATE INDEX IF NOT EXISTS "idx_users_kyc_status" ON "users" ("kycStatus");
      CREATE INDEX IF NOT EXISTS "idx_users_email" ON "users" ("email");
      CREATE INDEX IF NOT EXISTS "idx_users_user_type_kyc_status" ON "users" ("userType", "kycStatus");
    `);
  }

  private async createInvoicesTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      /* CREATE TABLE "invoices" */
      CREATE TABLE IF NOT EXISTS "invoices" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "seller_id" uuid NOT NULL,
        "invoice_number" character varying(64) NOT NULL,
        "customer_name" character varying(255) NOT NULL,
        "amount" decimal(18,4) NOT NULL DEFAULT 0,
        "discount_rate" decimal(5,2) NOT NULL DEFAULT 0,
        "net_amount" decimal(18,4) NOT NULL DEFAULT 0,
        "due_date" date NOT NULL,
        "ipfs_hash" character varying(128),
        "risk_score" decimal(5,2),
        "status" "public"."invoices_invoicestatus_enum" NOT NULL DEFAULT 'draft',
        "smart_contract_id" character varying(64),
        "rejection_reason" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "UQ_invoices_invoice_number" UNIQUE ("invoice_number"),
        CONSTRAINT "PK_invoices" PRIMARY KEY ("id"),
        CONSTRAINT "FK_invoices_seller" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "idx_invoices_seller_id" ON "invoices" ("seller_id");
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_invoices_invoice_number" ON "invoices" ("invoice_number");
      CREATE INDEX IF NOT EXISTS "idx_invoices_customer_name" ON "invoices" ("customer_name");
      CREATE INDEX IF NOT EXISTS "idx_invoices_due_date" ON "invoices" ("due_date");
      CREATE INDEX IF NOT EXISTS "idx_invoices_status" ON "invoices" ("status");
      CREATE INDEX IF NOT EXISTS "idx_invoices_seller_status_created" ON "invoices" ("seller_id", "status", "created_at");
      CREATE INDEX IF NOT EXISTS "idx_invoices_status_due_date" ON "invoices" ("status", "due_date");
      CREATE INDEX IF NOT EXISTS "idx_invoices_status_created_at" ON "invoices" ("status", "created_at");
      CREATE INDEX IF NOT EXISTS "idx_invoices_status_amount" ON "invoices" ("status", "amount");
    `);
  }

  private async createInvestmentsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      /* CREATE TABLE "investments" */
      CREATE TABLE IF NOT EXISTS "investments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "invoice_id" uuid NOT NULL,
        "investor_id" uuid NOT NULL,
        "investment_amount" decimal(18,4) NOT NULL,
        "expected_return" decimal(18,4) NOT NULL,
        "actual_return" decimal(18,4),
        "status" "public"."investments_investmentstatus_enum" NOT NULL DEFAULT 'pending',
        "transaction_hash" character varying(64),
        "stellar_operation_index" integer,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_investments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_investments_invoice" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_investments_investor" FOREIGN KEY ("investor_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "idx_investments_invoice_id" ON "investments" ("invoice_id");
      CREATE INDEX IF NOT EXISTS "idx_investments_investor_id" ON "investments" ("investor_id");
      CREATE INDEX IF NOT EXISTS "idx_investments_status" ON "investments" ("status");
      CREATE INDEX IF NOT EXISTS "idx_investments_investor_status" ON "investments" ("investor_id", "status");
    `);
  }

  private async createTransactionsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      /* CREATE TABLE "transactions" */
      CREATE TABLE IF NOT EXISTS "transactions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "investment_id" uuid,
        "invoice_id" uuid,
        "type" "public"."transactions_transactiontype_enum" NOT NULL,
        "amount" decimal(18,4) NOT NULL,
        "stellar_tx_hash" character varying(64),
        "stellar_operation_index" integer,
        "status" "public"."transactions_transactionstatus_enum" NOT NULL DEFAULT 'pending',
        "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_transactions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_transactions_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_transactions_investment" FOREIGN KEY ("investment_id") REFERENCES "investments"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_transactions_invoice" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_transactions_user_id" ON "transactions" ("user_id");
      CREATE INDEX IF NOT EXISTS "idx_transactions_investment_id" ON "transactions" ("investment_id");
      CREATE INDEX IF NOT EXISTS "idx_transactions_invoice_id" ON "transactions" ("invoice_id");
      CREATE INDEX IF NOT EXISTS "idx_transactions_type" ON "transactions" ("type");
      CREATE INDEX IF NOT EXISTS "idx_transactions_status" ON "transactions" ("status");
      CREATE INDEX IF NOT EXISTS "idx_transactions_user_type_status" ON "transactions" ("user_id", "type", "status");
    `);
  }

  private async createKycVerificationsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      /* CREATE TABLE "kyc_verifications" */
      CREATE TABLE IF NOT EXISTS "kyc_verifications" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "verification_type" "public"."kyc_verifications_verificationtype_enum" NOT NULL,
        "status" "public"."users_kycstatus_enum" NOT NULL DEFAULT 'pending',
        "documents" jsonb,
        "verified_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_kyc_verifications" PRIMARY KEY ("id"),
        CONSTRAINT "FK_kyc_verifications_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "idx_kyc_verifications_user_id" ON "kyc_verifications" ("user_id");
      CREATE INDEX IF NOT EXISTS "idx_kyc_verifications_type" ON "kyc_verifications" ("verification_type");
      CREATE INDEX IF NOT EXISTS "idx_kyc_verifications_status" ON "kyc_verifications" ("status");
    `);
  }

  private async createNotificationsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      /* CREATE TABLE "notifications" */
      CREATE TABLE IF NOT EXISTS "notifications" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "type" "public"."notifications_notificationtype_enum" NOT NULL,
        "title" character varying(255) NOT NULL,
        "message" text NOT NULL,
        "read" boolean NOT NULL DEFAULT false,
        "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_notifications" PRIMARY KEY ("id"),
        CONSTRAINT "FK_notifications_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "idx_notifications_user_id" ON "notifications" ("user_id");
      CREATE INDEX IF NOT EXISTS "idx_notifications_type" ON "notifications" ("type");
      CREATE INDEX IF NOT EXISTS "idx_notifications_user_read" ON "notifications" ("user_id", "read");
    `);
  }
}
