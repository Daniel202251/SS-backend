import { InvoiceService } from "../src/services/invoice.service";
import { ServiceError } from "../src/utils/service-error";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceStatus } from "../src/types/enums";

describe("InvoiceService", () => {
  let mockInvoiceRepository: any;
  let mockIPFSService: any;
  let invoiceService: InvoiceService;

  const mockInvoice = {
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
  } as Invoice;

  beforeEach(() => {
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

    it("should calculate net amount correctly", async () => {
      mockInvoiceRepository.findOneBy.mockResolvedValue(null);
      mockInvoiceRepository.create.mockReturnValue({
        ...mockInvoice,
        amount: "1000.00",
        discountRate: "10.00",
      });
      mockInvoiceRepository.save.mockResolvedValue({
        ...mockInvoice,
        amount: "1000.00",
        discountRate: "10.00",
        netAmount: "900.0000",
      });

      const result = await invoiceService.createInvoice({
        sellerId: "seller-456",
        invoiceNumber: "INV-001",
        customerName: "Test Customer",
        amount: "1000.00",
        discountRate: "10.00",
        dueDate: new Date("2024-12-31"),
      });

      expect(result.netAmount).toBe("900.0000");
    });

    it("should calculate net amount precisely for values where floating-point arithmetic rounds wrong", async () => {
      mockInvoiceRepository.findOneBy.mockResolvedValue(null);
      mockInvoiceRepository.create.mockImplementation((data: Partial<Invoice>) => ({
        ...mockInvoice,
        ...data,
      }));
      mockInvoiceRepository.save.mockImplementation(async (invoice: Invoice) => invoice);

      // 29.99 - 29.99 * 0.5 / 100: naive `parseFloat` arithmetic here used to
      // produce "29.8400" instead of the correct "29.8401" because 29.99 and
      // 0.5 aren't exactly representable as IEEE-754 doubles.
      const result = await invoiceService.createInvoice({
        sellerId: "seller-456",
        invoiceNumber: "INV-002",
        customerName: "Test Customer",
        amount: "29.99",
        discountRate: "0.5",
        dueDate: new Date("2024-12-31"),
      });

      expect(mockInvoiceRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ netAmount: "29.8401" })
      );
      expect(result.netAmount).toBe("29.8401");
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
    ])(
      "computes netAmount = $expected for $amount @ $discountRate% ($note)",
      async ({ amount, discountRate, expected }) => {
        wireCreatePassthrough();

        const result = await invoiceService.createInvoice(
          buildCreateInput({ amount, discountRate }),
        );

        expect(mockInvoiceRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ netAmount: expected }),
        );
        expect(result.netAmount).toBe(expected);
      },
    );

    it("should reject duplicate invoice number", async () => {
      mockInvoiceRepository.findOneBy.mockResolvedValue(mockInvoice);

      await expect(
        invoiceService.createInvoice(buildCreateInput()),
      ).rejects.toThrow(ServiceError);

      await expect(
        invoiceService.createInvoice(buildCreateInput()),
      ).rejects.toMatchObject({
        code: "invoice_number_exists",
        statusCode: 409,
      });

      expect(mockInvoiceRepository.save).not.toHaveBeenCalled();
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
    const publishableInvoice = {
      ...mockInvoice,
      dueDate: new Date(Date.now() + 48 * 60 * 60 * 1000),
      ipfsHash: "QmTestHash",
      seller: {
        kycStatus: "approved",
        stellarAddress: "GSELLERWALLET1234567890ABCDEFGHIJKLMNOPQRSTUV",
      },
    } as Invoice;

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

  // ============ REPOSITORY ERROR HANDLING ============
  describe("repository error handling", () => {
    it("should propagate database errors on createInvoice", async () => {
      mockInvoiceRepository.findOneBy.mockResolvedValue(null);
      mockInvoiceRepository.create.mockReturnValue(mockInvoice);
      mockInvoiceRepository.save.mockRejectedValue(new Error("Connection refused"));

      await expect(invoiceService.createInvoice(buildCreateInput())).rejects.toThrow(
        /Connection refused|Failed to create invoice/,
      );
    });

    it("should propagate database errors on getInvoiceById", async () => {
      mockInvoiceRepository.findOne.mockRejectedValue(new Error("Query timeout"));

      await expect(invoiceService.getInvoiceById("invoice-123")).rejects.toThrow(
        /Query timeout|Failed to fetch invoice/,
      );
    });

    it("should propagate database errors on updateInvoice", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockInvoiceRepository.save.mockRejectedValue(new Error("Deadlock detected"));

      await expect(
        invoiceService.updateInvoice({
          sellerId: "seller-456",
          invoiceId: "invoice-123",
          customerName: "Updated",
        }),
      ).rejects.toThrow(/Deadlock detected|Processing failed/);
    });

    it("should propagate database errors on deleteInvoice", async () => {
      mockInvoiceRepository.findOne.mockResolvedValue(mockInvoice);
      mockInvoiceRepository.save.mockRejectedValue(new Error("Storage full"));

      await expect(
        invoiceService.deleteInvoice("invoice-123", "seller-456"),
      ).rejects.toThrow(/Storage full|Processing failed/);
    });
  });

  // ============ EDGE CASES ============
  describe("edge cases", () => {
    it("should handle zero discount rate correctly", async () => {
      wireCreatePassthrough();

      const result = await invoiceService.createInvoice(
        buildCreateInput({ amount: "500.00", discountRate: "0.00" }),
      );

      expect(result.netAmount).toBe("500.0000");
    });

    it("should handle 100% discount rate (free invoice)", async () => {
      wireCreatePassthrough();

      const result = await invoiceService.createInvoice(
        buildCreateInput({ amount: "100.00", discountRate: "100.00" }),
      );

      expect(result.netAmount).toBe("0.0000");
    });

    it("should handle very large amounts without precision loss", async () => {
      wireCreatePassthrough();

      const result = await invoiceService.createInvoice(
        buildCreateInput({ amount: "99999999.99", discountRate: "10.00" }),
      );

      expect(result.netAmount).toBe("89999999.9910");
    });

    it("should reject invoice with empty invoice number", async () => {
      await expect(
        invoiceService.createInvoice(buildCreateInput({ invoiceNumber: "" })),
      ).rejects.toThrow();
    });

    it("should reject invoice with empty customer name", async () => {
      await expect(
        invoiceService.createInvoice(buildCreateInput({ customerName: "" })),
      ).rejects.toThrow();
    });

    it("should handle getInvoicesBySellerId with empty result", async () => {
      mockInvoiceRepository.find.mockResolvedValue([]);
      mockInvoiceRepository.count.mockResolvedValue(0);

      const result = await invoiceService.getInvoicesBySellerId({
        sellerId: "seller-no-invoices",
      });

      expect(result.invoices).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });
});
