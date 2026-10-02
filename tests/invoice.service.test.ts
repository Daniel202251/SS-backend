import { IsNull } from "typeorm";
import { InvoiceService } from "../src/services/invoice.service";
import { ServiceError } from "../src/utils/service-error";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceStatus, KYCStatus } from "../src/types/enums";
import { logger } from "../src/observability/logger";

describe("InvoiceService", () => {
  let mockInvoiceRepository: any;
  let mockIPFSService: any;
  let invoiceService: InvoiceService;

  /**
   * A fresh invoice per call. The service mutates the entities it loads
   * (`updateInvoice`, `deleteInvoice`, state transitions), so a single shared
   * object would leak one test's changes into the next.
   */
  const buildInvoice = (overrides: Partial<Invoice> = {}): Invoice =>
    ({
      id: "invoice-123",
      sellerId: "seller-456",
      invoiceNumber: "INV-001",
      customerName: "Test Customer",
      amount: "1000.00",
      discountRate: "5.00",
      netAmount: "950.00",
      dueDate: new Date("2024-12-31"),
      ipfsHash: null,
      riskScore: null,
      status: InvoiceStatus.DRAFT,
      smartContractId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      ...overrides,
    }) as Invoice;

  const APPROVED_SELLER = {
    kycStatus: KYCStatus.APPROVED,
    stellarAddress: "GSELLERWALLET1234567890ABCDEFGHIJKLMNOPQRSTUV",
  };

  /** A draft invoice that passes pre-publish validation. */
  const buildPublishableInvoice = (overrides: Record<string, unknown> = {}): Invoice =>
    ({
      ...buildInvoice(),
      dueDate: new Date(Date.now() + 48 * 60 * 60 * 1000),
      ipfsHash: "QmTestHash",
      seller: { ...APPROVED_SELLER },
      ...overrides,
    }) as unknown as Invoice;

  let mockInvoice: Invoice;
  let loggerErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockInvoice = buildInvoice();
    loggerErrorSpy = jest.spyOn(logger, "error").mockImplementation(() => undefined);

    mockInvoiceRepository = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    };

    mockIPFSService = {
      uploadFile: jest.fn(),
    };

    invoiceService = new InvoiceService({
      invoiceRepository: mockInvoiceRepository,
      ipfsService: mockIPFSService,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Valid `createInvoice` input; override any field per case. */
  const buildCreateInput = (overrides: Record<string, unknown> = {}) => ({
    sellerId: "seller-456",
    invoiceNumber: "INV-001",
    customerName: "Test Customer",
    amount: "1000.00",
    discountRate: "5.00",
    dueDate: new Date("2024-12-31"),
    ...overrides,
  });

  /**
   * Wire the repository so `create`/`save` echo the entity the service builds,
   * letting a test assert on the values the service actually computed (e.g.
   * netAmount) rather than on a hand-stubbed return value.
   */
  const wireCreatePassthrough = () => {
    mockInvoiceRepository.findOneBy.mockResolvedValue(null);
    mockInvoiceRepository.create.mockImplementation((data: Partial<Invoice>) => ({
      ...mockInvoice,
      ...data,
    }));
    mockInvoiceRepository.save.mockImplementation(async (invoice: Invoice) => invoice);
  };

  // ============ CREATE INVOICE TESTS ============
  describe("createInvoice", () => {
    it("should successfully create an invoice", async () => {
      wireCreatePassthrough();

      const result = await invoiceService.createInvoice(buildCreateInput());

      expect(result.id).toBe("invoice-123");
      expect(result.status).toBe(InvoiceStatus.DRAFT);
      expect(result.netAmount).toBe("950.0000");
      expect(mockInvoiceRepository.findOneBy).toHaveBeenCalledWith({
        invoiceNumber: "INV-001",
      });
    });

    // netAmount = amount - amount * discountRate / 100, rounded to 4 dp.
    // The 29.99 @ 0.5% row guards a real regression: naive `parseFloat`
    // arithmetic produced "29.8400" instead of "29.8401" because 29.99 and
    // 0.5 aren't exactly representable as IEEE-754 doubles.
    it.each([
      { amount: "1000.00", discountRate: "10.00", expected: "900.0000", note: "round percentages" },
      { amount: "1000.00", discountRate: "5.00", expected: "950.0000", note: "default case" },
      { amount: "29.99", discountRate: "0.5", expected: "29.8401", note: "IEEE-754 rounding trap" },
      { amount: "10000.0000", discountRate: "0.00", expected: "10000.0000", note: "zero discount" },
      { amount: "250.50", discountRate: "100", expected: "0.0000", note: "full discount" },
      { amount: "0.03", discountRate: "33.33", expected: "0.0200", note: "sub-cent rounding" },
      { amount: "0", discountRate: "5", expected: "0.0000", note: "zero amount" },
    ])(
      "computes netAmount = $expected for $amount @ $discountRate% ($note)",
      async ({ amount, discountRate, expected }) => {
        wireCreatePassthrough();

        const result = await invoiceService.createInvoice(
          buildCreateInput({ amount, discountRate })
        );

        expect(mockInvoiceRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ netAmount: expected })
        );
        expect(result.netAmount).toBe(expected);
      }
    );

    it("should reject duplicate invoice number", async () => {
      mockInvoiceRepository.findOneBy.mockResolvedValue(mockInvoice);

      await expect(invoiceService.createInvoice(buildCreateInput())).rejects.toThrow(ServiceError);

      await expect(invoiceService.createInvoice(buildCreateInput())).rejects.toMatchObject({
        code: "invoice_number_exists",
        statusCode: 409,
      });

      expect(mockInvoiceRepository.save).not.toHaveBeenCalled();
    });

    it("should reject a blank invoice number without touching the repository", async () => {
      await expect(
        invoiceService.createInvoice(buildCreateInput({ invoiceNumber: "   " }))
      ).rejects.toMatchObject({ code: "invalid_invoice_number", statusCode: 400 });

      expect(mockInvoiceRepository.findOneBy).not.toHaveBeenCalled();
      expect(mockInvoiceRepository.save).not.toHaveBeenCalled();
    });

    it("should trim and bound user-supplied text before persisting it", async () => {
      wireCreatePassthrough();

      await invoiceService.createInvoice(
        buildCreateInput({
          invoiceNumber: `  ${"N".repeat(80)}  `,
          customerName: `  ${"C".repeat(300)}  `,
          ipfsHash: "  QmHash  ",
          riskScore: "  0.42  ",
        })
      );

      expect(mockInvoiceRepository.findOneBy).toHaveBeenCalledWith({
        invoiceNumber: "N".repeat(64),
      });
      expect(mockInvoiceRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceNumber: "N".repeat(64),
          customerName: "C".repeat(255),
          ipfsHash: "QmHash",
          riskScore: "0.42",
          status: InvoiceStatus.DRAFT,
        })
      );
    });

    it("should default blank optional fields to null", async () => {
      wireCreatePassthrough();

      await invoiceService.createInvoice(buildCreateInput({ ipfsHash: "   ", riskScore: "" }));

      expect(mockInvoiceRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ ipfsHash: null, riskScore: null })
      );
    });

    it.each([
      { amount: "-1.00", discountRate: "5", note: "negative amount" },
      { amount: "1000", discountRate: "-0.01", note: "negative discount" },
      { amount: "1000", discountRate: "100.01", note: "discount above 100%" },
      { amount: "abc", discountRate: "5", note: "non-numeric amount" },
      { amount: "1000", discountRate: "", note: "empty discount" },
      { amount: "Infinity", discountRate: "5", note: "infinite amount" },
      { amount: "NaN", discountRate: "5", note: "NaN amount" },
    ])(
      "should reject $note as invalid_amount and persist nothing",
      async ({ amount, discountRate }) => {
        mockInvoiceRepository.findOneBy.mockResolvedValue(null);

        await expect(
          invoiceService.createInvoice(buildCreateInput({ amount, discountRate }))
        ).rejects.toMatchObject({ code: "invalid_amount", statusCode: 400 });

        expect(mockInvoiceRepository.create).not.toHaveBeenCalled();
        expect(mockInvoiceRepository.save).not.toHaveBeenCalled();
      }
    );

    it("should accept the 0% and 100% discount boundaries", async () => {
      wireCreatePassthrough();

      await expect(
        invoiceService.createInvoice(buildCreateInput({ discountRate: "0" }))
      ).resolves.toMatchObject({ netAmount: "1000.0000" });
      await expect(
        invoiceService.createInvoice(buildCreateInput({ discountRate: "100" }))
      ).resolves.toMatchObject({ netAmount: "0.0000" });
    });

    it("should wrap an unexpected repository failure without leaking its message", async () => {
      mockInvoiceRepository.findOneBy.mockRejectedValue(
        new Error("connection refused: db-primary:5432")
      );

      const failure = invoiceService.createInvoice(buildCreateInput());

      await expect(failure).rejects.toMatchObject({
        code: "invoice_create_failed",
        statusCode: 500,
        message: "Failed to create invoice",
      });
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        "Failed to create invoice",
        expect.objectContaining({ sellerId: "seller-456" })
      );
    });

    it("should wrap a failing save the same way", async () => {
      wireCreatePassthrough();
      mockInvoiceRepository.save.mockRejectedValue(new Error("deadlock detected"));

      await expect(invoiceService.createInvoice(buildCreateInput())).rejects.toMatchObject({
        code: "invoice_create_failed",
        statusCode: 500,
      });
    });
  });

  // ============ GET INVOICE TESTS ============
  describe("getInvoiceById", () => {
    it("should retrieve invoice by id", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      const result = await invoiceService.getInvoiceById("invoice-123");

      expect(result?.id).toBe("invoice-123");
      expect(mockInvoiceRepository.findOne).toHaveBeenCalledWith({
        where: { id: "invoice-123" },
      });
    });

    it("should return null when invoice not found", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(null);

      const result = await invoiceService.getInvoiceById("nonexistent");

      expect(result).toBeNull();
    });

    it("should verify ownership when sellerId provided", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      const result = await invoiceService.getInvoiceById("invoice-123", "seller-456");

      expect(result?.id).toBe("invoice-123");
    });

    it("should throw error for unauthorized access", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.getInvoiceById("invoice-123", "different-seller")
      ).rejects.toMatchObject({
        code: "unauthorized_invoice_access",
        statusCode: 403,
      });
    });

    it("should return null for a blank id without querying", async () => {
      await expect(invoiceService.getInvoiceById("   ")).resolves.toBeNull();

      expect(mockInvoiceRepository.findOne).not.toHaveBeenCalled();
    });

    it("should trim the id before querying", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await invoiceService.getInvoiceById("  invoice-123  ");

      expect(mockInvoiceRepository.findOne).toHaveBeenCalledWith({
        where: { id: "invoice-123" },
      });
    });

    it("should wrap an unexpected repository failure", async () => {
      mockInvoiceRepository.findOne.mockRejectedValue(new Error("boom"));

      await expect(invoiceService.getInvoiceById("invoice-123")).rejects.toMatchObject({
        code: "invoice_fetch_failed",
        statusCode: 500,
      });
      expect(loggerErrorSpy).toHaveBeenCalled();
    });
  });

  // ============ GET INVOICES BY SELLER TESTS ============
  describe("getInvoicesBySellerId", () => {
    it("should list invoices for seller", async () => {
      mockInvoiceRepository.find.mockResolvedValue([mockInvoice]);
      mockInvoiceRepository.count.mockResolvedValue(1);

      const result = await invoiceService.getInvoicesBySellerId({
        sellerId: "seller-456",
      });

      expect(result.invoices).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it("should filter by status", async () => {
      mockInvoiceRepository.find.mockResolvedValue([mockInvoice]);
      mockInvoiceRepository.count.mockResolvedValue(1);

      await invoiceService.getInvoicesBySellerId({
        sellerId: "seller-456",
        status: InvoiceStatus.DRAFT,
      });

      expect(mockInvoiceRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: InvoiceStatus.DRAFT,
          }),
        })
      );
    });

    it("should support pagination", async () => {
      mockInvoiceRepository.find.mockResolvedValue([mockInvoice]);
      mockInvoiceRepository.count.mockResolvedValue(50);

      await invoiceService.getInvoicesBySellerId({
        sellerId: "seller-456",
        skip: 10,
        take: 20,
      });

      expect(mockInvoiceRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 20,
        })
      );
    });

    it("should default to the first page of 20, newest first, excluding soft-deleted rows", async () => {
      mockInvoiceRepository.find.mockResolvedValue([]);
      mockInvoiceRepository.count.mockResolvedValue(0);

      await invoiceService.getInvoicesBySellerId({ sellerId: "  seller-456  " });

      expect(mockInvoiceRepository.find).toHaveBeenCalledWith({
        where: { sellerId: "seller-456", deletedAt: IsNull() },
        skip: 0,
        take: 20,
        order: { createdAt: "DESC" },
      });
      expect(mockInvoiceRepository.count).toHaveBeenCalledWith({
        where: { sellerId: "seller-456", deletedAt: IsNull() },
      });
    });

    it.each([
      { skip: -5, take: 0, expectedSkip: 0, expectedTake: 1, note: "negative skip and zero take" },
      {
        skip: 99_999,
        take: 5_000,
        expectedSkip: 10_000,
        expectedTake: 100,
        note: "oversized skip and take",
      },
      { skip: 0, take: 100, expectedSkip: 0, expectedTake: 100, note: "the maximum page size" },
    ])("should clamp pagination for $note", async ({ skip, take, expectedSkip, expectedTake }) => {
      mockInvoiceRepository.find.mockResolvedValue([]);
      mockInvoiceRepository.count.mockResolvedValue(0);

      await invoiceService.getInvoicesBySellerId({ sellerId: "seller-456", skip, take });

      expect(mockInvoiceRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ skip: expectedSkip, take: expectedTake })
      );
    });

    it("should ignore a status that is not a known InvoiceStatus", async () => {
      mockInvoiceRepository.find.mockResolvedValue([]);
      mockInvoiceRepository.count.mockResolvedValue(0);

      await invoiceService.getInvoicesBySellerId({
        sellerId: "seller-456",
        status: "not-a-status" as InvoiceStatus,
      });

      const { where } = mockInvoiceRepository.find.mock.calls[0][0];
      expect(where).not.toHaveProperty("status");
    });

    it("should reject a blank seller id", async () => {
      await expect(invoiceService.getInvoicesBySellerId({ sellerId: "  " })).rejects.toMatchObject({
        code: "invalid_seller_id",
        statusCode: 400,
      });
      expect(mockInvoiceRepository.find).not.toHaveBeenCalled();
    });

    it("should map every row to a DTO and report the unpaginated total", async () => {
      mockInvoiceRepository.find.mockResolvedValue([
        mockInvoice,
        buildInvoice({ id: "invoice-999" }),
      ]);
      mockInvoiceRepository.count.mockResolvedValue(42);

      const result = await invoiceService.getInvoicesBySellerId({
        sellerId: "seller-456",
        take: 2,
      });

      expect(result.invoices.map((inv) => inv.id)).toEqual(["invoice-123", "invoice-999"]);
      expect(result.total).toBe(42);
      expect(result.invoices[0]).not.toHaveProperty("deletedAt");
    });

    it("should wrap a failing query", async () => {
      mockInvoiceRepository.find.mockRejectedValue(new Error("timeout"));
      mockInvoiceRepository.count.mockResolvedValue(0);

      await expect(
        invoiceService.getInvoicesBySellerId({ sellerId: "seller-456" })
      ).rejects.toMatchObject({ code: "invoice_list_failed", statusCode: 500 });
    });
  });

  // ============ UPDATE INVOICE TESTS ============
  describe("updateInvoice", () => {
    it("should update draft invoice", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      const updatedInvoice = { ...mockInvoice, customerName: "Updated Name" };
      mockInvoiceRepository.save.mockResolvedValue(updatedInvoice);

      const result = await invoiceService.updateInvoice({
        sellerId: "seller-456",
        invoiceId: "invoice-123",
        customerName: "Updated Name",
      });

      expect(result.customerName).toBe("Updated Name");
    });

    it("should recalculate net amount on amount/discount change", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      const updatedInvoice = {
        ...mockInvoice,
        amount: "2000.00",
        discountRate: "10.00",
        netAmount: "1800.0000",
      };
      mockInvoiceRepository.save.mockResolvedValue(updatedInvoice);

      const result = await invoiceService.updateInvoice({
        sellerId: "seller-456",
        invoiceId: "invoice-123",
        amount: "2000.00",
        discountRate: "10.00",
      });

      expect(result.netAmount).toBe("1800.0000");
    });

    it("should reject update of non-draft invoice", async () => {
      const publishedInvoice = { ...mockInvoice, status: InvoiceStatus.PUBLISHED };
      mockInvoiceRepository.findOne.mockResolvedValue(publishedInvoice);

      await expect(
        invoiceService.updateInvoice({
          sellerId: "seller-456",
          invoiceId: "invoice-123",
          customerName: "Updated",
        })
      ).rejects.toMatchObject({
        code: "invalid_invoice_status",
        statusCode: 400,
      });
    });

    it("should throw error for unauthorized update", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.updateInvoice({
          sellerId: "different-seller",
          invoiceId: "invoice-123",
          customerName: "Updated",
        })
      ).rejects.toMatchObject({
        code: "unauthorized_invoice_access",
        statusCode: 403,
      });
    });

    it("should recompute the net amount from the stored discount when only the amount changes", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockInvoiceRepository.save.mockImplementation(async (invoice: Invoice) => invoice);

      const result = await invoiceService.updateInvoice({
        sellerId: "seller-456",
        invoiceId: "invoice-123",
        amount: "2000.00",
      });

      expect(result.discountRate).toBe("5.00");
      expect(result.netAmount).toBe("1900.0000");
    });

    it("should recompute the net amount from the stored amount when only the discount changes", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockInvoiceRepository.save.mockImplementation(async (invoice: Invoice) => invoice);

      const result = await invoiceService.updateInvoice({
        sellerId: "seller-456",
        invoiceId: "invoice-123",
        discountRate: "20",
      });

      expect(result.amount).toBe("1000.00");
      expect(result.netAmount).toBe("800.0000");
    });

    it("should update the due date and risk score without recalculating the net amount", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockInvoiceRepository.save.mockImplementation(async (invoice: Invoice) => invoice);
      const dueDate = new Date("2030-01-15");

      const result = await invoiceService.updateInvoice({
        sellerId: "seller-456",
        invoiceId: "invoice-123",
        dueDate,
        riskScore: "0.75",
      });

      expect(result.dueDate).toEqual(dueDate);
      expect(result.riskScore).toBe("0.75");
      expect(result.netAmount).toBe("950.00");
    });

    it("should reject an invalid amount and not save", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.updateInvoice({
          sellerId: "seller-456",
          invoiceId: "invoice-123",
          amount: "-10",
        })
      ).rejects.toMatchObject({ code: "invalid_amount", statusCode: 400 });
      expect(mockInvoiceRepository.save).not.toHaveBeenCalled();
    });

    it("should report an unexpected failure as a ServiceError, like every other method", async () => {
      // Regression: this path used to throw an AppError, which the controllers'
      // `instanceof ServiceError` handling does not recognise.
      mockInvoiceRepository.findOne.mockRejectedValue(new Error("connection refused: db-primary"));

      const failure = invoiceService.updateInvoice({
        sellerId: "seller-456",
        invoiceId: "invoice-123",
        customerName: "Updated",
      });

      await expect(failure).rejects.toBeInstanceOf(ServiceError);
      await expect(failure).rejects.toMatchObject({
        code: "invoice_update_failed",
        statusCode: 500,
        message: "Failed to update invoice",
      });
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        "Failed to update invoice",
        expect.objectContaining({ invoiceId: "invoice-123" })
      );
    });

    it("should return 404 when invoice not found", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(null);

      await expect(
        invoiceService.updateInvoice({
          sellerId: "seller-456",
          invoiceId: "nonexistent",
          customerName: "Updated",
        })
      ).rejects.toMatchObject({
        code: "invoice_not_found",
        statusCode: 404,
      });
    });
  });

  // ============ DELETE INVOICE TESTS ============
  describe("deleteInvoice", () => {
    it("should soft delete draft invoice", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockInvoiceRepository.save.mockResolvedValue({
        ...mockInvoice,
        deletedAt: new Date(),
      });

      await invoiceService.deleteInvoice("invoice-123", "seller-456");

      expect(mockInvoiceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          deletedAt: expect.any(Date),
        })
      );
    });

    it("should allow deleting a cancelled invoice", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(
        buildInvoice({ status: InvoiceStatus.CANCELLED })
      );
      mockInvoiceRepository.save.mockImplementation(async (invoice: Invoice) => invoice);

      await invoiceService.deleteInvoice("invoice-123", "seller-456");

      expect(mockInvoiceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: expect.any(Date) })
      );
    });

    it("should return 404 when the invoice does not exist", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(null);

      await expect(invoiceService.deleteInvoice("missing", "seller-456")).rejects.toMatchObject({
        code: "invoice_not_found",
        statusCode: 404,
      });
      expect(mockInvoiceRepository.save).not.toHaveBeenCalled();
    });

    it("should not write anything when the caller is not the seller", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.deleteInvoice("invoice-123", "different-seller")
      ).rejects.toMatchObject({ code: "unauthorized_invoice_access" });
      expect(mockInvoiceRepository.save).not.toHaveBeenCalled();
    });

    it("should report an unexpected failure as a ServiceError", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockInvoiceRepository.save.mockRejectedValue(new Error("disk full"));

      const failure = invoiceService.deleteInvoice("invoice-123", "seller-456");

      await expect(failure).rejects.toBeInstanceOf(ServiceError);
      await expect(failure).rejects.toMatchObject({
        code: "invoice_delete_failed",
        statusCode: 500,
        message: "Failed to delete invoice",
      });
    });

    it("should reject deletion of published invoice", async () => {
      const publishedInvoice = { ...mockInvoice, status: InvoiceStatus.PUBLISHED };
      mockInvoiceRepository.findOne.mockResolvedValue(publishedInvoice);

      await expect(invoiceService.deleteInvoice("invoice-123", "seller-456")).rejects.toMatchObject(
        {
          code: "invalid_invoice_status",
          statusCode: 400,
        }
      );
    });

    it("should throw error for unauthorized delete", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.deleteInvoice("invoice-123", "different-seller")
      ).rejects.toMatchObject({
        code: "unauthorized_invoice_access",
        statusCode: 403,
      });
    });
  });

  // ============ PUBLISH INVOICE TESTS ============
  describe("publishInvoice", () => {
    let publishableInvoice: Invoice;

    beforeEach(() => {
      publishableInvoice = buildPublishableInvoice();
    });

    it("should transition draft invoice to published", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue({ ...publishableInvoice });
      const publishedInvoice = { ...publishableInvoice, status: InvoiceStatus.PUBLISHED };
      mockInvoiceRepository.save.mockResolvedValue(publishedInvoice);

      const result = await invoiceService.publishInvoice({
        invoiceId: "invoice-123",
        sellerId: "seller-456",
      });

      expect(result.status).toBe(InvoiceStatus.PUBLISHED);
    });

    it("should reject a due date within 24 hours", async () => {
      const soonDueInvoice = {
        ...mockInvoice,
        dueDate: new Date(Date.now() + 60 * 60 * 1000), // 1 hour in future
        seller: {
          kycStatus: "approved",
          stellarAddress: "GSELLERWALLET1234567890ABCDEFGHIJKLMNOPQRSTUV",
        },
      };
      mockInvoiceRepository.findOne.mockResolvedValue(soonDueInvoice);

      await expect(
        invoiceService.publishInvoice({
          invoiceId: "invoice-123",
          sellerId: "seller-456",
        })
      ).rejects.toMatchObject({
        code: "invoice_not_publishable",
        statusCode: 422,
      });
    });

    it("should reject invalid status transitions", async () => {
      const settledInvoice = {
        ...mockInvoice,
        status: InvoiceStatus.SETTLED,
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        seller: {
          kycStatus: "approved",
          stellarAddress: "GSELLERWALLET1234567890ABCDEFGHIJKLMNOPQRSTUV",
        },
      };
      mockInvoiceRepository.findOne.mockResolvedValue(settledInvoice);

      await expect(
        invoiceService.publishInvoice({
          invoiceId: "invoice-123",
          sellerId: "seller-456",
        })
      ).rejects.toMatchObject({
        code: "invalid_status_transition",
        statusCode: 422,
      });
    });

    it("should throw error for unauthorized publish", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(publishableInvoice);

      await expect(
        invoiceService.publishInvoice({
          invoiceId: "invoice-123",
          sellerId: "different-seller",
        })
      ).rejects.toMatchObject({
        code: "unauthorized_invoice_access",
        statusCode: 403,
      });
    });

    it("should not let the seller publish an invoice that is under review", async () => {
      // pending → published is the admin approval step (issue #468).
      const pendingInvoice = { ...publishableInvoice, status: InvoiceStatus.PENDING };
      mockInvoiceRepository.findOne.mockResolvedValue(pendingInvoice);

      await expect(
        invoiceService.publishInvoice({
          invoiceId: "invoice-123",
          sellerId: "seller-456",
        })
      ).rejects.toMatchObject({ code: "transition_not_permitted", statusCode: 403 });
      expect(mockInvoiceRepository.save).not.toHaveBeenCalled();
    });

    it("should allow an admin to approve a pending invoice", async () => {
      const pendingInvoice = { ...publishableInvoice, status: InvoiceStatus.PENDING };
      mockInvoiceRepository.findOne.mockResolvedValue(pendingInvoice);
      mockInvoiceRepository.save.mockImplementation(async (invoice: unknown) => invoice);

      const result = await invoiceService.approveInvoice({ invoiceId: "invoice-123" });

      expect(result.status).toBe(InvoiceStatus.PUBLISHED);
    });

    it("should return 404 when the invoice to publish does not exist", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(null);

      await expect(
        invoiceService.publishInvoice({ invoiceId: "missing", sellerId: "seller-456" })
      ).rejects.toMatchObject({ code: "invoice_not_found", statusCode: 404 });
    });

    it("should reject publish when the seller relation was not loaded", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue({ ...publishableInvoice, seller: undefined });

      await expect(
        invoiceService.publishInvoice({ invoiceId: "invoice-123", sellerId: "seller-456" })
      ).rejects.toMatchObject({ code: "kyc_approval_required", statusCode: 403 });
      expect(mockInvoiceRepository.save).not.toHaveBeenCalled();
    });

    it("should report an unexpected failure as a ServiceError", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue({ ...publishableInvoice });
      mockInvoiceRepository.save.mockRejectedValue(new Error("write conflict"));

      const failure = invoiceService.publishInvoice({
        invoiceId: "invoice-123",
        sellerId: "seller-456",
      });

      await expect(failure).rejects.toBeInstanceOf(ServiceError);
      await expect(failure).rejects.toMatchObject({
        code: "invoice_publish_failed",
        statusCode: 500,
        message: "Failed to publish invoice",
      });
    });

    it("should reject publish for seller without KYC approval", async () => {
      const invoiceWithPendingKYC = {
        ...publishableInvoice,
        status: InvoiceStatus.DRAFT,
        seller: {
          kycStatus: "pending",
          stellarAddress: "GSELLERWALLET1234567890ABCDEFGHIJKLMNOPQRSTUV",
        },
      };
      mockInvoiceRepository.findOne.mockResolvedValue(invoiceWithPendingKYC);

      await expect(
        invoiceService.publishInvoice({
          invoiceId: "invoice-123",
          sellerId: "seller-456",
        })
      ).rejects.toMatchObject({
        code: "kyc_approval_required",
        statusCode: 403,
      });
    });

    it("should reject publishing an invoice that fails pre-publish validation", async () => {
      const invalidInvoice = { ...publishableInvoice, status: InvoiceStatus.DRAFT, ipfsHash: null };
      mockInvoiceRepository.findOne.mockResolvedValue(invalidInvoice);

      await expect(
        invoiceService.publishInvoice({
          invoiceId: "invoice-123",
          sellerId: "seller-456",
        })
      ).rejects.toMatchObject({
        code: "invoice_not_publishable",
        statusCode: 422,
      });
      expect(mockInvoiceRepository.save).not.toHaveBeenCalled();
    });
  });

  // ============ UPLOAD DOCUMENT TESTS ============
  describe("uploadDocument", () => {
    const uploadInput = {
      invoiceId: "invoice-123",
      sellerId: "seller-456",
      fileBuffer: Buffer.from("test file"),
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    };

    it("should successfully upload document for valid invoice", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockIPFSService.uploadFile.mockResolvedValue({
        hash: "QmTestHash123",
        size: 1024,
        timestamp: "2024-01-01T00:00:00.000Z",
      });

      const updatedInvoice = { ...mockInvoice, ipfsHash: "QmTestHash123" };
      mockInvoiceRepository.save.mockResolvedValue(updatedInvoice);

      const result = await invoiceService.uploadDocument(uploadInput);

      expect(result).toEqual({
        invoiceId: "invoice-123",
        ipfsHash: "QmTestHash123",
        fileSize: 1024,
        uploadedAt: "2024-01-01T00:00:00.000Z",
      });

      expect(mockInvoiceRepository.findOne).toHaveBeenCalledWith({
        where: { id: "invoice-123" },
      });
      expect(mockIPFSService.uploadFile).toHaveBeenCalledWith(
        uploadInput.fileBuffer,
        uploadInput.filename,
        uploadInput.mimeType,
        "invoice-123"
      );
      expect(mockInvoiceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          ipfsHash: "QmTestHash123",
        })
      );
    });

    it("should throw error when invoice not found", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(null);

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toThrow(ServiceError);

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toMatchObject({
        code: "invoice_not_found",
        statusCode: 404,
      });
    });

    it("should throw error when user is not the seller", async () => {
      const wrongSellerInvoice = { ...mockInvoice, sellerId: "different-seller" };
      mockInvoiceRepository.findOne.mockResolvedValue(wrongSellerInvoice);

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toThrow(ServiceError);

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toMatchObject({
        code: "unauthorized_invoice_access",
        statusCode: 403,
      });
    });

    it.each([
      { invoiceId: "  ", sellerId: "seller-456", note: "blank invoice id" },
      { invoiceId: "invoice-123", sellerId: "", note: "blank seller id" },
    ])("should reject $note before doing any work", async ({ invoiceId, sellerId }) => {
      await expect(
        invoiceService.uploadDocument({ ...uploadInput, invoiceId, sellerId })
      ).rejects.toMatchObject({ code: "invalid_input", statusCode: 400 });

      expect(mockInvoiceRepository.findOne).not.toHaveBeenCalled();
      expect(mockIPFSService.uploadFile).not.toHaveBeenCalled();
    });

    it("should reject an empty file before doing any work", async () => {
      await expect(
        invoiceService.uploadDocument({ ...uploadInput, fileBuffer: Buffer.alloc(0) })
      ).rejects.toMatchObject({ code: "empty_file", statusCode: 400 });

      expect(mockIPFSService.uploadFile).not.toHaveBeenCalled();
    });

    it("should trim the ids, filename and mime type it forwards to IPFS", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockIPFSService.uploadFile.mockResolvedValue({ hash: "QmH", size: 9, timestamp: "t" });
      mockInvoiceRepository.save.mockImplementation(async (invoice: Invoice) => invoice);

      await invoiceService.uploadDocument({
        ...uploadInput,
        invoiceId: "  invoice-123 ",
        sellerId: " seller-456  ",
        filename: "  invoice.pdf ",
        mimeType: " application/pdf  ",
      });

      expect(mockIPFSService.uploadFile).toHaveBeenCalledWith(
        uploadInput.fileBuffer,
        "invoice.pdf",
        "application/pdf",
        "invoice-123"
      );
    });

    it("should map an unexpected IPFS failure to a 502 without saving the invoice", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockIPFSService.uploadFile.mockRejectedValue(new Error("ECONNRESET from ipfs-gateway"));

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toMatchObject({
        code: "ipfs_upload_failed",
        statusCode: 502,
        message: "Failed to upload document to IPFS",
      });
      expect(mockInvoiceRepository.save).not.toHaveBeenCalled();
    });

    it("should report a failing save after a successful upload as a ServiceError", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockIPFSService.uploadFile.mockResolvedValue({ hash: "QmH", size: 9, timestamp: "t" });
      mockInvoiceRepository.save.mockRejectedValue(new Error("write failed"));

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toMatchObject({
        code: "document_upload_failed",
        statusCode: 500,
      });
    });

    it("should propagate IPFS service errors", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockIPFSService.uploadFile.mockRejectedValue(
        new ServiceError("file_too_large", "File too large", 400)
      );

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toThrow(ServiceError);

      await expect(invoiceService.uploadDocument(uploadInput)).rejects.toMatchObject({
        code: "file_too_large",
        statusCode: 400,
      });
    });
  });
  // ============ STATE-MACHINE BACKED TRANSITIONS ============
  describe("status transitions", () => {
    let stateMachine: { transition: jest.Mock; dispatch: jest.Mock };
    let service: InvoiceService;

    beforeEach(() => {
      stateMachine = {
        transition: jest.fn(async (_store: unknown, invoice: Invoice, to: InvoiceStatus) => ({
          invoice: { ...invoice, status: to },
          from: invoice.status,
          to,
        })),
        dispatch: jest.fn().mockResolvedValue(undefined),
      };
      service = new InvoiceService({
        invoiceRepository: mockInvoiceRepository,
        ipfsService: mockIPFSService,
        stateMachine: stateMachine as never,
      });
    });

    describe("rejectInvoice", () => {
      it("should reject an invoice as an admin, recording the trimmed reason", async () => {
        mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

        const result = await service.rejectInvoice({
          invoiceId: "  invoice-123 ",
          rejectionReason: "  Duplicate invoice  ",
          actorId: "admin-1",
        });

        expect(result.status).toBe(InvoiceStatus.REJECTED);
        expect(mockInvoiceRepository.findOne).toHaveBeenCalledWith({
          where: { id: "invoice-123" },
          relations: ["seller"],
        });
        expect(stateMachine.transition).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({ id: "invoice-123" }),
          InvoiceStatus.REJECTED,
          {
            actor: { role: "admin", id: "admin-1" },
            trigger: "admin_rejected",
            context: { reason: "Duplicate invoice" },
          }
        );
        expect(stateMachine.dispatch).toHaveBeenCalledTimes(1);
      });

      it("should record a null actor when the admin is unknown", async () => {
        mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

        await service.rejectInvoice({ invoiceId: "invoice-123", rejectionReason: "No PO" });

        expect(stateMachine.transition).toHaveBeenCalledWith(
          expect.any(Object),
          expect.any(Object),
          InvoiceStatus.REJECTED,
          expect.objectContaining({ actor: { role: "admin", id: null } })
        );
      });

      it.each([
        { input: { invoiceId: "  ", rejectionReason: "Reason" }, code: "invalid_invoice_id" },
        {
          input: { invoiceId: "invoice-123", rejectionReason: "   " },
          code: "invalid_rejection_reason",
        },
      ])("should reject invalid input ($code) before querying", async ({ input, code }) => {
        await expect(service.rejectInvoice(input)).rejects.toMatchObject({ code, statusCode: 400 });

        expect(mockInvoiceRepository.findOne).not.toHaveBeenCalled();
        expect(stateMachine.transition).not.toHaveBeenCalled();
      });

      it("should return 404 for an unknown invoice", async () => {
        mockInvoiceRepository.findOne.mockResolvedValue(null);

        await expect(
          service.rejectInvoice({ invoiceId: "missing", rejectionReason: "Reason" })
        ).rejects.toMatchObject({ code: "invoice_not_found", statusCode: 404 });
      });

      it("should answer 409 when the invoice was already rejected", async () => {
        mockInvoiceRepository.findOne.mockResolvedValue(
          buildInvoice({ status: InvoiceStatus.REJECTED })
        );

        await expect(
          service.rejectInvoice({ invoiceId: "invoice-123", rejectionReason: "Again" })
        ).rejects.toMatchObject({ code: "invoice_already_rejected", statusCode: 409 });
        expect(stateMachine.transition).not.toHaveBeenCalled();
      });

      it("should not dispatch side effects when the transition itself fails", async () => {
        mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
        stateMachine.transition.mockRejectedValue(
          new ServiceError("invalid_status_transition", "Not allowed", 422)
        );

        await expect(
          service.rejectInvoice({ invoiceId: "invoice-123", rejectionReason: "Reason" })
        ).rejects.toMatchObject({ code: "invalid_status_transition" });
        expect(stateMachine.dispatch).not.toHaveBeenCalled();
      });
    });

    describe("submitInvoiceForReview", () => {
      it("should move a draft to pending on behalf of its seller", async () => {
        mockInvoiceRepository.findOne.mockResolvedValue({
          ...mockInvoice,
          seller: APPROVED_SELLER,
        });

        const result = await service.submitInvoiceForReview({
          invoiceId: "invoice-123",
          sellerId: "seller-456",
        });

        expect(result.status).toBe(InvoiceStatus.PENDING);
        expect(stateMachine.transition).toHaveBeenCalledWith(
          expect.any(Object),
          expect.any(Object),
          InvoiceStatus.PENDING,
          {
            actor: { role: "seller", id: "seller-456", wallet: APPROVED_SELLER.stellarAddress },
            trigger: "seller_submitted",
          }
        );
      });

      it("should tolerate a missing seller relation", async () => {
        mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

        await service.submitInvoiceForReview({ invoiceId: "invoice-123", sellerId: "seller-456" });

        expect(stateMachine.transition).toHaveBeenCalledWith(
          expect.any(Object),
          expect.any(Object),
          InvoiceStatus.PENDING,
          expect.objectContaining({ actor: { role: "seller", id: "seller-456", wallet: null } })
        );
      });

      it("should answer 404, not 403, for another seller's invoice so its existence is not revealed", async () => {
        mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

        await expect(
          service.submitInvoiceForReview({ invoiceId: "invoice-123", sellerId: "intruder" })
        ).rejects.toMatchObject({ code: "invoice_not_found", statusCode: 404 });
        expect(stateMachine.transition).not.toHaveBeenCalled();
      });
    });

    describe("approveInvoice", () => {
      it("should publish a pending invoice with the admin as actor", async () => {
        mockInvoiceRepository.findOne.mockResolvedValue(
          buildInvoice({ status: InvoiceStatus.PENDING })
        );

        const result = await service.approveInvoice({
          invoiceId: "invoice-123",
          actorId: "admin-7",
        });

        expect(result.status).toBe(InvoiceStatus.PUBLISHED);
        expect(stateMachine.transition).toHaveBeenCalledWith(
          expect.any(Object),
          expect.any(Object),
          InvoiceStatus.PUBLISHED,
          { actor: { role: "admin", id: "admin-7" }, trigger: "admin_approved" }
        );
      });

      it("should return 404 for an unknown invoice", async () => {
        mockInvoiceRepository.findOne.mockResolvedValue(null);

        await expect(service.approveInvoice({ invoiceId: "missing" })).rejects.toMatchObject({
          code: "invoice_not_found",
          statusCode: 404,
        });
      });
    });

    describe("transactional persistence", () => {
      it("should run the transition inside a database transaction and dispatch after it commits", async () => {
        const order: string[] = [];
        const manager = { save: jest.fn() };
        const dataSource = {
          transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) => {
            order.push("transaction:start");
            const result = await work(manager);
            order.push("transaction:commit");
            return result;
          }),
        };
        stateMachine.dispatch.mockImplementation(async () => {
          order.push("dispatch");
        });
        mockInvoiceRepository.findOne.mockResolvedValue(
          buildInvoice({ status: InvoiceStatus.PENDING })
        );

        const transactional = new InvoiceService({
          invoiceRepository: mockInvoiceRepository,
          ipfsService: mockIPFSService,
          dataSource: dataSource as never,
          stateMachine: stateMachine as never,
        });
        await transactional.approveInvoice({ invoiceId: "invoice-123" });

        expect(order).toEqual(["transaction:start", "transaction:commit", "dispatch"]);
        expect(mockInvoiceRepository.save).not.toHaveBeenCalled();
      });

      it("should not dispatch side effects when the transaction rolls back", async () => {
        const dataSource = { transaction: jest.fn().mockRejectedValue(new Error("rollback")) };
        mockInvoiceRepository.findOne.mockResolvedValue(
          buildInvoice({ status: InvoiceStatus.PENDING })
        );

        const transactional = new InvoiceService({
          invoiceRepository: mockInvoiceRepository,
          ipfsService: mockIPFSService,
          dataSource: dataSource as never,
          stateMachine: stateMachine as never,
        });

        await expect(transactional.approveInvoice({ invoiceId: "invoice-123" })).rejects.toThrow(
          "rollback"
        );
        expect(stateMachine.dispatch).not.toHaveBeenCalled();
      });
    });
  });

  // ============ STATUS HISTORY ============
  describe("getInvoiceStatusHistory", () => {
    const historyRow = (id: string, createdAt: string) => ({
      id,
      invoiceId: "invoice-123",
      fromStatus: InvoiceStatus.DRAFT,
      toStatus: InvoiceStatus.PENDING,
      actorRole: "seller",
      actorId: "seller-456",
      trigger: "seller_submitted",
      reason: null,
      createdAt: new Date(createdAt),
      internalOnly: "must-not-leak",
    });

    it("should hide another seller's invoice behind a 404", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.getInvoiceStatusHistory("invoice-123", "intruder")
      ).rejects.toMatchObject({ code: "invoice_not_found", statusCode: 404 });
    });

    it("should return 404 for an unknown invoice", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(null);

      await expect(
        invoiceService.getInvoiceStatusHistory("missing", "seller-456")
      ).rejects.toMatchObject({ code: "invoice_not_found", statusCode: 404 });
    });

    it("should return an empty history when no database is configured", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.getInvoiceStatusHistory("invoice-123", "seller-456")
      ).resolves.toEqual([]);
    });

    it("should return rows oldest first, exposing only the public fields", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      const find = jest
        .fn()
        .mockResolvedValue([historyRow("h1", "2025-01-01"), historyRow("h2", "2025-01-02")]);
      const service = new InvoiceService({
        invoiceRepository: mockInvoiceRepository,
        ipfsService: mockIPFSService,
        dataSource: { getRepository: jest.fn().mockReturnValue({ find }) } as never,
      });

      const history = await service.getInvoiceStatusHistory("invoice-123", "seller-456");

      expect(find).toHaveBeenCalledWith({
        where: { invoiceId: "invoice-123" },
        order: { createdAt: "ASC" },
      });
      expect(history.map((row) => row.id)).toEqual(["h1", "h2"]);
      expect(history[0]).toEqual({
        id: "h1",
        fromStatus: InvoiceStatus.DRAFT,
        toStatus: InvoiceStatus.PENDING,
        actorRole: "seller",
        actorId: "seller-456",
        trigger: "seller_submitted",
        reason: null,
        createdAt: new Date("2025-01-01"),
      });
    });
  });

  // ============ BATCH PUBLISH ============
  describe("publishInvoicesBatch", () => {
    let stateMachine: { transition: jest.Mock; dispatch: jest.Mock };
    let dataSource: { transaction: jest.Mock };
    let service: InvoiceService;

    const publishable = (id: string, overrides: Record<string, unknown> = {}) =>
      buildPublishableInvoice({ id, invoiceNumber: `INV-${id}`, ...overrides });

    /** Runs the batch and returns the ServiceError it must throw. */
    const captureBatchError = async (input: {
      invoiceIds: string[];
      sellerId: string;
    }): Promise<ServiceError> => {
      try {
        await service.publishInvoicesBatch(input);
      } catch (error) {
        return error as ServiceError;
      }
      throw new Error("expected publishInvoicesBatch to reject");
    };

    beforeEach(() => {
      stateMachine = {
        transition: jest.fn(async (_store: unknown, invoice: Invoice, to: InvoiceStatus) => ({
          invoice: { ...invoice, status: to },
          from: invoice.status,
          to,
        })),
        dispatch: jest.fn().mockResolvedValue(undefined),
      };
      dataSource = {
        transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) => work({})),
      };
      service = new InvoiceService({
        invoiceRepository: mockInvoiceRepository,
        ipfsService: mockIPFSService,
        dataSource: dataSource as never,
        stateMachine: stateMachine as never,
      });
    });

    it("should reject an empty batch", async () => {
      await expect(
        service.publishInvoicesBatch({ invoiceIds: [], sellerId: "seller-456" })
      ).rejects.toMatchObject({ code: "empty_batch", statusCode: 400 });
    });

    it("should be unavailable without a database connection", async () => {
      const noDb = new InvoiceService({
        invoiceRepository: mockInvoiceRepository,
        ipfsService: mockIPFSService,
      });

      await expect(
        noDb.publishInvoicesBatch({ invoiceIds: ["a"], sellerId: "seller-456" })
      ).rejects.toMatchObject({ code: "batch_publish_unavailable", statusCode: 503 });
      expect(mockInvoiceRepository.find).not.toHaveBeenCalled();
    });

    it("should publish every invoice with one query, de-duplicating ids", async () => {
      mockInvoiceRepository.find.mockResolvedValue([publishable("a"), publishable("b")]);

      const result = await service.publishInvoicesBatch({
        invoiceIds: ["a", "b", "a"],
        sellerId: "seller-456",
      });

      expect(mockInvoiceRepository.find).toHaveBeenCalledTimes(1);
      const { where, relations } = mockInvoiceRepository.find.mock.calls[0][0];
      expect(where.id.value).toEqual(["a", "b"]);
      expect(relations).toEqual(["seller"]);

      expect(result.count).toBe(2);
      expect(result.published.map((inv) => [inv.id, inv.status])).toEqual([
        ["a", InvoiceStatus.PUBLISHED],
        ["b", InvoiceStatus.PUBLISHED],
      ]);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(stateMachine.transition).toHaveBeenCalledTimes(2);
      expect(stateMachine.transition).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        InvoiceStatus.PUBLISHED,
        {
          actor: { role: "seller", id: "seller-456", wallet: APPROVED_SELLER.stellarAddress },
          trigger: "seller_batch_published",
        }
      );
      expect(stateMachine.dispatch).toHaveBeenCalledTimes(2);
    });

    it("should be all-or-nothing, naming every invoice that failed and why", async () => {
      mockInvoiceRepository.find.mockResolvedValue([
        publishable("ok"),
        publishable("theirs", { sellerId: "someone-else" }),
        publishable("settled", { status: InvoiceStatus.SETTLED }),
        publishable("no-doc", { ipfsHash: null }),
      ]);

      const error = await captureBatchError({
        invoiceIds: ["ok", "missing", "theirs", "settled", "no-doc"],
        sellerId: "seller-456",
      });

      expect(error).toMatchObject({
        code: "batch_publish_rejected",
        statusCode: 400,
        message: "4 of 5 invoices cannot be published; no invoices were changed",
      });
      const rejections = (
        error.details as { rejections: Array<{ invoiceId: string; code: string }> }
      ).rejections;
      expect(rejections.map(({ invoiceId, code }) => [invoiceId, code])).toEqual([
        ["missing", "invoice_not_found"],
        ["theirs", "unauthorized_invoice_access"],
        ["settled", "invalid_status_transition"],
        ["no-doc", "invoice_not_publishable"],
      ]);

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(stateMachine.transition).not.toHaveBeenCalled();
      expect(stateMachine.dispatch).not.toHaveBeenCalled();
    });

    it("should not reveal whether another seller's invoice exists", async () => {
      mockInvoiceRepository.find.mockResolvedValue([
        publishable("theirs", { sellerId: "someone-else" }),
      ]);

      const error = await captureBatchError({ invoiceIds: ["theirs"], sellerId: "seller-456" });

      const [rejection] = (error.details as { rejections: Array<{ message: string }> }).rejections;
      expect(rejection.message).toBe("Invoice not found");
    });

    it("should require KYC approval for the whole batch", async () => {
      mockInvoiceRepository.find.mockResolvedValue([
        publishable("a", { seller: { ...APPROVED_SELLER, kycStatus: KYCStatus.PENDING } }),
      ]);

      await expect(
        service.publishInvoicesBatch({ invoiceIds: ["a"], sellerId: "seller-456" })
      ).rejects.toMatchObject({ code: "kyc_approval_required", statusCode: 403 });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("should surface a failed fetch as batch_fetch_failed", async () => {
      mockInvoiceRepository.find.mockRejectedValue(new Error("pool exhausted"));

      await expect(
        service.publishInvoicesBatch({ invoiceIds: ["a"], sellerId: "seller-456" })
      ).rejects.toMatchObject({ code: "batch_fetch_failed", statusCode: 500 });
    });

    it("should dispatch nothing if a transition fails partway through the transaction", async () => {
      mockInvoiceRepository.find.mockResolvedValue([publishable("a"), publishable("b")]);
      stateMachine.transition
        .mockImplementationOnce(async (_s: unknown, invoice: Invoice, to: InvoiceStatus) => ({
          invoice: { ...invoice, status: to },
          from: invoice.status,
          to,
        }))
        .mockRejectedValueOnce(new Error("second write failed"));

      await expect(
        service.publishInvoicesBatch({ invoiceIds: ["a", "b"], sellerId: "seller-456" })
      ).rejects.toThrow("second write failed");
      expect(stateMachine.dispatch).not.toHaveBeenCalled();
    });
  });

  // ============ TOKEN HOLDERS ============
  describe("getInvoiceTokenHolders", () => {
    const publishedInvoice = () => buildInvoice({ status: InvoiceStatus.PUBLISHED });

    const serviceWithInvestments = (investments: unknown[]) => {
      const queryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(investments),
      };
      const dataSource = {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        }),
      };
      return {
        queryBuilder,
        service: new InvoiceService({
          invoiceRepository: mockInvoiceRepository,
          ipfsService: mockIPFSService,
          dataSource: dataSource as never,
        }),
      };
    };

    const investment = (
      amount: string,
      stellarAddress: string | null,
      createdAt = "2025-02-01"
    ) => ({
      investmentAmount: amount,
      createdAt: new Date(createdAt),
      investor: { stellarAddress },
    });

    it("should return 404 for an unknown invoice", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(null);

      await expect(
        invoiceService.getInvoiceTokenHolders("missing", "seller-456")
      ).rejects.toMatchObject({
        code: "invoice_not_found",
        statusCode: 404,
      });
    });

    it("should only show holders to the invoice's seller", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(publishedInvoice());

      await expect(
        invoiceService.getInvoiceTokenHolders("invoice-123", "intruder")
      ).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
    });

    it("should refuse to list holders of a draft", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.getInvoiceTokenHolders("invoice-123", "seller-456")
      ).rejects.toMatchObject({ code: "invalid_invoice_status", statusCode: 400 });
    });

    it("should fail clearly when no database connection is available", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(publishedInvoice());

      await expect(
        invoiceService.getInvoiceTokenHolders("invoice-123", "seller-456")
      ).rejects.toMatchObject({ code: "internal_error", statusCode: 500 });
    });

    it("should return an empty list when nobody has invested", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(publishedInvoice());
      const { service } = serviceWithInvestments([]);

      await expect(service.getInvoiceTokenHolders("invoice-123", "seller-456")).resolves.toEqual(
        []
      );
    });

    it("should compute each holder's share and truncate wallet addresses", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(publishedInvoice());
      const { service, queryBuilder } = serviceWithInvestments([
        investment("100", "GABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        investment("200", "GSHORT"),
      ]);

      const holders = await service.getInvoiceTokenHolders("invoice-123", "seller-456");

      expect(holders).toEqual([
        {
          wallet: "GABC...WXYZ",
          amount: "100",
          share_percent: "33.33",
          committed_at: new Date("2025-02-01"),
        },
        {
          wallet: "GSHORT",
          amount: "200",
          share_percent: "66.67",
          committed_at: new Date("2025-02-01"),
        },
      ]);
      expect(queryBuilder.where).toHaveBeenCalledWith("investment.invoiceId = :invoiceId", {
        invoiceId: "invoice-123",
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith("investment.deletedAt IS NULL");
    });

    it("should never expose a full wallet address", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(publishedInvoice());
      const address = "GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRS";
      const { service } = serviceWithInvestments([investment("50", address)]);

      const [holder] = await service.getInvoiceTokenHolders("invoice-123", "seller-456");

      expect(holder.wallet).not.toBe(address);
      expect(holder.wallet).toBe(`${address.slice(0, 4)}...${address.slice(-4)}`);
    });

    it("should report a 0% share, not NaN, when the total invested is zero", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(publishedInvoice());
      const { service } = serviceWithInvestments([
        investment("0", "GAAAAAAAAAAAA"),
        investment("0", "GBBBBBBBBBBBB"),
      ]);

      const holders = await service.getInvoiceTokenHolders("invoice-123", "seller-456");

      expect(holders.map((holder) => holder.share_percent)).toEqual(["0.00", "0.00"]);
    });

    it("should tolerate an investor without a stored address", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(publishedInvoice());
      const { service } = serviceWithInvestments([investment("10", null)]);

      const [holder] = await service.getInvoiceTokenHolders("invoice-123", "seller-456");

      expect(holder.wallet).toBe("");
      expect(holder.share_percent).toBe("100.00");
    });
  });

  // ============ ESCROW STATUS ============
  describe("getInvoiceEscrowStatus", () => {
    it("should return 404 for an unknown invoice", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(null);

      await expect(invoiceService.getInvoiceEscrowStatus("missing")).rejects.toMatchObject({
        code: "invoice_not_found",
        statusCode: 404,
      });
    });

    it("should return 404 when no escrow contract has been deployed", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);

      await expect(invoiceService.getInvoiceEscrowStatus("invoice-123")).rejects.toMatchObject({
        code: "no_escrow_contract",
        statusCode: 404,
      });
    });

    it("should report the deployed contract and the invoice's current status", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(
        buildInvoice({ smartContractId: "CCONTRACT123", status: InvoiceStatus.PUBLISHED })
      );

      await expect(invoiceService.getInvoiceEscrowStatus("invoice-123")).resolves.toEqual({
        invoiceId: "invoice-123",
        hasEscrow: true,
        contractId: "CCONTRACT123",
        status: InvoiceStatus.PUBLISHED,
      });
    });
  });
});
