import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMarketplaceIndexes1711000000000 implements MigrationInterface {
  name = "AddMarketplaceIndexes1711000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_invoices_status_created_at_desc"
      ON "invoices" ("status", "created_at" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_invoices_status_amount_desc"
      ON "invoices" ("status", "amount" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_investments_investor_id_status"
      ON "investments" ("investor_id", "status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."idx_investments_investor_id_status";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."idx_invoices_status_amount_desc";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."idx_invoices_status_created_at_desc";
    `);
  }
}