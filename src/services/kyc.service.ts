import crypto from "crypto";
import { DataSource, In } from "typeorm";
import { KYCVerification } from "../models/KYCVerification.model";
import { KycHistory } from "../models/KycHistory.model";
import { User } from "../models/User.model";
import { KYCStatus, KYCVerificationType } from "../types/enums";
import { HttpError } from "../utils/http-error";
import { logger, type AppLogger } from "../observability/logger";

export interface KycProviderData {
  verificationType?: KYCVerificationType;
  documents?: Record<string, unknown> | null;
  sellerDetails?: Record<string, unknown> | null;
  seller?: Record<string, unknown> | null;
  providerReference?: string;
}

export interface KycWebhookPayload {
  userId: string;
  status: KYCStatus;
  verificationId?: string;
  providerReference?: string;
  reason?: string;
}

export type KycDocumentType = "passport" | "national_id" | "drivers_license";

export interface KycDocumentSubmission {
  documentType: KycDocumentType;
  documentNumber: string;
  ipfsDocumentUrl: string;
}

/** Statuses that indicate a KYC submission is already in flight or finalized enough to block a new one. */
const PENDING_STATUSES = [KYCStatus.PENDING, KYCStatus.APPROVED];

/** Statuses that allow resubmission (rejected or expired). */
const RESUBMITTABLE_STATUSES = [KYCStatus.REJECTED, KYCStatus.EXPIRED];

