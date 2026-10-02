import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Full-text search over the invoice marketplace: `issuer_name` and
 * `description` columns plus a stored, weighted `search_vector` (issuer name
 * ranks above description) with a GIN index.
 */
export const INVOICE_SEARCH_VECTOR_SQL = `
  ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce("issuer_name", '')), 'A') ||
      setweight(to_tsvector('english', coalesce("description", '')), 'B')
    ) STORED
`;

export const INVOICE_SEARCH_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS "idx_invoices_search_vector" ON "invoices" USING GIN ("search_vector")
`;

export class AddInvoiceFullTextSearch1733000000000 implements MigrationInterface {
  name = "AddInvoiceFullTextSearch1733000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "invoices"
        ADD COLUMN IF NOT EXISTS "issuer_name" character varying(255),
        ADD COLUMN IF NOT EXISTS "description" text
    `);
    await queryRunner.query(INVOICE_SEARCH_VECTOR_SQL);
    await queryRunner.query(INVOICE_SEARCH_INDEX_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_invoices_search_vector"`);
    await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN IF EXISTS "search_vector"`);
    await queryRunner.query(`
      ALTER TABLE "invoices"
        DROP COLUMN IF EXISTS "description",
        DROP COLUMN IF EXISTS "issuer_name"
    `);
  }
}
