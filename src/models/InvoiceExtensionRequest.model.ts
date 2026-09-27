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
import { ExtensionRequestStatus } from "../types/enums";
import type { Invoice } from "./Invoice.model";

/**
 * Seller-requested funding deadline extension, gated by admin approval.
 * Issue #477 — at most one pending request per invoice.
 */
@Entity("invoice_extension_requests")
@Index("idx_extension_requests_invoice_status", ["invoiceId", "status"])
export class InvoiceExtensionRequest {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  invoiceId!: string;

  @Column({ name: "requested_by", type: "uuid" })
  requestedBy!: string;

  @Column({ name: "proposed_deadline", type: "timestamptz" })
  proposedDeadline!: Date;

  @Column({ name: "previous_deadline", type: "timestamptz", nullable: true })
  previousDeadline!: Date | null;

  @Column({ type: "text", nullable: true })
  reason!: string | null;

  @Column({
    type: "enum",
    enum: ExtensionRequestStatus,
    enumName: "extension_request_status_enum",
    default: ExtensionRequestStatus.PENDING,
  })
  status!: ExtensionRequestStatus;

  @Column({ name: "reviewed_by", type: "varchar", length: 128, nullable: true })
  reviewedBy!: string | null;

  @Column({ name: "reviewed_at", type: "timestamptz", nullable: true })
  reviewedAt!: Date | null;

  @Column({ name: "review_note", type: "text", nullable: true })
  reviewNote!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;

  @ManyToOne("Invoice", { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoice_id" })
  invoice!: Invoice;
}
