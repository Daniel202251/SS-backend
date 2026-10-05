import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("soroban_event_logs")
@Index("uq_soroban_event_logs_contract_event", ["contractId", "eventId"], { unique: true })
export class SorobanEventLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "contract_id", type: "varchar", length: 56 })
  contractId!: string;

  @Column({ name: "event_id", type: "varchar", length: 255, nullable: true })
  eventId!: string | null;

  @Column({ name: "ledger_sequence", type: "bigint" })
  ledgerSequence!: string;

  @Column({ type: "varchar", length: 64 })
  topic!: string;

  @Column({ name: "tx_hash", type: "varchar", length: 64 })
  txHash!: string;

  @Column({ type: "jsonb", nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: "boolean", default: false })
  @Index("idx_soroban_event_logs_processed")
  processed!: boolean;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
