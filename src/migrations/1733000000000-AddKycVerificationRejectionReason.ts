import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddKycVerificationRejectionReason1733000000000 implements MigrationInterface {
  name = "AddKycVerificationRejectionReason1733000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "kyc_verifications"
      ADD COLUMN IF NOT EXISTS "rejection_reason" text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "kyc_verifications"
      DROP COLUMN IF EXISTS "rejection_reason";
    `);
  }
}
