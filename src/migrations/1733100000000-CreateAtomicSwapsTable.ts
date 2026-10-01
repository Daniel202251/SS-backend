import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates atomic_swaps (issue #545).
 *
 * Both sides of every direct invoice-for-invoice exchange, indexed by buyer
 * and by seller so either party can page through their own history.
 */
export class CreateAtomicSwapsTable1733100000000 implements MigrationInterface {
  name = "CreateAtomicSwapsTable1733100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "atomic_swaps" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "swap_id" varchar(128) NOT NULL,
        "buyer_address" varchar(56) NOT NULL,
        "seller_address" varchar(56) NOT NULL,
        "buyer_invoice_id" varchar(128),
        "seller_invoice_id" varchar(128),
        "buyer_amount" decimal(30,7) NOT NULL DEFAULT 0,
        "seller_amount" decimal(30,7) NOT NULL DEFAULT 0,
        "fee_amount" decimal(30,7) NOT NULL DEFAULT 0,
        "fee_recipient" varchar(56),
        "tx_hash" varchar(64),
        "ledger_sequence" bigint,
        "executed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_atomic_swaps_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_atomic_swaps_swap_id"
      ON "atomic_swaps" ("swap_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_atomic_swaps_buyer_address"
      ON "atomic_swaps" ("buyer_address");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_atomic_swaps_seller_address"
      ON "atomic_swaps" ("seller_address");
    `);

    // Keyset pagination for each party: (party, executed_at DESC, id DESC).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_atomic_swaps_buyer_created"
      ON "atomic_swaps" ("buyer_address", "executed_at" DESC, "id" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_atomic_swaps_seller_created"
      ON "atomic_swaps" ("seller_address", "executed_at" DESC, "id" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_atomic_swaps_seller_created";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_atomic_swaps_buyer_created";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_atomic_swaps_seller_address";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_atomic_swaps_buyer_address";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_atomic_swaps_swap_id";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "atomic_swaps";`);
  }
}
