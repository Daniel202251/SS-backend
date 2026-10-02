import { MigrationInterface, QueryRunner } from "typeorm";

export class AddInvestmentPaymentVerification1731700000000 implements MigrationInterface {
  name = "AddInvestmentPaymentVerification1731700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "investments"
      ADD COLUMN "stellar_operation_index" integer;
    `);

    await queryRunner.query(`
      ALTER TABLE "transactions"
      ADD COLUMN "investment_id" uuid,
      ADD COLUMN "stellar_operation_index" integer;
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_transactions_investment_id"
      ON "transactions" ("investment_id");
    `);

    await queryRunner.query(`
      ALTER TABLE "transactions"
      ADD CONSTRAINT "FK_transactions_investment"
      FOREIGN KEY ("investment_id") REFERENCES "investments"("id")
      ON DELETE SET NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "transactions"
      DROP CONSTRAINT "FK_transactions_investment";
    `);

    await queryRunner.query(`
      DROP INDEX "public"."idx_transactions_investment_id";
    `);

    await queryRunner.query(`
      ALTER TABLE "transactions"
      DROP COLUMN "stellar_operation_index",
      DROP COLUMN "investment_id";
    `);

    await queryRunner.query(`
      ALTER TABLE "investments"
      DROP COLUMN "stellar_operation_index";
    `);
  }
}
