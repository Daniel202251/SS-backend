import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserAndTransactionPerformanceIndexes1732300000000
  implements MigrationInterface
{
  name = "AddUserAndTransactionPerformanceIndexes1732300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_users_user_type_kyc_status"
      ON "users" ("userType", "kycStatus");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_transactions_status_type_timestamp"
      ON "transactions" ("status", "type", "timestamp");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_transactions_stellar_tx_hash"
      ON "transactions" ("stellar_tx_hash");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_transactions_user_id_timestamp"
      ON "transactions" ("user_id", "timestamp");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."idx_transactions_user_id_timestamp";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."idx_transactions_stellar_tx_hash";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."idx_transactions_status_type_timestamp";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."idx_users_user_type_kyc_status";
    `);
  }
}
