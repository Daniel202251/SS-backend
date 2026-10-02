import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Append-only record of an investor acknowledging accreditation terms.
 * Issue #473 — history is retained for audit; "current" acknowledgement is
 * the latest row whose termsVersion matches TERMS_VERSION.
 */
@Entity("investor_acknowledgements")
@Index("idx_investor_ack_wallet_created", ["walletAddress", "createdAt"])
@Index("idx_investor_ack_wallet_version", ["walletAddress", "termsVersion"])
export class InvestorAcknowledgement {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Stellar wallet that acknowledged. */
  @Column({ name: "wallet_address", type: "varchar", length: 56 })
  walletAddress!: string;

  /** Authenticated user id at acknowledgement time (nullable for wallet-only flows). */
  @Column({ name: "user_id", type: "uuid", nullable: true })
  userId!: string | null;

  /** Terms document version that was acknowledged (from TERMS_VERSION). */
  @Column({ name: "terms_version", type: "varchar", length: 64 })
  termsVersion!: string;

  @CreateDateColumn({ name: "acknowledged_at", type: "timestamptz" })
  acknowledgedAt!: Date;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
