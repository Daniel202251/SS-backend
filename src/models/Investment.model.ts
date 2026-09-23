import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
  VersionColumn,
} from "typeorm";
import { InvestmentStatus } from "../types/enums";
import type { User } from "./User.model";
import type { Invoice } from "./Invoice.model";

@Entity("investments")
export class Investment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  @Index("idx_investments_invoice_id")
  invoiceId!: string;

  @Column({ name: "investor_id", type: "uuid" })
  @Index("idx_investments_investor_id")
  investorId!: string;

  @Column({ name: "investment_amount", type: "decimal", precision: 18, scale: 4 })
  investmentAmount!: string;

  @Column({ name: "expected_return", type: "decimal", precision: 18, scale: 4 })
  expectedReturn!: string;

  @Column({ name: "actual_return", type: "decimal", precision: 18, scale: 4, nullable: true })
  actualReturn!: string | null;

  @Column({
    type: "enum",
    enum: InvestmentStatus,
    default: InvestmentStatus.PENDING,
  })
  @Index("idx_investments_status")
  status!: InvestmentStatus;

  @Column({ name: "transaction_hash", type: "varchar", length: 64, nullable: true })
  transactionHash!: string | null;

  @Column({ name: "stellar_operation_index", type: "integer", nullable: true })
  stellarOperationIndex!: number | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at" })
  deletedAt!: Date | null;

  @VersionColumn()
  version!: number;

  @ManyToOne("Invoice", "investments", { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoice_id" })
  invoice!: Invoice;

  @ManyToOne("User", "investments", { onDelete: "CASCADE" })
  @JoinColumn({ name: "investor_id" })
  investor!: User;

  @OneToMany("Transaction", "investment")
  transactions!: import("./Transaction.model").Transaction[];
}
