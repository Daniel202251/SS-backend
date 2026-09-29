import crypto from "crypto";
import { InvoiceService } from "../../src/services/invoice.service";
import type { InvoiceRepositoryContract } from "../../src/services/invoice.service";
import { Invoice } from "../../src/models/Invoice.model";
import { User } from "../../src/models/User.model";
import { InvoiceStatus, KYCStatus, UserType } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";
import type { IPFSService } from "../../src/services/ipfs.service";

/**
 * Issue #217: invoice publishing must enforce the approved-seller KYC gate,
 * so unverified sellers cannot create marketplace inventory.
 *
 * The gate itself already exists in `InvoiceService.publishInvoice`
 * (src/services/invoice.service.ts): it loads the invoice's `seller`
 * relation and rejects with a 403 `kyc_approval_required` ServiceError
 * unless `seller.kycStatus === KYCStatus.APPROVED`. This test exercises
 * that gate end-to-end through the service layer (in-memory repository,
 * following this repo's existing integration test convention — see
 * invoice-draft-update.integration.test.ts) across pending, rejected, and
 * missing-KYC sellers, plus the approved-seller success path.
 */

// ── In-memory InvoiceRepository (mirrors invoice-draft-update.integration.test.ts) ──

class InMemoryInvoiceRepository implements InvoiceRepositoryContract {
  private readonly invoices = new Map<string, Invoice>();

  async findOne(options: { where: { id: string }; relations?: string[] }) {
    return this.invoices.get(options.where.id) ?? null;
  }

  async findOneBy(options: { id?: string; invoiceNumber?: string }) {
    for (const invoice of this.invoices.values()) {
      if (options.id && invoice.id === options.id) return invoice;
      if (options.invoiceNumber && invoice.invoiceNumber === options.invoiceNumber) return invoice;
    }
    return null;
  }

  async find(options: {
    where: { sellerId: string; status?: InvoiceStatus };
    skip?: number;
    take?: number;
    order?: Record<string, "ASC" | "DESC">;
  }) {
    return [...this.invoices.values()].filter(
      (inv) =>
        inv.sellerId === options.where.sellerId &&
        (options.where.status == null || inv.status === options.where.status)
    );
  }