export class KycService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly webhookSecret: string,
    private readonly appLogger: AppLogger = logger
  ) {}

  private normalizeDocuments(value: unknown): Record<string, unknown> | null {
    if (value == null) return null;
    if (typeof value !== "object" || Array.isArray(value)) {
      return { value } as Record<string, unknown>;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([, entryValue]) => entryValue !== undefined)
    );
  }

  private buildDocumentPayload(providerData: KycProviderData): Record<string, unknown> | null {
    const payload: Record<string, unknown> = {};

    if (providerData.documents) {
      Object.assign(payload, this.normalizeDocuments(providerData.documents) ?? {});
    }

    const sellerDetails = providerData.sellerDetails ?? providerData.seller;
    if (sellerDetails) {
      payload.seller = this.normalizeDocuments(sellerDetails) ?? sellerDetails;
    }

    if (providerData.providerReference) {
      payload.providerReference = providerData.providerReference;
    }

    return Object.keys(payload).length > 0 ? payload : null;
  }

  async submitKycVerification(
    userId: string,
    providerData: KycProviderData = {}
  ): Promise<KYCVerification> {
    return this.dataSource.transaction(async (manager) => {
      const userRepository = manager.getRepository(User);
      const user = await userRepository.findOneBy({ id: userId });
      if (!user) throw new HttpError(404, "User not found.");

      const repository = manager.getRepository(KYCVerification);
      const verification = repository.create({
        userId,
        verificationType: providerData.verificationType ?? KYCVerificationType.IDENTITY,
        status: KYCStatus.PENDING,
        documents: this.buildDocumentPayload(providerData),
        rejectionReason: null,
      });
      const saved = await repository.save(verification);
      await userRepository.update(userId, {
        kycStatus: KYCStatus.PENDING,
        isKycVerified: false,
      });
      return saved;
    });
  }

  async getKycStatusForUser(userId: string): Promise<KycStatusResponse> {
    const user = await this.dataSource.getRepository(User).findOneBy({ id: userId });
    if (!user) throw new HttpError(404, "User not found.");

    const repository = this.dataSource.getRepository(KYCVerification);
    const [latest] = await repository.find({
      where: { userId },
      order: { verifiedAt: "DESC" },
      take: 1,
    });

    const status = latest?.status ?? user.kycStatus ?? KYCStatus.PENDING;

    return {
      verificationId: latest?.id ?? null,
      status,
      rejectionReason: latest?.rejectionReason ?? null,
      documents: latest?.documents ?? null,
      reviewedAt: latest?.verifiedAt ?? null,
    };
  }

  async reviewKycVerification(
    verificationId: string,
    input: ReviewKycVerificationInput
  ): Promise<KYCVerification> {
    const nextStatus = input.status;
    if (![KYCStatus.APPROVED, KYCStatus.REJECTED].includes(nextStatus)) {
      throw new HttpError(400, "Review status must be approved or rejected.");
    }

    if (nextStatus === KYCStatus.REJECTED) {
      const reason = input.reason?.trim();
      if (!reason) throw new HttpError(400, "Rejection reason is required.");
    }

    return this.dataSource.transaction(async (manager) => {
      const verificationRepository = manager.getRepository(KYCVerification);
      const userRepository = manager.getRepository(User);

      const verification = await verificationRepository.findOne({
        where: { id: verificationId },
        relations: ["user"],
      });
      if (!verification) throw new HttpError(404, "KYC verification not found.");

      verification.status = nextStatus;
      verification.rejectionReason =
        nextStatus === KYCStatus.REJECTED ? input.reason?.trim() ?? null : null;
      verification.verifiedAt = new Date();
      const saved = await verificationRepository.save(verification);

      await userRepository.update(verification.userId, {
        kycStatus: nextStatus,
        isKycVerified: nextStatus === KYCStatus.APPROVED,
      });

      return saved;
    });
  }

  async submitKycVerificationByWallet(
    wallet: string,
    payload: KycDocumentSubmission
  ): Promise<KYCVerification> {
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({
        where: { stellarAddress: wallet },
      });
      if (!user) throw new HttpError(404, "User not found.");

      const repository = manager.getRepository(KYCVerification);
      const existing = await repository.findOne({
        where: {
          wallet,
          status: In(PENDING_STATUSES),
        },
      });
      if (existing) {
        throw new HttpError(
          409,
          "A KYC verification is already pending or approved for this wallet."
        );
      }

      const verification = repository.create({
        userId: user.id,
        wallet,
        verificationType: KYCVerificationType.IDENTITY,
        status: KYCStatus.PENDING,
        documents: {
          documentType: payload.documentType,
          documentNumber: payload.documentNumber,
          ipfsDocumentUrl: payload.ipfsDocumentUrl,
        },
      });
      const saved = await repository.save(verification);

      await manager
        .getRepository(User)
        .update(user.id, { kycStatus: KYCStatus.PENDING, isKycVerified: false });

      this.appLogger.info("kyc.submission.created", {
        user_id: user.id,
        wallet,
        document_type: payload.documentType,
        verification_id: saved.id,
      });

      return saved;
    });
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature || !this.webhookSecret) return false;
    const supplied = signature.replace(/^sha256=/, "");
    const expected = crypto.createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    const suppliedBuffer = Buffer.from(supplied, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    return (
      suppliedBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
    );
  }

  async processWebhook(payload: KycWebhookPayload): Promise<void> {
    if (!payload || typeof payload.userId !== "string") {
      throw new HttpError(400, "Webhook userId is required.");
    }
    if (![KYCStatus.APPROVED, KYCStatus.REJECTED].includes(payload.status)) {
      throw new HttpError(400, "Webhook status must be approved or rejected.");
    }

    await this.dataSource.transaction(async (manager) => {
      const userRepository = manager.getRepository(User);
      const verificationRepository = manager.getRepository(KYCVerification);
      const historyRepository = manager.getRepository(KycHistory);
      const user = await userRepository.findOneBy({ id: payload.userId });
      if (!user) throw new HttpError(404, "User not found.");

      const verification = payload.verificationId
        ? await verificationRepository.findOneBy({ id: payload.verificationId })
        : await verificationRepository.findOne({
            where: { userId: payload.userId, status: KYCStatus.PENDING },
          });
      if (!verification) throw new HttpError(404, "KYC verification not found.");

      const previousStatus = verification.status;
      verification.status = payload.status;
      verification.rejectionReason =
        payload.status === KYCStatus.REJECTED ? payload.reason?.trim() ?? null : null;
      verification.verifiedAt = new Date();
      await verificationRepository.save(verification);

      // Archive to history before status change
      const historyEntry = historyRepository.create({
        userId: user.id,
        wallet: verification.wallet,
        verificationType: verification.verificationType,
        status: previousStatus,
        documents: verification.documents,
        rejectionReason: payload.status === KYCStatus.REJECTED ? payload.reason : null,
        providerReference: (verification.documents as { providerReference?: string })?.providerReference || null,
        isArchived: true,
        archivedAt: new Date(),
      });
      await historyRepository.save(historyEntry);

      await userRepository.update(payload.userId, {
        kycStatus: payload.status,
        isKycVerified: payload.status === KYCStatus.APPROVED,
      });
      this.appLogger.info("kyc.webhook.processed", {
        user_id: payload.userId,
        verification_id: verification.id,
        status: payload.status,
        reason: payload.reason ?? null,
      });
    });
  }

  /**
   * Submit a new KYC verification after rejection or expiry.
   * Previous submission is archived before creating the new one.
   * Only allowed in rejected or expired states.
   */
  async resubmitKycVerification(
    wallet: string,
    payload: KycDocumentSubmission
  ): Promise<KYCVerification> {
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({
        where: { stellarAddress: wallet },
      });
      if (!user) throw new HttpError(404, "User not found.");

      const verificationRepository = manager.getRepository(KYCVerification);
      const historyRepository = manager.getRepository(KycHistory);

      // Get current verification
      const currentVerification = await verificationRepository.findOne({
        where: {
          wallet,
          status: In([...PENDING_STATUSES, ...RESUBMITTABLE_STATUSES]),
        },
      });

      if (!currentVerification) {
        throw new HttpError(404, "No existing KYC verification found for this wallet.");
      }

      // Check if resubmission is allowed
      if (!RESUBMITTABLE_STATUSES.includes(currentVerification.status)) {
        throw new HttpError(
          400,
          `Cannot resubmit KYC verification with status ${currentVerification.status}. Only rejected or expired verifications can be resubmitted.`
        );
      }

      // Archive previous submission in history
      const historyEntry = historyRepository.create({
        userId: user.id,
        wallet: currentVerification.wallet,
        verificationType: currentVerification.verificationType,
        status: currentVerification.status,
        documents: currentVerification.documents,
        rejectionReason: currentVerification.status === KYCStatus.REJECTED ? "Resubmitted" : null,
        providerReference: (currentVerification.documents as { providerReference?: string })?.providerReference || null,
        isArchived: true,
        archivedAt: new Date(),
      });
      await historyRepository.save(historyEntry);

      // Create new verification
      const newVerification = verificationRepository.create({
        userId: user.id,
        wallet,
        verificationType: KYCVerificationType.IDENTITY,
        status: KYCStatus.PENDING,
        documents: {
          documentType: payload.documentType,
          documentNumber: payload.documentNumber,
          ipfsDocumentUrl: payload.ipfsDocumentUrl,
        },
      });
      const saved = await verificationRepository.save(newVerification);

      // Update user status
      await manager.getRepository(User).update(user.id, {
        kycStatus: KYCStatus.PENDING,
        isKycVerified: false,
      });

      this.appLogger.info("kyc.resubmission.created", {
        user_id: user.id,
        wallet,
        previous_verification_id: currentVerification.id,
        new_verification_id: saved.id,
        previous_status: currentVerification.status,
      });

      return saved;
    });
  }

  /**
   * Get all KYC submission history for a wallet.
   * Returns all records in descending order (newest first).
   */
  async getKycHistory(wallet: string): Promise<KycHistory[]> {
    const historyRepository = this.dataSource.getRepository(KycHistory);
    const history = await historyRepository.find({
      where: { wallet },
      order: { createdAt: "DESC" },
    });

    return history;
  }

  /**
   * Get KYC history for a user by user ID.
   * Returns all records in descending order (newest first).
   */
  async getKycHistoryByUserId(userId: string): Promise<KycHistory[]> {
    const historyRepository = this.dataSource.getRepository(KycHistory);
    const history = await historyRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });

    return history;
  }
}
