import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates contract_acls / contract_acl_logs (issue #543).
 *
 * Current whitelist state plus the append-only add/remove history derived from
 * `ACLUpdated` contract events.
 */
export class CreateContractAclTables1732900000000 implements MigrationInterface {
  name = "CreateContractAclTables1732900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "contract_acls" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "contract_address" varchar(56) NOT NULL,
        "permitted_functions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "status" varchar(16) NOT NULL DEFAULT 'active',
        "added_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "removed_at" TIMESTAMP WITH TIME ZONE,
        "last_ledger" bigint,
        "last_tx_hash" varchar(64),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_contract_acls_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_contract_acls_contract_address"
      ON "contract_acls" ("contract_address");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "contract_acl_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "contract_address" varchar(56) NOT NULL,
        "action" varchar(16) NOT NULL,
        "permitted_functions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "ledger_sequence" bigint,
        "tx_hash" varchar(64),
        "actor" varchar(56),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_contract_acl_logs_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_contract_acl_logs_contract_address"
      ON "contract_acl_logs" ("contract_address");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_contract_acl_logs_created_at"
      ON "contract_acl_logs" ("created_at" DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_contract_acl_logs_created_at";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_contract_acl_logs_contract_address";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "contract_acl_logs";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_contract_acls_contract_address";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "contract_acls";`);
  }
}
