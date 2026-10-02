import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTransactionInvoiceAndInvestmentLinks1731800000000 implements MigrationInterface {
  name = "AddTransactionInvoiceAndInvestmentLinks1731800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "transactions"
      ADD COLUMN IF NOT EXISTS "invoice_id" uuid,
      ADD COLUMN IF NOT EXISTS "investment_id" uuid;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_transactions_invoice_id"
      ON "transactions" ("invoice_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_transactions_investment_id"
      ON "transactions" ("investment_id");
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'FK_transactions_invoice'
        ) THEN
          ALTER TABLE "transactions"
          ADD CONSTRAINT "FK_transactions_invoice"
          FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id")
          ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'FK_transactions_investment'
        ) THEN
          ALTER TABLE "transactions"
          ADD CONSTRAINT "FK_transactions_investment"
          FOREIGN KEY ("investment_id") REFERENCES "investments"("id")
          ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "transactions"
      DROP CONSTRAINT IF EXISTS "FK_transactions_invoice";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."idx_transactions_invoice_id";
    `);

    await queryRunner.query(`
      ALTER TABLE "transactions"
      DROP COLUMN IF EXISTS "invoice_id";
    `);
  }
}
