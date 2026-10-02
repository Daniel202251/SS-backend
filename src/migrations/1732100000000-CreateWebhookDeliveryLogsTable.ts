import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateWebhookDeliveryLogsTable1732100000000 implements MigrationInterface {
  name = "CreateWebhookDeliveryLogsTable1732100000000";
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "webhook_delivery_logs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "subscription_id" uuid NOT NULL, "event_type" character varying(100) NOT NULL, "attempt" integer NOT NULL, "response_status" integer, "delivered" boolean NOT NULL, "error_message" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_webhook_delivery_logs" PRIMARY KEY ("id"), CONSTRAINT "FK_webhook_delivery_logs_subscription" FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE);`
    );
    await queryRunner.query(
      `CREATE INDEX "idx_webhook_delivery_logs_subscription_id" ON "webhook_delivery_logs" ("subscription_id")`
    );
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_webhook_delivery_logs_subscription_id"`);
    await queryRunner.query(`DROP TABLE "webhook_delivery_logs"`);
  }
}
