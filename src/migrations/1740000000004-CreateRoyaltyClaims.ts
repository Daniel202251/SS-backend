import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the royalty_claims table.
 *
 * Pairs with `royalty_events` (already created by CreateRoyaltyEvents) so
 * earnings accrued by a creator can be reconciled against the royalties they
 * have actually claimed, each with the on-chain transaction that paid them.
 */
export class CreateRoyaltyClaims1740000000004 implements MigrationInterface {
  name = "CreateRoyaltyClaims1740000000004";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "royalty_claims" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "claim_id" varchar(128) NOT NULL,
        "key_address" varchar(128),
        "creator_wallet" varchar(56) NOT NULL,
        "amount" decimal(18,4) NOT NULL DEFAULT 0,
        "tx_hash" varchar(64),
        "ledger_sequence" bigint,
        "claimed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_royalty_claims_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_royalty_claims_claim_id" UNIQUE ("claim_id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_royalty_claims_claim_id"
      ON "royalty_claims" ("claim_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_royalty_claims_creator_wallet"
      ON "royalty_claims" ("creator_wallet");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_royalty_claims_claimed_at"
      ON "royalty_claims" ("claimed_at" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_royalty_claims_claimed_at";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_royalty_claims_creator_wallet";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_royalty_claims_claim_id";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "royalty_claims";`);
  }
}