  async save(invoice: Invoice) {
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  async count(options: { where: { sellerId: string; status?: InvoiceStatus } }) {
    return (await this.find({ where: options.where })).length;
  }

  create(data: Partial<Invoice>): Invoice {
    return { id: crypto.randomUUID(), ...data } as Invoice;
  }
}

function noopIpfsService(): IPFSService {
  return {
    uploadFile: async () => ({ hash: "QmTest", size: 0, url: "https://ipfs.test" }),
  } as unknown as IPFSService;
}

function makeSeller(kycStatus: KYCStatus | null): User {
  return {
    id: crypto.randomUUID(),
    stellarAddress: `G${crypto.randomBytes(28).toString("hex").toUpperCase().slice(0, 55)}`,
    email: "seller@example.com",
    userType: UserType.SELLER,
    kycStatus: kycStatus as unknown as KYCStatus, // null simulates a missing/unset KYC record
    isKycVerified: kycStatus === KYCStatus.APPROVED,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    invoices: [],
    investments: [],
    transactions: [],
    kycVerifications: [],
    notifications: [],
  } as unknown as User;
}

/**
 * Seeds a DRAFT invoice that satisfies every `validateInvoiceForPublish`
 * requirement (face value >= 100 XLM, due date >= 24h out, a document
 * attached) so that a rejection in these tests can only be attributed to
 * the KYC gate, not incidental publish-validation failures.
 */
function seedPublishableInvoice(repo: InMemoryInvoiceRepository, seller: User): Invoice {
  const now = new Date();
  const invoice = {
    id: crypto.randomUUID(),
    sellerId: seller.id,
    invoiceNumber: `INV-${crypto.randomBytes(4).toString("hex")}`,
    customerName: "Acme Corp",
    amount: "1000.0000",
    discountRate: "0.00",
    netAmount: "1000.0000",
    dueDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    ipfsHash: "QmValidDocumentHash",
    riskScore: null,
    status: InvoiceStatus.DRAFT,
    smartContractId: null,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    seller,
    investments: [],
    transactions: [],
  } as unknown as Invoice;

  repo.save(invoice);
  return invoice;
}

describe("Invoice publish: approved-seller KYC gate (issue #217)", () => {
  let repo: InMemoryInvoiceRepository;
  let service: InvoiceService;

  beforeEach(() => {
    repo = new InMemoryInvoiceRepository();
    service = new InvoiceService({ invoiceRepository: repo, ipfsService: noopIpfsService() });
  });

  it("rejects publishing with a deterministic 403 when the seller's KYC is pending", async () => {
    const seller = makeSeller(KYCStatus.PENDING);
    const invoice = seedPublishableInvoice(repo, seller);

    await expect(
      service.publishInvoice({ invoiceId: invoice.id, sellerId: seller.id })
    ).rejects.toMatchObject({
      code: "kyc_approval_required",
      statusCode: 403,
    });
  });

  it("rejects publishing with a deterministic 403 when the seller's KYC is rejected", async () => {
    const seller = makeSeller(KYCStatus.REJECTED);
    const invoice = seedPublishableInvoice(repo, seller);

    await expect(
      service.publishInvoice({ invoiceId: invoice.id, sellerId: seller.id })
    ).rejects.toMatchObject({
      code: "kyc_approval_required",
      statusCode: 403,
    });
  });

  it("rejects publishing with a deterministic 403 when the seller's KYC is in review", async () => {
    const seller = makeSeller(KYCStatus.IN_REVIEW);
    const invoice = seedPublishableInvoice(repo, seller);

    await expect(
      service.publishInvoice({ invoiceId: invoice.id, sellerId: seller.id })
    ).rejects.toMatchObject({
      code: "kyc_approval_required",
      statusCode: 403,
    });
  });

  it("rejects publishing with a deterministic 403 when the seller has no KYC record at all", async () => {
    const seller = makeSeller(null);
    const invoice = seedPublishableInvoice(repo, seller);

    await expect(
      service.publishInvoice({ invoiceId: invoice.id, sellerId: seller.id })
    ).rejects.toMatchObject({
      code: "kyc_approval_required",
      statusCode: 403,
    });
  });

  it("does not persist a PUBLISHED status for any non-approved-KYC rejection", async () => {
    const nonApprovedStates = [KYCStatus.PENDING, KYCStatus.REJECTED, KYCStatus.IN_REVIEW, null];

    for (const kycStatus of nonApprovedStates) {
      const seller = makeSeller(kycStatus);
      const invoice = seedPublishableInvoice(repo, seller);

      await expect(
        service.publishInvoice({ invoiceId: invoice.id, sellerId: seller.id })
      ).rejects.toMatchObject({ code: "kyc_approval_required" });

      const persisted = await repo.findOne({ where: { id: invoice.id } });
      expect(persisted!.status).toBe(InvoiceStatus.DRAFT);
    }
  });

  it("allows an approved seller to publish the same valid invoice payload successfully", async () => {
    const seller = makeSeller(KYCStatus.APPROVED);
    const invoice = seedPublishableInvoice(repo, seller);

    const result = await service.publishInvoice({
      invoiceId: invoice.id,
      sellerId: seller.id,
    });

    expect(result.status).toBe(InvoiceStatus.PUBLISHED);

    const persisted = await repo.findOne({ where: { id: invoice.id } });
    expect(persisted!.status).toBe(InvoiceStatus.PUBLISHED);
  });

  it("still enforces ownership before the KYC gate: a different seller cannot publish another seller's invoice", async () => {
    const owner = makeSeller(KYCStatus.APPROVED);
    const impostor = makeSeller(KYCStatus.APPROVED);
    const invoice = seedPublishableInvoice(repo, owner);

    await expect(
      service.publishInvoice({ invoiceId: invoice.id, sellerId: impostor.id })
    ).rejects.toMatchObject({
      code: "unauthorized_invoice_access",
      statusCode: 403,
    });
  });

  it("propagates ServiceError as the rejection type so callers can branch on .code/.statusCode", async () => {
    const seller = makeSeller(KYCStatus.PENDING);
    const invoice = seedPublishableInvoice(repo, seller);

    try {
      await service.publishInvoice({ invoiceId: invoice.id, sellerId: seller.id });
      throw new Error("expected publishInvoice to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).message).toMatch(/KYC approval is required/i);
    }
  });
});
