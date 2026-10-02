import crypto from "crypto";
import { InvoiceService } from "../../src/services/invoice.service";
import type { InvoiceRepositoryContract } from "../../src/services/invoice.service";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatus } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";
import type { IPFSService } from "../../src/services/ipfs.service";

// ── In-memory InvoiceRepository ──

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

  // Helper: directly mutate status without service logic (for test setup)
  forceStatus(id: string, status: InvoiceStatus) {
    const invoice = this.invoices.get(id);
    if (invoice) invoice.status = status;
  }
}

function noopIpfsService(): IPFSService {
  return {
    uploadFile: async () => ({ hash: "QmTest", size: 0, url: "https://ipfs.test" }),
  } as unknown as IPFSService;
}

function seedDraftInvoice(repo: InMemoryInvoiceRepository, sellerId: string): Invoice {
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
    ipfsHash: null,
    riskScore: null,
    status: InvoiceStatus.DRAFT,
    smartContractId: null,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    seller: undefined as unknown as Invoice["seller"],
    investments: [],
    transactions: [],
  } as unknown as Invoice;

  repo.save(invoice);
  return invoice;
}

// ── Tests ──

describe("Invoice draft update integration (issue #112)", () => {
  let repo: InMemoryInvoiceRepository;
  let service: InvoiceService;
  const sellerA = crypto.randomUUID();
  const sellerB = crypto.randomUUID();

  beforeEach(() => {
    repo = new InMemoryInvoiceRepository();
    service = new InvoiceService({ invoiceRepository: repo, ipfsService: noopIpfsService() });
  });

  it("persists updated title and amount for a draft invoice", async () => {
    const invoice = seedDraftInvoice(repo, sellerA);

    const result = await service.updateInvoice({
      invoiceId: invoice.id,
      sellerId: sellerA,
      customerName: "Updated Corp",
      amount: "2000.0000",
      discountRate: "5.00",
    });

    expect(result.customerName).toBe("Updated Corp");
    expect(result.amount).toBe("2000.0000");
    expect(result.discountRate).toBe("5.00");

    // Confirm the change is persisted in the repository
    const persisted = await repo.findOne({ where: { id: invoice.id } });
    expect(persisted!.customerName).toBe("Updated Corp");
    expect(persisted!.amount).toBe("2000.0000");
  });

  it("returns updated fields on the next GET after a draft update", async () => {
    const invoice = seedDraftInvoice(repo, sellerA);

    await service.updateInvoice({
      invoiceId: invoice.id,
      sellerId: sellerA,
      customerName: "New Name",
    });

    const persisted = await repo.findOne({ where: { id: invoice.id } });
    expect(persisted!.customerName).toBe("New Name");
  });

  it("rejects PATCH on a published invoice with invalid_invoice_status", async () => {
    const invoice = seedDraftInvoice(repo, sellerA);

    // Transition invoice to PUBLISHED without going through the service
    repo.forceStatus(invoice.id, InvoiceStatus.PUBLISHED);

    await expect(
      service.updateInvoice({
        invoiceId: invoice.id,
        sellerId: sellerA,
        customerName: "Should Not Update",
      })
    ).rejects.toMatchObject({
      code: "invalid_invoice_status",
      statusCode: 400,
    });
  });

  it("rejects PATCH by a different seller on a draft they do not own", async () => {
    const invoice = seedDraftInvoice(repo, sellerA);

    await expect(
      service.updateInvoice({
        invoiceId: invoice.id,
        sellerId: sellerB,
        customerName: "Unauthorized Update",
      })
    ).rejects.toMatchObject({
      code: "unauthorized_invoice_access",
      statusCode: 403,
    });
  });

  it("draft fields remain unchanged after a rejected published-invoice update", async () => {
    const invoice = seedDraftInvoice(repo, sellerA);
    repo.forceStatus(invoice.id, InvoiceStatus.PUBLISHED);

    try {
      await service.updateInvoice({
        invoiceId: invoice.id,
        sellerId: sellerA,
        customerName: "Will Not Persist",
      });
    } catch (_err) {
      // expected rejection
    }

    const persisted = await repo.findOne({ where: { id: invoice.id } });
    expect(persisted!.customerName).toBe("Acme Corp");
  });
});
