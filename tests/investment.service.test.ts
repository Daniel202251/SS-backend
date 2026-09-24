import { DataSource, EntityManager, SelectQueryBuilder } from "typeorm";
import { InvestmentService } from "../src/services/investment.service";
import { Invoice } from "../src/models/Invoice.model";
import { Investment } from "../src/models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../src/types/enums";
import { ServiceError } from "../src/utils/service-error";
import { InvoiceStatusHistory } from "../src/models/InvoiceStatusHistory.model";

const INVESTOR_WALLET = "GINVESTORWALLET1234567890ABCDEFGHIJKLMNOPQRSTUV";

describe("InvestmentService", () => {
  let mockDataSource: jest.Mocked<DataSource>;
  let mockEntityManager: jest.Mocked<EntityManager>;
  let mockQueryBuilder: jest.Mocked<SelectQueryBuilder<Invoice>>;
  let investmentService: InvestmentService;

  beforeEach(() => {
    mockQueryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    } as any;

    mockEntityManager = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    } as any;

    mockDataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(mockEntityManager)),
    } as any;

    investmentService = new InvestmentService(mockDataSource);
  });

  const getMockInvoice = () =>
    ({
      id: "invoice-1",
      sellerId: "seller-1",
      amount: "1000.0000",
      netAmount: "950.0000",
      status: InvoiceStatus.PUBLISHED,
    }) as Invoice;

  it("should create a PENDING investment when within capacity", async () => {
    const mockInvoice = getMockInvoice();
    mockQueryBuilder.getOne.mockResolvedValue(mockInvoice);
    mockEntityManager.find.mockResolvedValue([]); // No existing investments
    mockEntityManager.create.mockImplementation((entity: any, data: any) => data);
    mockEntityManager.save.mockImplementation((entity: any, data: any) => Promise.resolve(data));

    const input = {
      invoiceId: "invoice-1",
      investorId: "investor-1",
      investmentAmount: "475.0000",
      investorWallet: INVESTOR_WALLET,
    };

    const result = await investmentService.createInvestment(input);

    expect(mockQueryBuilder.setLock).toHaveBeenCalledWith("pessimistic_write");
    expect(result.status).toBe(InvestmentStatus.PENDING);
    expect(result.investmentAmount).toBe("475.0000");
    // expectedReturn = 475 * (1000 / 950) = 475 * 1.0526315789 = 500
    expect(result.expectedReturn).toBe("500.0000");
    expect(mockEntityManager.save).toHaveBeenCalledTimes(1); // Only save investment
  });

  it("should transition invoice to FUNDED when fully subscribed", async () => {
    const mockInvoice = getMockInvoice();
    mockQueryBuilder.getOne.mockResolvedValue(mockInvoice);
    mockEntityManager.find.mockResolvedValue([]);
    mockEntityManager.create.mockImplementation((entity: any, data: any) => data);
    mockEntityManager.save.mockImplementation((entity: any, data: any) => Promise.resolve(data));

    const input = {
      invoiceId: "invoice-1",
      investorId: "investor-1",
      investmentAmount: "950.0000",
      investorWallet: INVESTOR_WALLET,
    };

    await investmentService.createInvestment(input);

    expect(mockInvoice.status).toBe(InvoiceStatus.FUNDED);
    expect(mockEntityManager.save).toHaveBeenCalledTimes(3); // Investment, Invoice and status history
    expect(mockEntityManager.save).toHaveBeenCalledWith(
      InvoiceStatusHistory,
      expect.objectContaining({
        invoiceId: "invoice-1",
        fromStatus: InvoiceStatus.PUBLISHED,
        toStatus: InvoiceStatus.FUNDED,
        actorRole: "system",
        trigger: "fully_funded",
      })
    );
  });

  it("should reject investment if it exceeds capacity", async () => {
    const mockInvoice = getMockInvoice();
    mockQueryBuilder.getOne.mockResolvedValue(mockInvoice);
    mockEntityManager.find.mockResolvedValue([{ investmentAmount: "500.0000" } as Investment]);

    const input = {
      invoiceId: "invoice-1",
      investorId: "investor-1",
      investmentAmount: "500.0000", // 500 + 500 > 950
      investorWallet: INVESTOR_WALLET,
    };

    await expect(investmentService.createInvestment(input)).rejects.toThrow(
      new ServiceError(
        "INSUFFICIENT_CAPACITY",
        "Investment amount 500 exceeds remaining capacity 450"
      )
    );
  });

  it("should prevent self-dealing", async () => {
    const mockInvoice = getMockInvoice();
    mockQueryBuilder.getOne.mockResolvedValue(mockInvoice);

    const input = {
      invoiceId: "invoice-1",
      investorId: "seller-1", // Same as invoice seller
      investmentAmount: "100.0000",
      investorWallet: INVESTOR_WALLET,
    };

    await expect(investmentService.createInvestment(input)).rejects.toThrow(
      new ServiceError("SELF_DEALING", "Investors cannot invest in their own invoices")
    );
  });

  it("should reject invalid amounts", async () => {
    const input = {
      invoiceId: "invoice-1",
      investorId: "investor-1",
      investmentAmount: "-100.0000",
      investorWallet: INVESTOR_WALLET,
    };

    await expect(investmentService.createInvestment(input)).rejects.toThrow(
      new ServiceError("INVALID_AMOUNT", "Investment amount must be greater than zero")
    );
  });
});
