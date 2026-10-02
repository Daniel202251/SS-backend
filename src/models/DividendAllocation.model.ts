import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * One holder's share of a single dividend distribution.
 *
 * Written from `DividendDistributed` contract events, which enumerate the
 * per-wallet allocation alongside the cycle total. `allocation_id` is unique so
 * replaying an event cannot pay a wallet twice.
 */
@Entity("dividend_allocations")
@Index("idx_dividend_allocations_recipient_wallet", ["recipientWallet"])
@Index("idx_dividend_allocations_distribution", ["distributionId"])
export class DividendAllocation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Stable on-chain identifier for this allocation; the idempotency key. */
  @Column({ name: "allocation_id", type: "varchar", length: 128, unique: true })
  @Index("idx_dividend_allocations_allocation_id", { unique: true })
  allocationId!: string;

  /** `dividend_distributions.id` for the cycle this allocation belongs to. */
  @Column({ name: "distribution_id", type: "uuid", nullable: true })
  distributionId!: string | null;

  /** Issuer of the invoice whose holders received the dividend. */
  @Column({ name: "issuer_wallet", type: "varchar", length: 56 })
  issuerWallet!: string;

  /** Holder entitled to this allocation. */
  @Column({ name: "recipient_wallet", type: "varchar", length: 56 })
  recipientWallet!: string;

  /** Allocated amount, in platform currency units. */
  @Column({ name: "amount", type: "decimal", precision: 18, scale: 4, default: 0 })
  amount!: string;

  /** Cycle frequency at the time of the distribution. */
  @Column({ name: "cycle_frequency", type: "varchar", length: 20, nullable: true })
  cycleFrequency!: string | null;

  /** On-chain transaction hash of the distribution. */
  @Column({ name: "tx_hash", type: "varchar", length: 64, nullable: true })
  txHash!: string | null;

  /** Ledger sequence the distribution was emitted in. */
  @Column({ name: "ledger_sequence", type: "bigint", nullable: true })
  ledgerSequence!: string | null;

  /** When the distribution was executed on-chain. */
  @Column({ name: "distributed_at", type: "timestamptz", nullable: true })
  distributedAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
