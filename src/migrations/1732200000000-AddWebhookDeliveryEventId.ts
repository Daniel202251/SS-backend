import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWebhookDeliveryEventId1732200000000 implements MigrationInterface {
  name = "AddWebhookDeliveryEventId1732200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_delivery_logs" ADD "event_id" character varying(200)`
    );
    await queryRunner.query(
      `CREATE INDEX "idx_webhook_delivery_logs_event_id" ON "webhook_delivery_logs" ("event_id")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_webhook_delivery_logs_event_id"`);
    await queryRunner.query(`ALTER TABLE "webhook_delivery_logs" DROP COLUMN "event_id"`);
  }
}
