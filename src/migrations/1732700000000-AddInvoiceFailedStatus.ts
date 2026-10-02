import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the `failed` invoice status, set by the maturity job when a published
 * invoice reaches its due date without being fully funded.
 */
export class AddInvoiceFailedStatus1732700000000 implements MigrationInterface {
  name = "AddInvoiceFailedStatus1732700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."invoices_invoicestatus_enum" ADD VALUE IF NOT EXISTS 'failed';`
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop enum values; mirrors AddInvoiceLifecycleNotificationTypes1732500000000.
  }
}
