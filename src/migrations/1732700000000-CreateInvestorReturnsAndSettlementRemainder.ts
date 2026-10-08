import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates investor_returns table and settlement_remainders table (issue #460).
 * Records each fractional investor's return calculated with floor division on invoice settlement,
 * and records remainder dust separately.
 */
export class CreateInvestorReturnsAndSettlementRemainder1732700000000 implements MigrationInterface {
  name = "CreateInvestorReturnsAndSettlementRemainder1732700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "investor_returns" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "invoice_id" uuid NOT NULL,
        "investment_id" uuid NOT NULL,
        "investor_id" uuid NOT NULL,
        "return_amount" decimal(18,4) NOT NULL,
        "amount" decimal(18,4) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_investor_returns_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_investor_returns_invoice_id" FOREIGN KEY ("invoice_id")
          REFERENCES "invoices"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_investor_returns_investment_id" FOREIGN KEY ("investment_id")
          REFERENCES "investments"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_investor_returns_investor_id" FOREIGN KEY ("investor_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_investor_returns_invoice_id"
      ON "investor_returns" ("invoice_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_investor_returns_investment_id"
      ON "investor_returns" ("investment_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_investor_returns_investor_id"
      ON "investor_returns" ("investor_id");
    `);

    await queryRunner.query(`
      ALTER TABLE "invoices"
      ADD COLUMN IF NOT EXISTS "settlement_remainder" decimal(18,4) NOT NULL DEFAULT 0;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "settlement_remainders" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "invoice_id" uuid NOT NULL,
        "remainder_amount" decimal(18,4) NOT NULL,
        "total_settlement_amount" decimal(18,4) NOT NULL,
        "total_distributed_amount" decimal(18,4) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_settlement_remainders_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_settlement_remainders_invoice_id" FOREIGN KEY ("invoice_id")
          REFERENCES "invoices"("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_settlement_remainders_invoice_id"
      ON "settlement_remainders" ("invoice_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_settlement_remainders_invoice_id";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "settlement_remainders";`);
    await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN IF EXISTS "settlement_remainder";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_investor_returns_investor_id";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_investor_returns_investment_id";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_investor_returns_invoice_id";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "investor_returns";`);
  }
}
