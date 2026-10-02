import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the onboarding_progress table.
 *
 * Holds one row per wallet so the client can decide on app load whether to show
 * the onboarding tour again. The unique wallet address keeps completion state
 * unambiguous across the wallet's devices.
 */
export class CreateOnboardingProgress1740000000006 implements MigrationInterface {
  name = "CreateOnboardingProgress1740000000006";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "onboarding_progress" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "wallet_address" varchar(56) NOT NULL,
        "tour_completed" boolean NOT NULL DEFAULT false,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_onboarding_progress_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_onboarding_progress_wallet_address" UNIQUE ("wallet_address")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_onboarding_progress_wallet_address"
      ON "onboarding_progress" ("wallet_address");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_onboarding_progress_wallet_address";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "onboarding_progress";`);
  }
}
