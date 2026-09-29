import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Stores a royalty payout that a creator has claimed from accrued earnings.
 *
 * Rows are created from `RoyaltyClaimed` contract events, so `tx_hash` is the
 * on-chain transaction that moved the funds. One row per claim keeps the
 * `royalty_claims.claim_id` unique, which makes replaying the same event a
 * no-op.
 */
@Entity("royalty_claims")
@Index("idx_royalty_claims_creator_wallet", ["creatorWallet"])
@Index("idx_royalty_claims_claimed_at", ["claimedAt"])
export class RoyaltyClaim {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Stable on-chain identifier for the claim; guards against duplicate ingestion. */
  @Column({ name: "claim_id", type: "varchar", length: 128, unique: true })
  @Index("idx_royalty_claims_claim_id", { unique: true })
  claimId!: string;

  /** The key whose royalties were claimed. */
  @Column({ name: "key_address", type: "varchar", length: 128, nullable: true })
  keyAddress!: string | null;

  /** The creator / rights-holder that claimed the royalties. */
  @Column({ name: "creator_wallet", type: "varchar", length: 56 })
  creatorWallet!: string;

  /** Amount claimed, in platform currency units. */
  @Column({ name: "amount", type: "decimal", precision: 18, scale: 4, default: 0 })
  amount!: string;

  /** On-chain transaction hash of the claim. */
  @Column({ name: "tx_hash", type: "varchar", length: 64, nullable: true })
  txHash!: string | null;

  /** Ledger sequence the claim was emitted in. */
  @Column({ name: "ledger_sequence", type: "bigint", nullable: true })
  ledgerSequence!: string | null;

  /** When the claim landed on-chain. */
  @Column({ name: "claimed_at", type: "timestamptz", nullable: true })
  claimedAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
