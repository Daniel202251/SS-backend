import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the lifecycle event types used by in-app notifications (issue #467).
 * `invoice_rejected` already existed in the NotificationType enum in code
 * but was never added to the database type, so inserting it would fail.
 */
export class AddInvoiceLifecycleNotificationTypes1732500000000 implements MigrationInterface {
  name = "AddInvoiceLifecycleNotificationTypes1732500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of [
      "invoice_rejected",
      "invoice_funded",
      "invoice_settled",
      "investment_created",
    ]) {
      await queryRunner.query(
        `ALTER TYPE "public"."notifications_notificationtype_enum" ADD VALUE IF NOT EXISTS '${value}';`
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres cannot drop enum values; rows may already use them. Mirrors
    // AddInvoiceRejection1732000000000, which is also additive-only.
  }
}
