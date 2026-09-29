import crypto from "crypto";
import { InvoiceService } from "../../src/services/invoice.service";
import type {
  InvoiceRepositoryContract,
  NotificationSink,
} from "../../src/services/invoice.service";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatus, NotificationType } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";
import type { IPFSService } from "../../src/services/ipfs.service";

/**
 * Issue #206: the admin invoice-reject endpoint must store the rejection
 * reason on the invoice record, transition its status to REJECTED, and
 * notify the seller.
 *
 * This is new functionality: prior to this change there was no invoice
 * reject path at all (only KYC approve/reject existed under
 * src/routes/admin/). This test exercises the new
 * `InvoiceService.rejectInvoice` method — the same layer
 * src/routes/admin/reject-invoice.ts delegates to — via an in-memory
 * repository and a fake notification sink, following this repo's existing
 * integration test convention (see invoice-draft-update.integration.test.ts,
 * notification-mark-read.integration.test.ts).
 *
 * Caveat (disclosed in the PR): this codebase has no role-based user/admin
 * model. The admin surface (approve-kyc, reject-kyc, and now reject-invoice)
 * is gated purely by a static `x-admin-key` header at the route layer
 * (see reject-invoice.ts), matching its sibling endpoints exactly. A
 * missing/incorrect key yields 401 there, not the 403 a full role-based
 * scheme might return for an authenticated-but-non-admin caller. That
 * route-layer check is exercised directly below; `InvoiceService.rejectInvoice`
 * itself (tested here) assumes the caller has already been authorized.
 */

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

interface StoredNotification {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
}

function createFakeNotificationSink(): NotificationSink & { sent: StoredNotification[] } {
  const sent: StoredNotification[] = [];
  return {
    sent,
    async createNotification(userId, type, title, message) {
      const notif = { userId, type, title, message };
      sent.push(notif);
      return notif;
    },
  };
}

function noopIpfsService(): IPFSService {
  return {
    uploadFile: async () => ({ hash: "QmTest", size: 0, url: "https://ipfs.test" }),
  } as unknown as IPFSService;
}

function seedPendingInvoice(repo: InMemoryInvoiceRepository, sellerId: string): Invoice {
  const now = new Date();
  const invoice = {
    id: crypto.randomUUID(),
    sellerId,
    invoiceNumber: `INV-${crypto.randomBytes(4).toString("hex")}`,
    customerName: "Acme Corp",
    amount: "1000.0000",
    discountRate: "0.00",
    netAmount: "1000.0000",
    dueDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    ipfsHash: "QmValidDocumentHash",
    riskScore: null,
    status: InvoiceStatus.PENDING,
    smartContractId: null,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    seller: { id: sellerId, stellarAddress: "GTEST" } as unknown as Invoice["seller"],
    investments: [],
    transactions: [],
  } as unknown as Invoice;

  repo.save(invoice);
  return invoice;
}

