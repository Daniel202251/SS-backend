import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * A direct invoice-for-invoice exchange between two wallets, projected from
 * `AtomicSwapExecuted` contract events. Both sides are stored so either party
 * can look up their own swap history.
 */
@Entity("atomic_swaps")
@Index("idx_atomic_swaps_buyer_address", ["buyerAddress"])
@Index("idx_atomic_swaps_seller_address", ["sellerAddress"])
@Index("idx_atomic_swaps_buyer_created", ["buyerAddress", "createdAt"])
@Index("idx_atomic_swaps_seller_created", ["sellerAddress", "createdAt"])
export class AtomicSwap {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** On-chain swap identifier. */
  @Column({ name: "swap_id", type: "varchar", length: 128 })
  swapId!: string;

  @Column({ name: "buyer_address", type: "varchar", length: 56 })
  buyerAddress!: string;

  @Column({ name: "seller_address", type: "varchar", length: 56 })
  sellerAddress!: string;

  @Column({ name: "buyer_invoice_id", type: "varchar", length: 128, nullable: true })
  buyerInvoiceId!: string | null;

  @Column({ name: "seller_invoice_id", type: "varchar", length: 128, nullable: true })
  sellerInvoiceId!: string | null;

  /** Invoice amount handed over by the buyer. */
  @Column({ name: "buyer_amount", type: "decimal", precision: 30, scale: 7, default: "0" })
  buyerAmount!: string;

  /** Invoice amount handed over by the seller. */
  @Column({ name: "seller_amount", type: "decimal", precision: 30, scale: 7, default: "0" })
  sellerAmount!: string;

  /** Fee charged on the swap, in base units. */
  @Column({ name: "fee_amount", type: "decimal", precision: 30, scale: 7, default: "0" })
  feeAmount!: string;

  @Column({ name: "fee_recipient", type: "varchar", length: 56, nullable: true })
  feeRecipient!: string | null;

  @Column({ name: "tx_hash", type: "varchar", length: 64, nullable: true })
  txHash!: string | null;

  @Column({ name: "ledger_sequence", type: "bigint", nullable: true })
  ledgerSequence!: string | null;

  @Column({ name: "executed_at", type: "timestamptz" })
  executedAt!: Date;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
