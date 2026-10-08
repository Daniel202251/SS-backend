import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSorobanIndexerCheckpoint1732800000000 implements MigrationInterface {
  name = "AddSorobanIndexerCheckpoint1732800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "soroban_event_logs"
      ADD COLUMN "event_id" character varying(255)
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_soroban_event_logs_contract_event"
      ON "soroban_event_logs" ("contract_id", "event_id")
    `);

    await queryRunner.query(`
      CREATE TABLE "soroban_indexer_checkpoints" (
        "checkpoint_key" character varying(255) NOT NULL,
        "ledger_sequence" bigint NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_soroban_indexer_checkpoints" PRIMARY KEY ("checkpoint_key")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "soroban_indexer_checkpoints"`);
    await queryRunner.query(`DROP INDEX "public"."uq_soroban_event_logs_contract_event"`);
    await queryRunner.query(`ALTER TABLE "soroban_event_logs" DROP COLUMN "event_id"`);
  }
}
