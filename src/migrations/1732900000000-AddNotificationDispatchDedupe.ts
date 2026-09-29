import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Batch notification dispatcher: new lifecycle notification types and a
 * unique `dedupe_key` so one event never notifies the same user twice.
 */
export class AddNotificationDispatchDedupe1732900000000 implements MigrationInterface {
  name = "AddNotificationDispatchDedupe1732900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of ["invoice_approved", "invoice_deadline_extended", "invoice_matured"]) {
      await queryRunner.query(
        `ALTER TYPE "public"."notifications_notificationtype_enum" ADD VALUE IF NOT EXISTS '${value}';`
      );
    }
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "dedupe_key" character varying(255)`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_notifications_dedupe_key" ON "notifications" ("dedupe_key")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_notifications_dedupe_key"`);
    await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "dedupe_key"`);
    // Postgres cannot drop enum values; mirrors AddInvoiceLifecycleNotificationTypes1732500000000.
  }
}
