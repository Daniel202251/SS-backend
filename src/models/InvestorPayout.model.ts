import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  VersionColumn,
} from "typeorm";
import { Invoice } from "./Invoice.model";
import { User } from "./User.model";
import { Investment } from "./Investment.model";

export enum InvestorPayoutStatus {
  PENDING = "pending",
  COMPLETED = "completed",
  FAILED = "failed",
}

@Entity("investor_payouts")
@Index("idx_investor_payouts_invoice_id", ["invoiceId"])
@Index("idx_investor_payouts_investor_id", ["investorId"])
@Index("idx_investor_payouts_investment_id", ["investmentId"])
@Index("idx_investor_payouts_status", ["status"])
export class InvestorPayout {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  invoiceId!: string;

  @Column({ name: "investor_id", type: "uuid" })
  investorId!: string;

  @Column({ name: "investment_id", type: "uuid" })
  investmentId!: string;

  @Column({ name: "amount", type: "decimal", precision: 18, scale: 4 })
  amount!: string;

  @Column({ name: "stellar_tx_hash", type: "varchar", length: 64, nullable: true })
  stellarTxHash!: string | null;

  @Column({
    name: "status",
    type: "enum",
    enum: InvestorPayoutStatus,
    default: InvestorPayoutStatus.PENDING,
  })
  status!: InvestorPayoutStatus;

  @Column({ name: "failure_reason", type: "text", nullable: true })
  failureReason!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at" })
  deletedAt!: Date | null;

  @VersionColumn()
  version!: number;

  @ManyToOne(() => Invoice, { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoice_id" })
  invoice!: Invoice;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "investor_id" })
  investor!: User;

  @ManyToOne(() => Investment, { onDelete: "CASCADE" })
  @JoinColumn({ name: "investment_id" })
  investment!: Investment;
}