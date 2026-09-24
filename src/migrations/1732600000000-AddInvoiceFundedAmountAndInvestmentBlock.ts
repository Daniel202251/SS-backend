import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Supports the fractional investment endpoint (issue #465):
 *  - invoices.funded_amount: running total of committed investments, updated
 *    atomically with each investment and capped by a CHECK constraint so the
 *    database itself refuses to over-fund an invoice
 *  - investments.investor_wallet / funding_block: who invested and in which
 *    ledger, with a unique index so one wallet cannot invest twice in the
 *    same invoice within the same block
 */
export class AddInvoiceFundedAmountAndInvestmentBlock1732600000000 implements MigrationInterface {
  name = "AddInvoiceFundedAmountAndInvestmentBlock1732600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "invoices"
      ADD COLUMN IF NOT EXISTS "funded_amount" decimal(18,4) NOT NULL DEFAULT 0;
    `);

    // Backfill from the commitments that count toward capacity today.
    await queryRunner.query(`
      UPDATE "invoices" AS i
      SET "funded_amount" = COALESCE((
        SELECT SUM(v."investment_amount")
        FROM "investments" AS v
        WHERE v."invoice_id" = i."id"
          AND v."status" IN ('pending', 'confirmed')
          AND v."deleted_at" IS NULL
      ), 0);
    `);

    // NOT VALID: enforce on every new write without failing the migration on
    // any historical row that was already over-subscribed.
    await queryRunner.query(`
      ALTER TABLE "invoices"
      ADD CONSTRAINT "chk_invoices_funded_amount_within_net"
      CHECK ("funded_amount" >= 0 AND "funded_amount" <= "net_amount") NOT VALID;
    `);

    await queryRunner.query(`
      ALTER TABLE "investments"
      ADD COLUMN IF NOT EXISTS "investor_wallet" character varying(56),
      ADD COLUMN IF NOT EXISTS "funding_block" bigint;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_investments_invoice_wallet_block"
      ON "investments" ("invoice_id", "investor_wallet", "funding_block");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_investments_invoice_wallet_block";`);
    await queryRunner.query(`
      ALTER TABLE "investments"
      DROP COLUMN IF EXISTS "funding_block",
      DROP COLUMN IF EXISTS "investor_wallet";
    `);
    await queryRunner.query(`
      ALTER TABLE "invoices"
      DROP CONSTRAINT IF EXISTS "chk_invoices_funded_amount_within_net";
    `);
    await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN IF EXISTS "funded_amount";`);
  }
}
