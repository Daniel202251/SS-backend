import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMarketplaceIndexes1711100000000 implements MigrationInterface {
  name = "AddMarketplaceIndexes1711100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Composite index on invoices (status, created_at DESC) for marketplace listing with sorting
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_INVOICES_STATUS_CREATED_AT_DESC"
      ON "invoices" ("status", "created_at" DESC);
    `);

    // Composite index on invoices (status, amount DESC) for marketplace listing with amount sorting
    // Note: the column is "amount" (face value) in the invoices table
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_INVOICES_STATUS_AMOUNT_DESC"
      ON "invoices" ("status", "amount" DESC);
    `);

    // Composite index on investments (investor_id, status) for investor dashboard queries
    // Note: the column is "investor_id" not "user_id"
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_INVESTMENTS_INVESTOR_ID_STATUS"
      ON "investments" ("investor_id", "status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."IDX_INVESTMENTS_INVESTOR_ID_STATUS";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."IDX_INVOICES_STATUS_AMOUNT_DESC";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."IDX_INVOICES_STATUS_CREATED_AT_DESC";
    `);
  }
}