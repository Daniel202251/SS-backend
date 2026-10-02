import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from "typeorm";
import { logger } from "../observability/logger";
import { AppError } from "../utils/http-error";

const MIGRATION_NAME = "AddKycVerificationWallet1732700000000";

export class AddKycVerificationWallet1732700000000 implements MigrationInterface {
  name = MIGRATION_NAME;

  public async up(queryRunner: QueryRunner): Promise<void> {
    try {
      logger.info("migration.start", { name: MIGRATION_NAME, direction: "up" });
      await queryRunner.addColumn(
        "kyc_verifications",
        new TableColumn({
          name: "wallet",
          type: "varchar",
          length: "56",
          isNullable: true,
        }),
      );
      await queryRunner.createIndex(
        "kyc_verifications",
        new TableIndex({
          name: "idx_kyc_verifications_wallet",
          columnNames: ["wallet"],
        }),
      );
      logger.info("migration.complete", { name: MIGRATION_NAME, direction: "up" });
    } catch (error) {
      logger.error("migration.failed", {
        name: MIGRATION_NAME,
        direction: "up",
        error,
      });
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError(
        500,
        `Migration "${MIGRATION_NAME}" failed: ${message}`,
        "MIGRATION_FAILED",
        { name: MIGRATION_NAME },
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    try {
      logger.info("migration.start", { name: MIGRATION_NAME, direction: "down" });
      await queryRunner.dropIndex("kyc_verifications", "idx_kyc_verifications_wallet");
      await queryRunner.dropColumn("kyc_verifications", "wallet");
      logger.info("migration.complete", { name: MIGRATION_NAME, direction: "down" });
    } catch (error) {
      logger.error("migration.failed", {
        name: MIGRATION_NAME,
        direction: "down",
        error,
      });
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError(
        500,
        `Migration "${MIGRATION_NAME}" failed: ${message}`,
        "MIGRATION_FAILED",
        { name: MIGRATION_NAME },
      );
    }
  }
}
