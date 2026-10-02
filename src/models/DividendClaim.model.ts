import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * A dividend payout a holder has claimed against a distribution cycle.
 *
 * Written from `DividendClaimed` contract events, so `tx_hash` is the
 * transaction that moved the funds to the holder's wallet.
 */
@Entity("dividend_claims")
@Index("idx_dividend_claims_recipient_wallet", ["recipientWallet"])
@Index("idx_dividend_claims_claimed_at", ["claimedAt"])
export class DividendClaim {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Stable on-chain identifier for the claim; the idempotency key. */
  @Column({ name: "claim_id", type: "varchar", length: 128, unique: true })
  @Index("idx_dividend_claims_claim_id", { unique: true })
  claimId!: string;

  /** `dividend_allocations.distribution_id` this claim settles. */
  @Column({ name: "distribution_id", type: "uuid", nullable: true })
  distributionId!: string | null;

  /** Issuer of the invoice whose dividend was claimed. */
  @Column({ name: "issuer_wallet", type: "varchar", length: 56, nullable: true })
  issuerWallet!: string | null;

  /** Holder that claimed the dividend. */
  @Column({ name: "recipient_wallet", type: "varchar", length: 56 })
  recipientWallet!: string;

  /** Claimed amount, in platform currency units. */
  @Column({ name: "amount", type: "decimal", precision: 18, scale: 4, default: 0 })
  amount!: string;

  /** Cycle frequency at the time of the claim. */
  @Column({ name: "cycle_frequency", type: "varchar", length: 20, nullable: true })
  cycleFrequency!: string | null;

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
