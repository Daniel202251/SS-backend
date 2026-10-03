import { MarketplaceService } from "../src/services/marketplace.service";
import { InvoiceStatus } from "../src/types/enums";
import { Invoice } from "../src/models/Invoice.model";

describe("MarketplaceService", () => {
  let mockMarketplaceRepository: any;
  let marketplaceService: MarketplaceService;

  const mockInvoices: Invoice[] = [
    {
      id: "invoice-1",
      sellerId: "seller-1",
      invoiceNumber: "INV-001",
      customerName: "Customer A",
      amount: "1000.00",
      discountRate: "5.00",
      netAmount: "950.00",
      dueDate: new Date("2024-12-31"),
      ipfsHash: "QmHash1",
      riskScore: "3.5",
      status: InvoiceStatus.PUBLISHED,
      smartContractId: "contract-1",
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
      deletedAt: null,
    } as Invoice,
    {
      id: "invoice-2",
      sellerId: "seller-2",
      invoiceNumber: "INV-002",
      customerName: "Customer B",
      amount: "2000.00",
      discountRate: "3.00",
      netAmount: "1940.00",
      dueDate: new Date("2024-11-30"),
      ipfsHash: "QmHash2",
      riskScore: "2.1",
      status: InvoiceStatus.PUBLISHED,
      smartContractId: "contract-2",
      createdAt: new Date("2024-01-02"),
      updatedAt: new Date("2024-01-02"),
      deletedAt: null,
    } as Invoice,
  ];

  beforeEach(() => {
    mockMarketplaceRepository = {
      findPublishedInvoices: jest.fn(),
    };

    marketplaceService = new MarketplaceService({
      marketplaceRepository: mockMarketplaceRepository,
    });
  });

  describe("getPublishedInvoices", () => {
    it("should return published invoices with default filters", async () => {
      mockMarketplaceRepository.findPublishedInvoices.mockResolvedValue({
        invoices: mockInvoices,
        total: 2,
      });

      const result = await marketplaceService.getPublishedInvoices();

      expect(result).toEqual({
        data: [
          {
            id: "invoice-1",
            invoiceId: "invoice-1",
            invoiceNumber: "INV-001",
            customerName: "Customer A",
            sellerName: "Customer A",
            amount: "1000.00",
            faceValue: "1000.00",
            fundingTarget: "950.00",
            amountRaised: "0",
            fundedAmount: "0",
            discountRate: "5.00",
            yieldBps: 500,
            fundingPercentage: 0,
            netAmount: "950.00",
            dueDate: new Date("2024-12-31"),
            fundingDeadline: new Date("2024-12-31"),
            status: InvoiceStatus.PUBLISHED,
            createdAt: new Date("2024-01-01"),
          },
          {
            id: "invoice-2",
            invoiceId: "invoice-2",
            invoiceNumber: "INV-002",
            customerName: "Customer B",
            sellerName: "Customer B",
            amount: "2000.00",
            faceValue: "2000.00",
            fundingTarget: "1940.00",
            amountRaised: "0",
            fundedAmount: "0",
            discountRate: "3.00",
            yieldBps: 300,
            fundingPercentage: 0,
            netAmount: "1940.00",
            dueDate: new Date("2024-11-30"),
            fundingDeadline: new Date("2024-11-30"),
            status: InvoiceStatus.PUBLISHED,
            createdAt: new Date("2024-01-02"),
          },
        ],
        meta: {
          total: 2,
          page: 1,
          limit: 20,
          totalPages: 1,
        },
      });

      expect(mockMarketplaceRepository.findPublishedInvoices).toHaveBeenCalledWith(
        {
          status: [InvoiceStatus.PUBLISHED],
          sort: "amount",
          sortOrder: "DESC",
        },
        { page: 1, limit: 20 }
      );
    });

    it("should apply custom filters and pagination", async () => {
      mockMarketplaceRepository.findPublishedInvoices.mockResolvedValue({
        invoices: [mockInvoices[0]],
        total: 1,
      });

      const filters = {
        status: [InvoiceStatus.PUBLISHED, InvoiceStatus.FUNDED],
        dueBefore: new Date("2024-12-01"),
        minAmount: 500,
        maxAmount: 1500,
        sort: "discount_rate" as const,
        sortOrder: "DESC" as const,
      };

      const pagination = { page: 2, limit: 10 };

      const result = await marketplaceService.getPublishedInvoices(filters, pagination);

      expect(result.meta).toEqual({
        total: 1,
        page: 2,
        limit: 10,
        totalPages: 1,
      });

      expect(mockMarketplaceRepository.findPublishedInvoices).toHaveBeenCalledWith(
        filters,
        pagination
      );
    });

    it("should normalize pagination limits", async () => {
      mockMarketplaceRepository.findPublishedInvoices.mockResolvedValue({
        invoices: [],
        total: 0,
      });

      // Test invalid pagination values
      await marketplaceService.getPublishedInvoices({}, { page: -1, limit: 200 });

      expect(mockMarketplaceRepository.findPublishedInvoices).toHaveBeenCalledWith(
        expect.any(Object),
        { page: 1, limit: 100 } // Normalized values
      );
    });

    it("should exclude private fields from public response", async () => {
      mockMarketplaceRepository.findPublishedInvoices.mockResolvedValue({
        invoices: [mockInvoices[0]],
        total: 1,
      });

      const result = await marketplaceService.getPublishedInvoices();

      const publicInvoice = result.data[0];

      // Should include public fields
      expect(publicInvoice).toHaveProperty("id");
      expect(publicInvoice).toHaveProperty("invoiceNumber");
      expect(publicInvoice).toHaveProperty("customerName");
      expect(publicInvoice).toHaveProperty("amount");
      expect(publicInvoice).toHaveProperty("discountRate");
      expect(publicInvoice).toHaveProperty("netAmount");
      expect(publicInvoice).toHaveProperty("dueDate");
      expect(publicInvoice).toHaveProperty("status");
      expect(publicInvoice).toHaveProperty("createdAt");

      // Should exclude private fields
      expect(publicInvoice).not.toHaveProperty("sellerId");
      expect(publicInvoice).not.toHaveProperty("ipfsHash");
      expect(publicInvoice).not.toHaveProperty("riskScore");
      expect(publicInvoice).not.toHaveProperty("smartContractId");
      expect(publicInvoice).not.toHaveProperty("updatedAt");
      expect(publicInvoice).not.toHaveProperty("deletedAt");
    });

    it("should calculate total pages correctly", async () => {
      mockMarketplaceRepository.findPublishedInvoices.mockResolvedValue({
        invoices: [],
        total: 25,
      });

      const result = await marketplaceService.getPublishedInvoices({}, { page: 1, limit: 10 });

      expect(result.meta.totalPages).toBe(3); // Math.ceil(25 / 10)
    });
  });
});
