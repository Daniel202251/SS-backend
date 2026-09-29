import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import type { Invoice } from "./Invoice.model";
import type { Investment } from "./Investment.model";
import type { User } from "./User.model";

@Entity("investor_returns")
@Index("idx_investor_returns_invoice_id", ["invoiceId"])
@Index("idx_investor_returns_investment_id", ["investmentId"])
@Index("idx_investor_returns_investor_id", ["investorId"])
export class InvestorReturn {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  invoiceId!: string;

  @Column({ name: "investment_id", type: "uuid" })
  investmentId!: string;

  @Column({ name: "investor_id", type: "uuid" })
  investorId!: string;

  @Column({ name: "return_amount", type: "decimal", precision: 18, scale: 4 })
  returnAmount!: string;

  @Column({ type: "decimal", precision: 18, scale: 4 })
  amount!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @ManyToOne("Invoice", { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoice_id" })
  invoice!: Invoice;

  @ManyToOne("Investment", { onDelete: "CASCADE" })
  @JoinColumn({ name: "investment_id" })
  investment!: Investment;

  @ManyToOne("User", { onDelete: "CASCADE" })
  @JoinColumn({ name: "investor_id" })
  investor!: User;
}
