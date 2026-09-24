import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { InvoiceStatus } from "../types/enums";

export type InvoiceTransitionActorRole = "seller" | "admin" | "system";

/**
 * Append-only audit trail of invoice status changes, written in the same
 * transaction as the status update itself so the two can never disagree.
 */
@Entity("invoice_status_history")
@Index("idx_invoice_status_history_invoice_created", ["invoiceId", "createdAt"])
export class InvoiceStatusHistory {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  invoiceId!: string;

  @Column({ name: "from_status", type: "varchar", length: 32 })
  fromStatus!: InvoiceStatus;

  @Column({ name: "to_status", type: "varchar", length: 32 })
  toStatus!: InvoiceStatus;

  @Column({ name: "actor_role", type: "varchar", length: 16 })
  actorRole!: InvoiceTransitionActorRole;

  /** User id or wallet of whoever triggered the change; null for system jobs. */
  @Column({ name: "actor_id", type: "varchar", length: 64, nullable: true })
  actorId!: string | null;

  /** Machine-readable cause, e.g. "fully_funded" or "admin_rejected". */
  @Column({ type: "varchar", length: 32 })
  trigger!: string;

  /** Free-text explanation supplied with the change (e.g. a rejection reason). */
  @Column({ type: "text", nullable: true })
  reason!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
