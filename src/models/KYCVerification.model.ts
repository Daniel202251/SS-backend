import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from "typeorm";
import { KYCStatus, KYCVerificationType } from "../types/enums";

@Entity("kyc_verifications")
export class KYCVerification {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  @Index("idx_kyc_verifications_user_id")
  userId!: string;

  @Column({
    name: "verification_type",
    type: "enum",
    enum: KYCVerificationType,
  })
  @Index("idx_kyc_verifications_type")
  verificationType!: KYCVerificationType;

  @Column({
    type: "enum",
    enum: KYCStatus,
    default: KYCStatus.PENDING,
  })
  @Index("idx_kyc_verifications_status")
  status!: KYCStatus;

  @Column({ type: "jsonb", nullable: true })
  documents!: Record<string, unknown> | null;

  @Column({ name: "rejection_reason", type: "text", nullable: true })
  rejectionReason!: string | null;

  @Column({ name: "verified_at", type: "timestamptz", nullable: true })
  verifiedAt!: Date | null;

  @ManyToOne("User", "kycVerifications", { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: import("./User.model").User;
}
