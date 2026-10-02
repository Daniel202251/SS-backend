import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("auth_challenges")
@Index("idx_auth_challenges_address_nonce", ["stellarAddress", "nonceHash"], {
  unique: true,
})
export class AuthChallenge {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "stellar_address", type: "varchar", length: 56 })
  @Index("idx_auth_challenges_stellar_address")
  stellarAddress!: string;

  @Column({ name: "nonce_hash", type: "varchar", length: 64 })
  nonceHash!: string;

  @Column({ type: "text" })
  message!: string;

  @Column({ type: "varchar", length: 32 })
  network!: string;

  @Column({ name: "issued_at", type: "timestamptz" })
  issuedAt!: Date;

  @Column({ name: "expires_at", type: "timestamptz" })
  @Index("idx_auth_challenges_expires_at")
  expiresAt!: Date;

  @Column({ name: "consumed_at", type: "timestamptz", nullable: true })
  consumedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
