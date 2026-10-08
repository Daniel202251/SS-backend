import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the analytics_snapshots table.
 * Stores daily platform metric snapshots for historical trend analysis.
 */
export class CreateAnalyticsSnapshots1740000000003 implements MigrationInterface {
  name = "CreateAnalyticsSnapshots1740000000003";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "analytics_snapshots" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "snapshot_date" varchar(10) NOT NULL,
        "total_invoices_draft" integer NOT NULL DEFAULT 0,
        "total_invoices_pending" integer NOT NULL DEFAULT 0,
        "total_invoices_published" integer NOT NULL DEFAULT 0,
        "total_invoices_funded" integer NOT NULL DEFAULT 0,
        "total_invoices_settled" integer NOT NULL DEFAULT 0,
        "total_invoices_cancelled" integer NOT NULL DEFAULT 0,
        "total_invoices_rejected" integer NOT NULL DEFAULT 0,
        "total_invoices" integer NOT NULL DEFAULT 0,
        "daily_funding_volume" decimal(18,4) NOT NULL DEFAULT 0,
        "cumulative_funding_volume" decimal(18,4) NOT NULL DEFAULT 0,
        "active_investor_count" integer NOT NULL DEFAULT 0,
        "settlement_rate" decimal(5,2) NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_analytics_snapshots_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_analytics_snapshots_date" UNIQUE ("snapshot_date")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_analytics_snapshots_date"
      ON "analytics_snapshots" ("snapshot_date");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_analytics_snapshots_date";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "analytics_snapshots";`);
  }
}
