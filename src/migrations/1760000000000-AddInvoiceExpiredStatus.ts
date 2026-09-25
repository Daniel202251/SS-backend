import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddInvoiceExpiredStatus1760000000000 implements MigrationInterface {
  name = "AddInvoiceExpiredStatus1760000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_enum e ON t.oid = e.enumtypid
          WHERE t.typname = 'invoices_invoicestatus_enum' AND e.enumlabel = 'expired'
        ) THEN
          ALTER TYPE "public"."invoices_invoicestatus_enum" ADD VALUE 'expired';
        END IF;
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Postgres does not support dropping enum values without recreating the type.
  }
}
