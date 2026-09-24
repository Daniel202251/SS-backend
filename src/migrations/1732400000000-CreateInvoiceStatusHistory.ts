import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the invoice status transition audit trail (issue #468). Each row
 * is written in the same transaction as the invoice status change it records.
 */
export class CreateInvoiceStatusHistory1732400000000 implements MigrationInterface {
  name = "CreateInvoiceStatusHistory1732400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "invoice_status_history" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "invoice_id" uuid NOT NULL,
        "from_status" character varying(32) NOT NULL,
        "to_status" character varying(32) NOT NULL,
        "actor_role" character varying(16) NOT NULL,
        "actor_id" character varying(64),
        "trigger" character varying(32) NOT NULL,
        "reason" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_invoice_status_history_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_invoice_status_history_invoice_id" FOREIGN KEY ("invoice_id")
          REFERENCES "invoices"("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_invoice_status_history_invoice_created"
      ON "invoice_status_history" ("invoice_id", "created_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_invoice_status_history_invoice_created";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invoice_status_history";`);
  }
}
