import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Admin user management: the `admin` role, account suspension columns and
 * the `user_audit_logs` audit trail for role and suspension changes.
 */
export class AddUserAdminManagement1732800000000 implements MigrationInterface {
  name = "AddUserAdminManagement1732800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."users_usertype_enum" ADD VALUE IF NOT EXISTS 'admin';`
    );
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "is_suspended" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "suspended_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "suspension_reason" text
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_audit_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "target_user_id" uuid NOT NULL,
        "actor_user_id" uuid NOT NULL,
        "action" character varying(32) NOT NULL,
        "previous_value" character varying(32) NOT NULL,
        "new_value" character varying(32) NOT NULL,
        "reason" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_audit_logs_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_user_audit_logs_target_created" ON "user_audit_logs" ("target_user_id", "created_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_user_audit_logs_target_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_audit_logs"`);
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "suspension_reason",
        DROP COLUMN IF EXISTS "suspended_at",
        DROP COLUMN IF EXISTS "is_suspended"
    `);
    // Postgres cannot drop enum values; the 'admin' user type stays.
  }
}
