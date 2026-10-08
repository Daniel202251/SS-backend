import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the dividend_allocations and dividend_claims tables.
 *
 * `dividend_allocations` holds each holder's share of a distribution cycle and
 * `dividend_claims` records what a holder has withdrawn from it, so the
 * claimable balance for a wallet is `allocations - claims` per cycle. Both are
 * written from on-chain events and are idempotent on their on-chain ids.
 */
export class CreateDividendAllocationsAndClaims1740000000005 implements MigrationInterface {
  name = "CreateDividendAllocationsAndClaims1740000000005";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dividend_allocations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "allocation_id" varchar(128) NOT NULL,
        "distribution_id" uuid,
        "issuer_wallet" varchar(56) NOT NULL,
        "recipient_wallet" varchar(56) NOT NULL,
        "amount" decimal(18,4) NOT NULL DEFAULT 0,
        "cycle_frequency" varchar(20),
        "tx_hash" varchar(64),
        "ledger_sequence" bigint,
        "distributed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dividend_allocations_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_dividend_allocations_allocation_id" UNIQUE ("allocation_id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_dividend_allocations_allocation_id"
      ON "dividend_allocations" ("allocation_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_dividend_allocations_recipient_wallet"
      ON "dividend_allocations" ("recipient_wallet");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_dividend_allocations_distribution"
      ON "dividend_allocations" ("distribution_id");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dividend_claims" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "claim_id" varchar(128) NOT NULL,
        "distribution_id" uuid,
        "issuer_wallet" varchar(56),
        "recipient_wallet" varchar(56) NOT NULL,
        "amount" decimal(18,4) NOT NULL DEFAULT 0,
        "cycle_frequency" varchar(20),
        "tx_hash" varchar(64),
        "ledger_sequence" bigint,
        "claimed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dividend_claims_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_dividend_claims_claim_id" UNIQUE ("claim_id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_dividend_claims_claim_id"
      ON "dividend_claims" ("claim_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_dividend_claims_recipient_wallet"
      ON "dividend_claims" ("recipient_wallet");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_dividend_claims_claimed_at"
      ON "dividend_claims" ("claimed_at" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_dividend_claims_claimed_at";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_dividend_claims_recipient_wallet";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_dividend_claims_claim_id";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dividend_claims";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_dividend_allocations_distribution";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_dividend_allocations_recipient_wallet";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_dividend_allocations_allocation_id";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dividend_allocations";`);
  }
}
