import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class AddUserKycVerifiedFlag1731900000001 implements MigrationInterface {
  name = "AddUserKycVerifiedFlag1731900000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      "users",
      new TableColumn({
        name: "is_kyc_verified",
        type: "boolean",
        default: false,
      })
    );
    await queryRunner.query(`
      UPDATE "users"
      SET "is_kyc_verified" = true
      WHERE "kycStatus" = 'approved'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn("users", "is_kyc_verified");
  }
}
