import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the creator_keys table for ratings-based leaderboard feature.
 * Tracks aggregate rating data (sum, count, average) per creator key.
 */
export class CreateCreatorKeysAndRatingsLeaderboard1740000000000 implements MigrationInterface {
  name = "CreateCreatorKeysAndRatingsLeaderboard1740000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "creator_keys" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "key_address" varchar(128) NOT NULL,
        "creator_wallet" varchar(56) NOT NULL,
        "name" varchar(255),
        "description" text,
        "image_url" varchar(512),
        "rating_count" integer NOT NULL DEFAULT 0,
        "rating_sum" decimal(18,4) NOT NULL DEFAULT 0,
        "average_rating" decimal(5,4) NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_creator_keys_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_creator_keys_key_address" UNIQUE ("key_address")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_creator_keys_key_address"
      ON "creator_keys" ("key_address");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_creator_keys_creator_wallet"
      ON "creator_keys" ("creator_wallet");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_creator_keys_average_rating"
      ON "creator_keys" ("average_rating" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_creator_keys_rating_count"
      ON "creator_keys" ("rating_count");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_creator_keys_rating_count";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_creator_keys_average_rating";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_creator_keys_creator_wallet";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_creator_keys_key_address";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "creator_keys";`);
  }
}
