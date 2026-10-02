import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import type { Invoice } from "./Invoice.model";

@Entity("settlement_remainders")
@Index("idx_settlement_remainders_invoice_id", ["invoiceId"])
export class SettlementRemainder {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  invoiceId!: string;

  @Column({ name: "remainder_amount", type: "decimal", precision: 18, scale: 4 })
  remainderAmount!: string;

  @Column({ name: "total_settlement_amount", type: "decimal", precision: 18, scale: 4 })
  totalSettlementAmount!: string;

  @Column({ name: "total_distributed_amount", type: "decimal", precision: 18, scale: 4 })
  totalDistributedAmount!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @ManyToOne("Invoice", { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoice_id" })
  invoice!: Invoice;
}
