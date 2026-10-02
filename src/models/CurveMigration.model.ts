import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type CurveMigrationStatus = "pending" | "executed" | "expired";

/**
 * A bonding-curve migration proposal for a creator key, plus its execution
 * state. Proposals are surfaced to the creator key management UI so they can
 * show what is waiting on the timelock and what has been applied.
 */
@Entity("curve_migrations")
@Index("idx_curve_migrations_key_id", ["keyId"])
@Index("idx_curve_migrations_proposal_id", ["proposalId"], { unique: true })
export class CurveMigration {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "key_id", type: "uuid" })
  keyId!: string;

  /** On-chain proposal id, used to pair the executed event with its proposal. */
  @Column({ name: "proposal_id", type: "varchar", length: 128 })
  proposalId!: string;

  @Column({ name: "contract_address", type: "varchar", length: 56 })
  contractAddress!: string;

  @Column({ type: "varchar", length: 16, default: "pending" })
  status!: CurveMigrationStatus;

  /** Curve parameters carried by the proposal, as proposed. */
  @Column({ name: "proposed_params", type: "jsonb", default: () => "'{}'::jsonb" })
  proposedParams!: Record<string, unknown>;

  /** Curve parameters actually applied, populated on execution. */
  @Column({ name: "applied_params", type: "jsonb", nullable: true })
  appliedParams!: Record<string, unknown> | null;

  /** When the timelock unlocks and the migration becomes executable. */
  @Column({ name: "timelock_expiry", type: "timestamptz", nullable: true })
  timelockExpiry!: Date | null;

  @Column({ name: "proposed_at", type: "timestamptz" })
  proposedAt!: Date;

  @Column({ name: "executed_at", type: "timestamptz", nullable: true })
  executedAt!: Date | null;

  @Column({ name: "proposal_tx_hash", type: "varchar", length: 64, nullable: true })
  proposalTxHash!: string | null;

  @Column({ name: "execution_tx_hash", type: "varchar", length: 64, nullable: true })
  executionTxHash!: string | null;

  @Column({ name: "ledger_sequence", type: "bigint", nullable: true })
  ledgerSequence!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
