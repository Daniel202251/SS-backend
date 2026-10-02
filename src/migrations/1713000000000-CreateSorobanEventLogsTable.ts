import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSorobanEventLogsTable1713000000000 implements MigrationInterface {
  name = "CreateSorobanEventLogsTable1713000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "soroban_event_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "contract_id" character varying(56) NOT NULL,
        "ledger_sequence" bigint NOT NULL,
        "topic" character varying(64) NOT NULL,
        "tx_hash" character varying(64) NOT NULL,
        "payload" jsonb,
        "processed" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_soroban_event_logs" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_soroban_event_logs_processed"
      ON "soroban_event_logs" ("processed");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "public"."idx_soroban_event_logs_processed";
    `);

    await queryRunner.query(`DROP TABLE "soroban_event_logs"`);
  }
}
