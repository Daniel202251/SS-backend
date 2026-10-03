import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates curve_migrations (issue #544).
 *
 * One row per bonding-curve migration proposal, updated in place when the
 * matching `CurveMigrationExecuted` event arrives, so the creator key
 * management UI can render timelock state and execution history.
 */
export class CreateCurveMigrationsTable1733000000000 implements MigrationInterface {
  name = "CreateCurveMigrationsTable1733000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "curve_migrations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "key_id" uuid NOT NULL,
        "proposal_id" varchar(128) NOT NULL,
        "contract_address" varchar(56) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        "proposed_params" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "applied_params" jsonb,
        "timelock_expiry" TIMESTAMP WITH TIME ZONE,
        "proposed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "executed_at" TIMESTAMP WITH TIME ZONE,
        "proposal_tx_hash" varchar(64),
        "execution_tx_hash" varchar(64),
        "ledger_sequence" bigint,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_curve_migrations_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_curve_migrations_key_id" FOREIGN KEY ("key_id")
          REFERENCES "creator_keys"("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_curve_migrations_proposal_id"
      ON "curve_migrations" ("proposal_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_curve_migrations_key_id"
      ON "curve_migrations" ("key_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_curve_migrations_status"
      ON "curve_migrations" ("key_id", "status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_curve_migrations_status";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_curve_migrations_key_id";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_curve_migrations_proposal_id";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "curve_migrations";`);
  }
}
