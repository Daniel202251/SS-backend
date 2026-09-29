import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the royalty_events table to store indexed RoyaltyPaid on-chain events.
 * Powers the admin royalty analytics endpoint.
 */
export class CreateRoyaltyEvents1740000000001 implements MigrationInterface {
  name = "CreateRoyaltyEvents1740000000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "royalty_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "key_address" varchar(128) NOT NULL,
        "creator_wallet" varchar(56) NOT NULL,
        "buyer_wallet" varchar(56),
        "amount" decimal(18,4) NOT NULL,
        "tx_hash" varchar(64),
        "ledger_sequence" bigint,
        "paid_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_royalty_events_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_royalty_events_creator_wallet"
      ON "royalty_events" ("creator_wallet");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_royalty_events_key_address"
      ON "royalty_events" ("key_address");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_royalty_events_paid_at"
      ON "royalty_events" ("paid_at");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_royalty_events_tx_hash"
      ON "royalty_events" ("tx_hash");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_royalty_events_tx_hash";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_royalty_events_paid_at";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_royalty_events_key_address";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_royalty_events_creator_wallet";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "royalty_events";`);
  }
}
