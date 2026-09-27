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

  /** On-chain key address / identifier */
  @Column({ name: "key_address", type: "varchar", length: 128, unique: true })
  @Index("idx_creator_keys_key_address", { unique: true })
  keyAddress!: string;

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
