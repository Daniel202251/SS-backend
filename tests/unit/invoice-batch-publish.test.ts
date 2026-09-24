import { InvoiceService } from "@/services/invoice.service";
import { ServiceError } from "@/utils/service-error";
import { Invoice } from "@/models/Invoice.model";
import { InvoiceStatus, KYCStatus } from "@/types/enums";
import { InvoiceStatusHistory } from "@/models/InvoiceStatusHistory.model";

const SELLER_ID = "seller-1";
const OTHER_SELLER_ID = "seller-2";

function approvedSeller(id = SELLER_ID) {
  return { id, kycStatus: KYCStatus.APPROVED, stellarAddress: "GSELLERWALLET0001" };
}

function futureDate(hoursFromNow: number): Date {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
}

/** A publishable draft: approved seller, valid amount, document, 48h runway. */
function draftInvoice(id: string, overrides: Partial<Invoice> = {}): Invoice {
  return {
    id,
    sellerId: SELLER_ID,
    invoiceNumber: `INV-${id}`,
    customerName: "Customer A",
    amount: "1000.0000",
    discountRate: "5.00",
    netAmount: "950.0000",
    dueDate: futureDate(48),
    ipfsHash: "QmTestHash",
    riskScore: null,
    status: InvoiceStatus.DRAFT,
    smartContractId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    seller: approvedSeller(),
    ...overrides,
  } as unknown as Invoice;
}

