import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export enum DistributionTrigger {
  SCHEDULED = "scheduled",
  MANUAL = "manual",
}

/**
 * Stores historical dividend distribution records per issuer.
 * Used for the distribution history endpoint with cursor pagination.
 */
@Entity("dividend_distributions")
@Index("idx_dividend_distributions_issuer_wallet", ["issuerWallet"])
@Index("idx_dividend_distributions_distributed_at", ["distributedAt"])
export class DividendDistribution {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Stellar wallet address of the invoice issuer */
  @Column({ name: "issuer_wallet", type: "varchar", length: 56 })
  issuerWallet!: string;

  /** Total amount distributed in this cycle */
  @Column({ name: "total_amount", type: "decimal", precision: 18, scale: 4, default: 0 })
  totalAmount!: string;

  /** Number of recipients in this distribution */
  @Column({ name: "recipient_count", type: "integer", default: 0 })
  recipientCount!: number;

  /** Whether this was a manual or scheduled trigger */
  @Column({
    name: "trigger",
    type: "varchar",
    length: 20,
    default: DistributionTrigger.SCHEDULED,
  })
  trigger!: DistributionTrigger;

  /** On-chain transaction hash for the distribution (if applicable) */
  @Column({ name: "tx_hash", type: "varchar", length: 64, nullable: true })
  txHash!: string | null;

  /** Snapshot of cycle frequency at time of distribution */
  @Column({ name: "cycle_frequency", type: "varchar", length: 20, nullable: true })
  cycleFrequency!: string | null;

  /** Status: "success" | "failed" | "pending" */
  @Column({ name: "status", type: "varchar", length: 20, default: "success" })
  status!: string;

  /** When this distribution was executed */
  @Column({ name: "distributed_at", type: "timestamptz" })
  distributedAt!: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
