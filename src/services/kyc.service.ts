import crypto from "crypto";
import { DataSource } from "typeorm";
import { KYCVerification } from "../models/KYCVerification.model";
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

export interface ReviewKycVerificationInput {
  status: KYCStatus.APPROVED | KYCStatus.REJECTED;
  reason?: string | null;
}

export interface KycStatusResponse {
  verificationId: string | null;
  status: KYCStatus;
  rejectionReason: string | null;
  documents: Record<string, unknown> | null;
  reviewedAt: Date | null;
}

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
      const user = await userRepository.findOneBy({ id: payload.userId });
      if (!user) throw new HttpError(404, "User not found.");

      const verification = payload.verificationId
        ? await verificationRepository.findOneBy({ id: payload.verificationId })
        : await verificationRepository.findOne({
            where: { userId: payload.userId, status: KYCStatus.PENDING },
          });
      if (!verification) throw new HttpError(404, "KYC verification not found.");

      verification.status = payload.status;
      verification.rejectionReason =
        payload.status === KYCStatus.REJECTED ? payload.reason?.trim() ?? null : null;
      verification.verifiedAt = new Date();
      await verificationRepository.save(verification);
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
}
