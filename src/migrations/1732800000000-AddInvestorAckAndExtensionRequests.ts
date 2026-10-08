import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Issue #473 — investor accreditation acknowledgement history.
 * Issue #477 — invoice funding deadline extension requests.
 */
export class AddInvestorAckAndExtensionRequests1732800000000 implements MigrationInterface {
  name = "AddInvestorAckAndExtensionRequests1732800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "investor_acknowledgements" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "wallet_address" varchar(56) NOT NULL,
        "user_id" uuid,
        "terms_version" varchar(64) NOT NULL,
        "acknowledged_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_investor_acknowledgements_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_investor_ack_wallet_created"
      ON "investor_acknowledgements" ("wallet_address", "created_at");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_investor_ack_wallet_version"
      ON "investor_acknowledgements" ("wallet_address", "terms_version");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "extension_request_status_enum" AS ENUM ('pending', 'approved', 'rejected');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "invoice_extension_requests" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "invoice_id" uuid NOT NULL,
        "requested_by" uuid NOT NULL,
        "proposed_deadline" TIMESTAMP WITH TIME ZONE NOT NULL,
        "previous_deadline" TIMESTAMP WITH TIME ZONE,
        "reason" text,
        "status" "extension_request_status_enum" NOT NULL DEFAULT 'pending',
        "reviewed_by" varchar(128),
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        "review_note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_invoice_extension_requests_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_invoice_extension_requests_invoice_id"
          FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_extension_requests_invoice_status"
      ON "invoice_extension_requests" ("invoice_id", "status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_extension_requests_invoice_status";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invoice_extension_requests";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "extension_request_status_enum";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_investor_ack_wallet_version";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_investor_ack_wallet_created";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "investor_acknowledgements";`);
  }
}
