import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index, CreateDateColumn } from "typeorm";
import { NotificationType } from "../types/enums";

@Entity("notifications")
export class Notification {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  @Index("idx_notifications_user_id")
  userId!: string;

  @Column({
    type: "varchar",
    length: 64,
  })
  @Index("idx_notifications_type")
  type!: NotificationType;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "text" })
  message!: string;

  @Column({ type: "jsonb", nullable: true })
  data!: Record<string, unknown> | null;

  @Column({ type: "boolean", default: false })
  read!: boolean;

  /**
   * `<eventId>:<userId>` for notifications from the lifecycle dispatcher;
   * unique, so one event can never notify the same user twice.
   */
  @Column({ name: "dedupe_key", type: "varchar", length: 255, nullable: true })
  @Index("uq_notifications_dedupe_key", { unique: true })
  dedupeKey!: string | null;

  @Column({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  timestamp!: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @ManyToOne("User", "notifications", { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: import("./User.model").User;
}