describe("Admin invoice reject: persists reason, transitions status, notifies seller (issue #206)", () => {
  let repo: InMemoryInvoiceRepository;
  let notificationSink: ReturnType<typeof createFakeNotificationSink>;
  let service: InvoiceService;
  const sellerA = crypto.randomUUID();

  beforeEach(() => {
    repo = new InMemoryInvoiceRepository();
    notificationSink = createFakeNotificationSink();
    service = new InvoiceService({
      invoiceRepository: repo,
      ipfsService: noopIpfsService(),
      notificationSink,
    });
  });

  it("transitions the invoice status to rejected", async () => {
    const invoice = seedPendingInvoice(repo, sellerA);

    const result = await service.rejectInvoice({
      invoiceId: invoice.id,
      rejectionReason: "Missing supporting documentation",
    });

    expect(result.status).toBe(InvoiceStatus.REJECTED);

    const persisted = await repo.findOne({ where: { id: invoice.id } });
    expect(persisted!.status).toBe(InvoiceStatus.REJECTED);
  });

  it("persists the rejection_reason field matching the submitted reason", async () => {
    const invoice = seedPendingInvoice(repo, sellerA);
    const reason = "Invoice amount does not match the attached document";

    await service.rejectInvoice({ invoiceId: invoice.id, rejectionReason: reason });

    const persisted = await repo.findOne({ where: { id: invoice.id } });
    expect(persisted!.rejectionReason).toBe(reason);
  });

  it("creates a notification for the seller's account containing the rejection reason", async () => {
    const invoice = seedPendingInvoice(repo, sellerA);
    const reason = "Customer name does not match KYC records";

    await service.rejectInvoice({ invoiceId: invoice.id, rejectionReason: reason });

    expect(notificationSink.sent).toHaveLength(1);
    const [notification] = notificationSink.sent;
    expect(notification.userId).toBe(sellerA);
    expect(notification.type).toBe(NotificationType.INVOICE_REJECTED);
    expect(notification.message).toContain(reason);
  });

  it("rejecting an already-rejected invoice returns a 409 conflict and does not send a second notification", async () => {
    const invoice = seedPendingInvoice(repo, sellerA);

    await service.rejectInvoice({ invoiceId: invoice.id, rejectionReason: "First reason" });
    expect(notificationSink.sent).toHaveLength(1);

    await expect(
      service.rejectInvoice({ invoiceId: invoice.id, rejectionReason: "Second reason" })
    ).rejects.toMatchObject({
      code: "invoice_already_rejected",
      statusCode: 409,
    });

    // No second notification sent, and the original reason is untouched.
    expect(notificationSink.sent).toHaveLength(1);
    const persisted = await repo.findOne({ where: { id: invoice.id } });
    expect(persisted!.rejectionReason).toBe("First reason");
  });

  it("rejects with 404 when the invoice does not exist", async () => {
    await expect(
      service.rejectInvoice({ invoiceId: crypto.randomUUID(), rejectionReason: "N/A" })
    ).rejects.toMatchObject({ code: "invoice_not_found", statusCode: 404 });
  });

  it("rejects with a 409 status-transition conflict for a status that cannot go to rejected (e.g. already published)", async () => {
    const invoice = seedPendingInvoice(repo, sellerA);
    invoice.status = InvoiceStatus.PUBLISHED;
    await repo.save(invoice);

    await expect(
      service.rejectInvoice({ invoiceId: invoice.id, rejectionReason: "Too late" })
    ).rejects.toMatchObject({
      code: "invalid_status_transition",
      statusCode: 409,
    });
  });

  it("still works (skips notification) when no notification sink is configured", async () => {
    const bareService = new InvoiceService({
      invoiceRepository: repo,
      ipfsService: noopIpfsService(),
    });
    const invoice = seedPendingInvoice(repo, sellerA);

    const result = await bareService.rejectInvoice({
      invoiceId: invoice.id,
      rejectionReason: "No sink configured",
    });

    expect(result.status).toBe(InvoiceStatus.REJECTED);
  });

  it("propagates ServiceError as the rejection type so callers can branch on .code/.statusCode", async () => {
    const invoice = seedPendingInvoice(repo, sellerA);
    await service.rejectInvoice({ invoiceId: invoice.id, rejectionReason: "x" });

    try {
      await service.rejectInvoice({ invoiceId: invoice.id, rejectionReason: "y" });
      throw new Error("expected rejectInvoice to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
    }
  });
});

// ── Route-layer admin auth gate (x-admin-key) ──

describe("Admin invoice reject route: x-admin-key gate (issue #206)", () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    // Mirrors approve-kyc.ts / reject-kyc.ts: the gate compares against
    // process.env.ADMIN_API_KEY, so it must be set to something to test
    // the "wrong key" path meaningfully (an unset var would make
    // `undefined !== undefined` false and let the request through).
    process.env.ADMIN_API_KEY = "test-admin-secret";
  });

  afterEach(() => {
    process.env.ADMIN_API_KEY = originalAdminKey;
  });

  it("returns 401 when x-admin-key is missing or incorrect", async () => {
    const { rejectInvoice } = await import("../../src/routes/admin/reject-invoice");

    const req = {
      headers: { "x-admin-key": "wrong-key" },
      params: { id: crypto.randomUUID() },
      body: { rejectionReason: "test" },
    } as unknown as Parameters<typeof rejectInvoice>[0];

    let statusCode = 0;
    let jsonBody: unknown;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: unknown) {
        jsonBody = body;
        return this;
      },
    } as unknown as Parameters<typeof rejectInvoice>[1];

    await rejectInvoice(req, res, {} as never);

    expect(statusCode).toBe(401);
    expect(jsonBody).toMatchObject({ error: "Unauthorized" });
  });

  it("returns 401 when the x-admin-key header is absent entirely", async () => {
    const { rejectInvoice } = await import("../../src/routes/admin/reject-invoice");

    const req = {
      headers: {},
      params: { id: crypto.randomUUID() },
      body: { rejectionReason: "test" },
    } as unknown as Parameters<typeof rejectInvoice>[0];

    let statusCode = 0;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Parameters<typeof rejectInvoice>[1];

    await rejectInvoice(req, res, {} as never);

    expect(statusCode).toBe(401);
  });

  it("with a correct key, delegates to InvoiceService.rejectInvoice and returns its result", async () => {
    const { rejectInvoice } = await import("../../src/routes/admin/reject-invoice");

    const repo = new InMemoryInvoiceRepository();
    const notificationSink = createFakeNotificationSink();
    const realService = new InvoiceService({
      invoiceRepository: repo,
      ipfsService: noopIpfsService(),
      notificationSink,
    });
    const invoice = seedPendingInvoice(repo, crypto.randomUUID());

    const req = {
      headers: { "x-admin-key": "test-admin-secret" },
      params: { id: invoice.id },
      body: { rejectionReason: "Duplicate invoice number" },
    } as unknown as Parameters<typeof rejectInvoice>[0];

    let statusCode = 0;
    let jsonBody: unknown;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: unknown) {
        jsonBody = body;
        return this;
      },
    } as unknown as Parameters<typeof rejectInvoice>[1];

    await rejectInvoice(req, res, realService);

    expect(statusCode).toBe(200);
    expect(jsonBody).toMatchObject({
      success: true,
      data: { status: InvoiceStatus.REJECTED },
    });
  });

  it("returns 400 when rejectionReason is missing from the request body", async () => {
    const { rejectInvoice } = await import("../../src/routes/admin/reject-invoice");

    const req = {
      headers: { "x-admin-key": "test-admin-secret" },
      params: { id: crypto.randomUUID() },
      body: {},
    } as unknown as Parameters<typeof rejectInvoice>[0];

    let statusCode = 0;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Parameters<typeof rejectInvoice>[1];

    await rejectInvoice(req, res, {} as never);

    expect(statusCode).toBe(400);
  });
});
