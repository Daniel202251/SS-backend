import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOptimisticLockVersionColumns1711000000000 implements MigrationInterface {
  name = "AddOptimisticLockVersionColumns1711000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "invoices" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
    `);

    await queryRunner.query(`
      ALTER TABLE "investments" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "investments" DROP COLUMN IF EXISTS "version";
    `);

    await queryRunner.query(`
      ALTER TABLE "invoices" DROP COLUMN IF EXISTS "version";
    `);
  }
}