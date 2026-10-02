import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateWebhookSubscriptionsTable1712000000000 implements MigrationInterface {
  name = "CreateWebhookSubscriptionsTable1712000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "webhook_subscriptions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "url" character varying(255) NOT NULL,
        "secret" character varying(64) NOT NULL,
        "event_types" jsonb NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_subscriptions" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_webhook_subscriptions_user_id"
      ON "webhook_subscriptions" ("user_id");
    `);

    await queryRunner.query(`
      ALTER TABLE "webhook_subscriptions"
      ADD CONSTRAINT "FK_webhook_subscriptions_user"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "webhook_subscriptions"
      DROP CONSTRAINT "FK_webhook_subscriptions_user";
    `);

    await queryRunner.query(`
      DROP INDEX "public"."idx_webhook_subscriptions_user_id";
    `);

    await queryRunner.query(`DROP TABLE "webhook_subscriptions"`);
  }
}
