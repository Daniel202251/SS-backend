import { MigrationInterface, QueryRunner, Table, TableIndex } from "typeorm";

export class CreateInvestorPayoutsTable1737500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "investor_payouts",
        columns: [
          {
            name: "id",
            type: "uuid",
            isPrimary: true,
            generationStrategy: "uuid",
            default: "uuid_generate_v4()",
          },
          {
            name: "invoice_id",
            type: "uuid",
            isNullable: false,
          },
          {
            name: "investor_id",
            type: "uuid",
            isNullable: false,
          },
          {
            name: "investment_id",
            type: "uuid",
            isNullable: false,
          },
          {
            name: "amount",
            type: "decimal",
            precision: 18,
            scale: 4,
            isNullable: false,
          },
          {
            name: "stellar_tx_hash",
            type: "varchar",
            length: "64",
            isNullable: true,
          },
          {
            name: "status",
            type: "enum",
            enum: ["pending", "completed", "failed"],
            default: "'pending'",
            isNullable: false,
          },
          {
            name: "failure_reason",
            type: "text",
            isNullable: true,
          },
          {
            name: "created_at",
            type: "timestamptz",
            default: "now()",
            isNullable: false,
          },
          {
            name: "updated_at",
            type: "timestamptz",
            default: "now()",
            isNullable: false,
          },
          {
            name: "deleted_at",
            type: "timestamptz",
            isNullable: true,
          },
          {
            name: "version",
            type: "int",
            default: 1,
            isNullable: false,
          },
        ],
      }),
      true
    );

    await queryRunner.createIndex(
      "investor_payouts",
      new TableIndex({
        name: "idx_investor_payouts_invoice_id",
        columnNames: ["invoice_id"],
      })
    );

    await queryRunner.createIndex(
      "investor_payouts",
      new TableIndex({
        name: "idx_investor_payouts_investor_id",
        columnNames: ["investor_id"],
      })
    );

    await queryRunner.createIndex(
      "investor_payouts",
      new TableIndex({
        name: "idx_investor_payouts_investment_id",
        columnNames: ["investment_id"],
      })
    );

    await queryRunner.createIndex(
      "investor_payouts",
      new TableIndex({
        name: "idx_investor_payouts_status",
        columnNames: ["status"],
      })
    );

    await queryRunner.query(`
      ALTER TABLE "investor_payouts"
      ADD CONSTRAINT "fk_investor_payouts_invoice_id"
      FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "investor_payouts"
      ADD CONSTRAINT "fk_investor_payouts_investor_id"
      FOREIGN KEY ("investor_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "investor_payouts"
      ADD CONSTRAINT "fk_investor_payouts_investment_id"
      FOREIGN KEY ("investment_id") REFERENCES "investments"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("investor_payouts");
  }
}