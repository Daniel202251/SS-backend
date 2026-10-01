import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export type UserAuditAction = "role_updated" | "suspended" | "unsuspended";

/**
 * Append-only audit trail of admin changes to user accounts (role and
 * suspension), written in the same transaction as the change itself.
 */
@Entity("user_audit_logs")
@Index("idx_user_audit_logs_target_created", ["targetUserId", "createdAt"])
export class UserAuditLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "target_user_id", type: "uuid" })
  targetUserId!: string;

  @Column({ name: "actor_user_id", type: "uuid" })
  actorUserId!: string;

  @Column({ type: "varchar", length: 32 })
  action!: UserAuditAction;

  /** Previous value: the old role, or "active"/"suspended". */
  @Column({ name: "previous_value", type: "varchar", length: 32 })
  previousValue!: string;

  @Column({ name: "new_value", type: "varchar", length: 32 })
  newValue!: string;

  @Column({ type: "text", nullable: true })
  reason!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
