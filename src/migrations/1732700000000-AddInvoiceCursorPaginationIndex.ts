import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Supports keyset cursor-based pagination for invoices:
 * Adds indexes for (seller_id, created_at DESC, id DESC) and
 * (seller_id, status, created_at DESC, id DESC) to guarantee
 * deterministic ordering and sub-200ms response times.
 */
export class AddInvoiceCursorPaginationIndex1732700000000 implements MigrationInterface {
  name = "AddInvoiceCursorPaginationIndex1732700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_invoices_seller_created_at"
      ON "invoices" ("seller_id", "created_at" DESC, "id" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_invoices_seller_status_created_at"
      ON "invoices" ("seller_id", "status", "created_at" DESC, "id" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_invoices_seller_status_created_at";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_invoices_seller_created_at";`);
  }
}
