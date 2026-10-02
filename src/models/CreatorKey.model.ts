import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Represents a creator's key that can be rated by holders.
 * Each creator key tracks aggregate ratings metadata for leaderboard ranking.
 */
@Entity("creator_keys")
export class CreatorKey {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Internal id of the creator account that owns this key */
  @Column({ name: "creator_id", type: "varchar", length: 128 })
  @Index("idx_creator_keys_creator_id")
  creatorId!: string;

  /** On-chain key address / identifier */
  @Column({ name: "key_address", type: "varchar", length: 128, unique: true })
  @Index("idx_creator_keys_key_address", { unique: true })
  keyAddress!: string;

  /** Deployed Soroban contract backing this key */
  @Column({ name: "contract_address", type: "varchar", length: 56, unique: true })
  @Index("idx_creator_keys_contract_address", { unique: true })
  contractAddress!: string;

  /** Max tokens a single buy may purchase (issue #542) */
  @Column({ name: "max_buy_per_tx", type: "decimal", precision: 30, scale: 7, default: 0 })
  maxBuyPerTx!: string;

  /** Max tokens that may be bought per day (issue #542) */
  @Column({ name: "max_buy_per_day", type: "decimal", precision: 30, scale: 7, default: 0 })
  maxBuyPerDay!: string;

  /** Supply burned so far on the key's bonding curve */
  @Column({ name: "current_supply", type: "decimal", precision: 30, scale: 7, default: 0 })
  currentSupply!: string;

  /** Bonding curve the key currently uses */
  @Column({ name: "curve_type", type: "varchar", length: 32, default: "constant_product" })
  curveType!: string;

  /** Monotonic counter bumped on every synced config change */
  @Column({ name: "config_version", type: "integer", default: 0 })
  configVersion!: number;

  /** False once the key is retired on chain */
  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  /** Stellar address of the key creator */
  @Column({ name: "creator_wallet", type: "varchar", length: 56 })
  @Index("idx_creator_keys_creator_wallet")
  creatorWallet!: string;

  /** Human-readable name for the key */
  @Column({ name: "name", type: "varchar", length: 255, nullable: true })
  name!: string | null;

  /** Optional description of the key */
  @Column({ name: "description", type: "text", nullable: true })
  description!: string | null;

  /** Image / avatar URL for the key */
  @Column({ name: "image_url", type: "varchar", length: 512, nullable: true })
  imageUrl!: string | null;

  /** Total number of ratings received */
  @Column({ name: "rating_count", type: "integer", default: 0 })
  @Index("idx_creator_keys_rating_count")
  ratingCount!: number;

  /** Sum of all ratings (used to compute average without a full scan) */
  @Column({ name: "rating_sum", type: "decimal", precision: 18, scale: 4, default: 0 })
  ratingSum!: string;

  /** Cached average rating, updated on each new rating */
  @Column({ name: "average_rating", type: "decimal", precision: 5, scale: 4, default: 0 })
  @Index("idx_creator_keys_average_rating")
  averageRating!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
