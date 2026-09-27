import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates dividend_cycle_configs and dividend_distributions tables.
 * Powers the dividend cycle config and distribution history endpoints.
 */
export class CreateDividendTables1740000000002 implements MigrationInterface {
  name = "CreateDividendTables1740000000002";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dividend_cycle_configs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "issuer_wallet" varchar(56) NOT NULL,
        "frequency" varchar(20) NOT NULL DEFAULT 'monthly',
        "next_distribution_at" TIMESTAMP WITH TIME ZONE,
        "last_distribution_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dividend_cycle_configs_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_dividend_cycle_configs_issuer_wallet" UNIQUE ("issuer_wallet")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_dividend_cycle_configs_issuer_wallet"
      ON "dividend_cycle_configs" ("issuer_wallet");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dividend_distributions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "issuer_wallet" varchar(56) NOT NULL,
        "total_amount" decimal(18,4) NOT NULL DEFAULT 0,
        "recipient_count" integer NOT NULL DEFAULT 0,
        "trigger" varchar(20) NOT NULL DEFAULT 'scheduled',
        "tx_hash" varchar(64),
        "cycle_frequency" varchar(20),
        "status" varchar(20) NOT NULL DEFAULT 'success',
        "distributed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dividend_distributions_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_dividend_distributions_issuer_wallet"
      ON "dividend_distributions" ("issuer_wallet");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_dividend_distributions_distributed_at"
      ON "dividend_distributions" ("distributed_at" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_dividend_distributions_distributed_at";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_dividend_distributions_issuer_wallet";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dividend_distributions";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_dividend_cycle_configs_issuer_wallet";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dividend_cycle_configs";`);
  }
}
