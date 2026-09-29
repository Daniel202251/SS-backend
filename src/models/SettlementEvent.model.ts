import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("settlement_events")
export class SettlementEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "wallet_address", type: "varchar", length: 64 })
  @Index("idx_settlement_events_wallet")
  walletAddress!: string;

  @Column({ name: "user_id", type: "varchar", length: 64, nullable: true })
  @Index("idx_settlement_events_user_id")
  userId!: string | null;

  @Column({ type: "varchar", length: 64 })
  type!: string;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "text" })
  message!: string;

  @Column({ type: "boolean", default: false })
  read!: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
