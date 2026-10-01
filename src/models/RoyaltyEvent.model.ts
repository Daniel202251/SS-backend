import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Stores indexed RoyaltyPaid on-chain events.
 * Used to compute platform-wide royalty analytics (total royalties, top earners, per-key volume).
 */
@Entity("royalty_events")
@Index("idx_royalty_events_creator_wallet", ["creatorWallet"])
@Index("idx_royalty_events_key_address", ["keyAddress"])
@Index("idx_royalty_events_paid_at", ["paidAt"])
export class RoyaltyEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** The key for which royalty was paid */
  @Column({ name: "key_address", type: "varchar", length: 128 })
  keyAddress!: string;

  /** The creator / rights-holder who received the royalty */
  @Column({ name: "creator_wallet", type: "varchar", length: 56 })
  creatorWallet!: string;

  /** The buyer / payer wallet address */
  @Column({ name: "buyer_wallet", type: "varchar", length: 56, nullable: true })
  buyerWallet!: string | null;

  /** Amount of royalty paid (in platform currency units) */
  @Column({ name: "amount", type: "decimal", precision: 18, scale: 4 })
  amount!: string;

  /** On-chain transaction hash for this royalty payment */
  @Column({ name: "tx_hash", type: "varchar", length: 64, nullable: true })
  @Index("idx_royalty_events_tx_hash")
  txHash!: string | null;

  /** Ledger sequence this event was emitted in */
  @Column({ name: "ledger_sequence", type: "bigint", nullable: true })
  ledgerSequence!: string | null;

  /** When the royalty was paid (from on-chain data or ingestion time) */
  @Column({ name: "paid_at", type: "timestamptz", nullable: true })
  paidAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