describe("InvoiceService.publishInvoicesBatch", () => {
  let repository: any;
  let ipfsService: any;
  let dataSource: any;
  let managerSave: jest.Mock;
  let transactionCommitted: boolean;
  let service: InvoiceService;

  const invoiceSaves = () => managerSave.mock.calls.filter(([entity]) => entity === Invoice);
  const historySaves = () =>
    managerSave.mock.calls.filter(([entity]) => entity === InvoiceStatusHistory);

  /** Stub the repository so a batched `find` resolves the requested invoice ids. */
  function stubInvoices(invoices: Invoice[]) {
    repository.find.mockImplementation(async ({ where }: { where: { id: { value: string[] } } }) => {
      const ids = new Set(where.id.value);
      return invoices.filter((invoice) => ids.has(invoice.id));
    });
  }

  beforeEach(() => {
    transactionCommitted = false;
    // The state machine saves the invoice and a status history row per
    // publish: save(Invoice, invoice) and save(InvoiceStatusHistory, row).
    managerSave = jest.fn(async (_entity: unknown, value: unknown) => value);

    repository = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    };
    ipfsService = { uploadFile: jest.fn() };

    dataSource = {
      transaction: jest.fn(async (work: (manager: unknown) => Promise<unknown>) => {
        const result = await work({ save: managerSave });
        transactionCommitted = true;
        return result;
      }),
    };

    service = new InvoiceService({
      invoiceRepository: repository,
      ipfsService,
      dataSource,
    });
  });

  describe("happy path", () => {
    it("publishes every draft in the batch inside a single transaction", async () => {
      const invoices = [draftInvoice("a"), draftInvoice("b"), draftInvoice("c")];
      stubInvoices(invoices);

      const result = await service.publishInvoicesBatch({
        invoiceIds: ["a", "b", "c"],
        sellerId: SELLER_ID,
      });

      expect(result.count).toBe(3);
      expect(result.published.map((i) => i.id)).toEqual(["a", "b", "c"]);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(invoiceSaves()).toHaveLength(3);
      expect(historySaves()).toHaveLength(3);
      for (const invoice of invoices) {
        expect(invoice.status).toBe(InvoiceStatus.PUBLISHED);
      }
    });

    it("fetches the batch in a single query instead of one per invoice", async () => {
      stubInvoices([draftInvoice("a"), draftInvoice("b"), draftInvoice("c")]);

      await service.publishInvoicesBatch({
        invoiceIds: ["a", "b", "c"],
        sellerId: SELLER_ID,
      });

      expect(repository.find).toHaveBeenCalledTimes(1);
      expect(repository.findOne).not.toHaveBeenCalled();
    });

    it("deduplicates repeated ids so an invoice is published once", async () => {
      stubInvoices([draftInvoice("a")]);

      const result = await service.publishInvoicesBatch({
        invoiceIds: ["a", "a", "a"],
        sellerId: SELLER_ID,
      });

      expect(result.count).toBe(1);
      expect(invoiceSaves()).toHaveLength(1);
    });

    it("publishes a single-invoice batch", async () => {
      stubInvoices([draftInvoice("a")]);

      await expect(
        service.publishInvoicesBatch({ invoiceIds: ["a"], sellerId: SELLER_ID })
      ).resolves.toMatchObject({ count: 1 });
    });
  });

  describe("atomicity", () => {
    /**
     * The whole point of the endpoint: one bad invoice must not leave the
     * seller with a half-published book.
     */
    it("writes nothing when any invoice in the batch is invalid", async () => {
      stubInvoices([
        draftInvoice("a"),
        draftInvoice("b", { status: InvoiceStatus.PUBLISHED }),
        draftInvoice("c"),
      ]);

      await expect(
        service.publishInvoicesBatch({ invoiceIds: ["a", "b", "c"], sellerId: SELLER_ID })
      ).rejects.toBeInstanceOf(ServiceError);

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(managerSave).not.toHaveBeenCalled();
    });

    it("leaves the untouched invoices as drafts when the batch is rejected", async () => {
      const good = draftInvoice("a");
      stubInvoices([good, draftInvoice("b", { ipfsHash: null })]);

      await expect(
        service.publishInvoicesBatch({ invoiceIds: ["a", "b"], sellerId: SELLER_ID })
      ).rejects.toBeInstanceOf(ServiceError);

      expect(good.status).toBe(InvoiceStatus.DRAFT);
    });

    it("propagates a mid-transaction database failure and does not commit", async () => {
      stubInvoices([draftInvoice("a"), draftInvoice("b")]);
      managerSave
        .mockImplementationOnce(async (_entity: unknown, value: unknown) => value)
        .mockImplementationOnce(async () => {
          throw new Error("deadlock detected");
        });

      await expect(
        service.publishInvoicesBatch({ invoiceIds: ["a", "b"], sellerId: SELLER_ID })
      ).rejects.toThrow("deadlock detected");

      expect(transactionCommitted).toBe(false);
    });
  });

  describe("rejection reporting", () => {
    it("names every failing invoice, not just the first", async () => {
      stubInvoices([
        draftInvoice("a"),
        draftInvoice("b", { status: InvoiceStatus.PUBLISHED }),
        draftInvoice("c", { ipfsHash: null }),
        draftInvoice("d", { dueDate: futureDate(-1) }),
      ]);

      const error = (await service
        .publishInvoicesBatch({ invoiceIds: ["a", "b", "c", "d"], sellerId: SELLER_ID })
        .catch((e) => e)) as ServiceError;

      expect(error).toBeInstanceOf(ServiceError);
      expect(error.code).toBe("batch_publish_rejected");
      expect(error.statusCode).toBe(400);

      const rejections = (
        error.details as { rejections: Array<{ invoiceId: string; code: string }> }
      ).rejections;
      expect(rejections.map((r) => r.invoiceId).sort()).toEqual(["b", "c", "d"]);
      expect(rejections.find((r) => r.invoiceId === "b")?.code).toBe("invalid_status_transition");
      expect(rejections.find((r) => r.invoiceId === "c")?.code).toBe("invoice_not_publishable");
      expect(rejections.find((r) => r.invoiceId === "d")?.code).toBe("invoice_not_publishable");
    });

    it("reports a missing invoice", async () => {
      stubInvoices([draftInvoice("a")]);

      const error = (await service
        .publishInvoicesBatch({ invoiceIds: ["a", "missing"], sellerId: SELLER_ID })
        .catch((e) => e)) as ServiceError;

      const rejections = (
        error.details as { rejections: Array<{ invoiceId: string; code: string }> }
      ).rejections;
      expect(rejections).toEqual([
        { invoiceId: "missing", code: "invoice_not_found", message: "Invoice not found" },
      ]);
    });

    it("rejects an invoice belonging to another seller without confirming it exists", async () => {
      stubInvoices([draftInvoice("a"), draftInvoice("b", { sellerId: OTHER_SELLER_ID })]);

      const error = (await service
        .publishInvoicesBatch({ invoiceIds: ["a", "b"], sellerId: SELLER_ID })
        .catch((e) => e)) as ServiceError;

      const rejections = (
        error.details as { rejections: Array<{ invoiceId: string; code: string; message: string }> }
      ).rejections;
      expect(rejections).toHaveLength(1);
      expect(rejections[0].code).toBe("unauthorized_invoice_access");
      // Same wording as a genuinely missing invoice, so the response does not
      // leak whether another seller's id is real.
      expect(rejections[0].message).toBe("Invoice not found");
    });

    it("rejects a draft whose deadline is inside the 24 hour window", async () => {
      stubInvoices([draftInvoice("a", { dueDate: futureDate(1) })]);

      const error = (await service
        .publishInvoicesBatch({ invoiceIds: ["a"], sellerId: SELLER_ID })
        .catch((e) => e)) as ServiceError;

      const rejections = (error.details as { rejections: Array<{ code: string }> }).rejections;
      expect(rejections[0].code).toBe("invoice_not_publishable");
    });
  });

  describe("preconditions", () => {
    it("rejects an empty batch", async () => {
      await expect(
        service.publishInvoicesBatch({ invoiceIds: [], sellerId: SELLER_ID })
      ).rejects.toMatchObject({ code: "empty_batch", statusCode: 400 });
    });

    it("rejects the whole batch when the seller is not KYC approved", async () => {
      stubInvoices([
        draftInvoice("a", {
          seller: { ...approvedSeller(), kycStatus: KYCStatus.PENDING } as never,
        }),
      ]);

      await expect(
        service.publishInvoicesBatch({ invoiceIds: ["a"], sellerId: SELLER_ID })
      ).rejects.toMatchObject({ code: "kyc_approval_required", statusCode: 403 });

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("reports batch publishing as unavailable without a data source", async () => {
      const noDbService = new InvoiceService({
        invoiceRepository: repository,
        ipfsService,
      });
      stubInvoices([draftInvoice("a")]);

      await expect(
        noDbService.publishInvoicesBatch({ invoiceIds: ["a"], sellerId: SELLER_ID })
      ).rejects.toMatchObject({ code: "batch_publish_unavailable", statusCode: 503 });
    });
  });
});
