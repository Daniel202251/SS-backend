import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateEventTables1732400000000 implements MigrationInterface {
  name = "CreateEventTables1732400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kyc_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "wallet_address" character varying(64) NOT NULL,
        "user_id" character varying(64),
        "type" character varying(64) NOT NULL,
        "title" character varying(255) NOT NULL,
        "message" text NOT NULL,
        "read" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_kyc_events" PRIMARY KEY ("id")
      );
      CREATE INDEX IF NOT EXISTS "idx_kyc_events_wallet" ON "kyc_events" ("wallet_address");
      CREATE INDEX IF NOT EXISTS "idx_kyc_events_user_id" ON "kyc_events" ("user_id");

      CREATE TABLE IF NOT EXISTS "investment_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "wallet_address" character varying(64) NOT NULL,
        "user_id" character varying(64),
        "type" character varying(64) NOT NULL,
        "title" character varying(255) NOT NULL,
        "message" text NOT NULL,
        "read" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_investment_events" PRIMARY KEY ("id")
      );
      CREATE INDEX IF NOT EXISTS "idx_investment_events_wallet" ON "investment_events" ("wallet_address");
      CREATE INDEX IF NOT EXISTS "idx_investment_events_user_id" ON "investment_events" ("user_id");

      CREATE TABLE IF NOT EXISTS "settlement_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "wallet_address" character varying(64) NOT NULL,
        "user_id" character varying(64),
        "type" character varying(64) NOT NULL,
        "title" character varying(255) NOT NULL,
        "message" text NOT NULL,
        "read" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_settlement_events" PRIMARY KEY ("id")
      );
      CREATE INDEX IF NOT EXISTS "idx_settlement_events_wallet" ON "settlement_events" ("wallet_address");
      CREATE INDEX IF NOT EXISTS "idx_settlement_events_user_id" ON "settlement_events" ("user_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS "settlement_events";
      DROP TABLE IF EXISTS "investment_events";
      DROP TABLE IF EXISTS "kyc_events";
    `);
  }
}
