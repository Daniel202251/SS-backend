import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the creator_keys table (issue #542).
 *
 * Mirrors the on-chain per-key configuration so the API can answer
 * "what is the max buy per transaction?" without an RPC round trip, and keeps
 * the projection updated from KeyConfigUpdated contract events.
 */
export class CreateCreatorKeysTable1732800000000 implements MigrationInterface {
  name = "CreateCreatorKeysTable1732800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "creator_keys" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "creator_id" varchar(128) NOT NULL,
        "creator_wallet" varchar(56) NOT NULL,
        "contract_address" varchar(56) NOT NULL,
        "max_buy_per_tx" decimal(30,7) NOT NULL DEFAULT 0,
        "max_buy_per_day" decimal(30,7) NOT NULL DEFAULT 0,
        "current_supply" decimal(30,7) NOT NULL DEFAULT 0,
        "curve_type" varchar(32) NOT NULL DEFAULT 'constant_product',
        "config_version" integer NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_creator_keys_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_creator_keys_contract_address"
      ON "creator_keys" ("contract_address");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_creator_keys_creator_id"
      ON "creator_keys" ("creator_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_creator_keys_creator_id";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_creator_keys_contract_address";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "creator_keys";`);
  }
}
