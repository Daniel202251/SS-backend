import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Server-side record of a wallet's onboarding progress.
 *
 * One row per wallet. The client reads `tourCompleted` on app load to decide
 * whether to show the tour, so the state has to survive a reinstall and be
 * shared across the wallet's devices.
 */
@Entity("onboarding_progress")
export class OnboardingProgress {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Stellar wallet address the progress belongs to. */
  @Column({ name: "wallet_address", type: "varchar", length: 56, unique: true })
  @Index("idx_onboarding_progress_wallet_address", { unique: true })
  walletAddress!: string;

  /** Whether the wallet has finished the onboarding tour. */
  @Column({ name: "tour_completed", type: "boolean", default: false })
  tourCompleted!: boolean;

  /** When the tour was marked complete; null while it is still pending. */
  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
