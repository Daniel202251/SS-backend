import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export enum DividendCycleFrequency {
  WEEKLY = "weekly",
  MONTHLY = "monthly",
  QUARTERLY = "quarterly",
}

/**
 * Stores the dividend distribution cycle configuration for each invoice issuer.
 * One row per issuer wallet. Contains frequency settings and the next scheduled date.
 */
@Entity("dividend_cycle_configs")
export class DividendCycleConfig {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Stellar wallet address of the invoice issuer */
  @Column({ name: "issuer_wallet", type: "varchar", length: 56, unique: true })
  @Index("idx_dividend_cycle_configs_issuer_wallet", { unique: true })
  issuerWallet!: string;

  /** Distribution frequency */
  @Column({
    name: "frequency",
    type: "varchar",
    length: 20,
    default: DividendCycleFrequency.MONTHLY,
  })
  frequency!: DividendCycleFrequency;

  /** Next scheduled distribution date (UTC) */
  @Column({ name: "next_distribution_at", type: "timestamptz", nullable: true })
  nextDistributionAt!: Date | null;

  /** Last distribution date */
  @Column({ name: "last_distribution_at", type: "timestamptz", nullable: true })
  lastDistributionAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
