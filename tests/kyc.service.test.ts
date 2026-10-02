import crypto from "crypto";
import { KycService } from "../src/services/kyc.service";
import { KYCStatus, KYCVerificationType } from "../src/types/enums";

function createHarness() {
  const user = { id: "user-1" };
  const verification = {
    id: "verification-1",
    userId: user.id,
    verificationType: KYCVerificationType.IDENTITY,
    status: KYCStatus.PENDING,
    documents: null,
    verifiedAt: null as Date | null,
  };
  const userRepository = {
    findOneBy: jest.fn().mockResolvedValue(user),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const verificationRepository = {
    create: jest.fn((value) => ({ ...verification, ...value })),
    save: jest.fn(async (value) => value),
    findOneBy: jest.fn().mockResolvedValue(verification),
    findOne: jest.fn().mockResolvedValue(verification),
  };
  const manager = {
    getRepository: jest.fn((entity) =>
      entity.name === "User" ? userRepository : verificationRepository
    ),
  };
  const dataSource = {
    transaction: jest.fn(async (callback) => callback(manager)),
  };
  const appLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };
  const service = new KycService(dataSource as any, "webhook-secret", appLogger as any);
  return { service, userRepository, verificationRepository, appLogger };
}

describe("KycService", () => {
  it("submits a verification and moves the user to pending", async () => {
    const { service, userRepository, verificationRepository } = createHarness();
    const result = await service.submitKycVerification("user-1", {
      providerReference: "provider-123",
    });
    expect(result.status).toBe(KYCStatus.PENDING);
    expect(verificationRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationType: KYCVerificationType.IDENTITY,
        documents: { providerReference: "provider-123" },
      })
    );
    expect(userRepository.update).toHaveBeenCalledWith("user-1", {
      kycStatus: KYCStatus.PENDING,
      isKycVerified: false,
    });
  });

  it("validates HMAC signatures using the raw body", () => {
    const { service } = createHarness();
    const body = Buffer.from('{"userId":"user-1"}');
    const signature = crypto.createHmac("sha256", "webhook-secret").update(body).digest("hex");
    expect(service.verifyWebhookSignature(body, `sha256=${signature}`)).toBe(true);
    expect(service.verifyWebhookSignature(body, "sha256=deadbeef")).toBe(false);
  });

  it.each([
    [KYCStatus.APPROVED, true],
    [KYCStatus.REJECTED, false],
  ])("processes %s webhook transitions", async (status, isKycVerified) => {
    const { service, userRepository, verificationRepository, appLogger } = createHarness();
    await service.processWebhook({ userId: "user-1", status });
    expect(verificationRepository.save).toHaveBeenCalledWith(expect.objectContaining({ status }));
    expect(userRepository.update).toHaveBeenCalledWith("user-1", {
      kycStatus: status,
      isKycVerified,
    });
    expect(appLogger.info).toHaveBeenCalledWith(
      "kyc.webhook.processed",
      expect.objectContaining({ status })
    );
  });

  it("rejects unsupported webhook transitions", async () => {
    const { service } = createHarness();
    await expect(
      service.processWebhook({ userId: "user-1", status: KYCStatus.PENDING })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
