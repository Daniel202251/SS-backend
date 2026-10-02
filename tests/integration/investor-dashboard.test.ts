import { DataSource, Repository } from "typeorm";
import { InvestmentService } from "../../src/services/investment.service";
import { Investment } from "../../src/models/Investment.model";
import { InvestmentStatus } from "../../src/types/enums";

describe("Investor dashboard aggregate", () => {
  let mockRepository: jest.Mocked<Repository<Investment>>;
  let mockDataSource: jest.Mocked<DataSource>;
  let investmentService: InvestmentService;

  const walletAId = "wallet-a";
  const walletBId = "wallet-b";

  function seedInvestment(overrides: Partial<Investment>): Investment {
    return {
      id: "investment-id",
      invoiceId: "invoice-id",
      investorId: walletAId,
      investmentAmount: "0.0000",
      expectedReturn: "0.0000",
      actualReturn: null,
      status: InvestmentStatus.PENDING,
      transactionHash: null,
      stellarOperationIndex: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      ...overrides,
    } as Investment;
  }

  beforeEach(() => {
    mockRepository = {
      find: jest.fn(),
    } as unknown as jest.Mocked<Repository<Investment>>;

    mockDataSource = {
      getRepository: jest.fn().mockReturnValue(mockRepository),
    } as unknown as jest.Mocked<DataSource>;

    investmentService = new InvestmentService(mockDataSource);
  });

  it("aggregates active, settled, and failed positions without leaking other investors", async () => {
    const investments = [
      seedInvestment({
        id: "inv-1",
        investorId: walletAId,
        investmentAmount: "3000.0000",
        status: InvestmentStatus.PENDING,
      }),
      seedInvestment({
        id: "inv-2",
        investorId: walletAId,
        investmentAmount: "2000.0000",
        status: InvestmentStatus.CONFIRMED,
      }),
      seedInvestment({
        id: "inv-3",
        investorId: walletAId,
        investmentAmount: "1500.0000",
        status: InvestmentStatus.SETTLED,
        actualReturn: "1650.0000",
      }),
      seedInvestment({
        id: "inv-4",
        investorId: walletAId,
        investmentAmount: "500.0000",
        status: InvestmentStatus.CANCELLED,
      }),
      seedInvestment({
        id: "inv-5",
        investorId: walletBId,
        investmentAmount: "9999.0000",
        status: InvestmentStatus.PENDING,
      }),
    ];

    mockRepository.find.mockImplementation(async (options) => {
      const investorId =
        options?.where && !Array.isArray(options.where)
          ? (options.where as { investorId?: string }).investorId
          : undefined;

      return investments.filter((investment) => investment.investorId === investorId);
    });

    const dashboard = await investmentService.getInvestorDashboard(walletAId);

    expect(mockDataSource.getRepository).toHaveBeenCalledWith(Investment);
    expect(mockRepository.find).toHaveBeenCalledWith({ where: { investorId: walletAId } });

    expect(dashboard).toMatchObject({
      totalInvested: "7000.0000",
      totalReturns: "1650.0000",
      activeInvestments: 2,
      activeCount: 2,
      activeTotal: "5000.0000",
      settledCount: 1,
      settledReturns: "1650.0000",
      failedCount: 1,
    });
  });

  it("does not count pending returns towards totalReturns", async () => {
    mockRepository.find.mockResolvedValue([
      seedInvestment({
        id: "inv-1",
        investmentAmount: "500.0000",
        status: InvestmentStatus.PENDING,
        expectedReturn: "550.0000",
      }),
    ]);

    const dashboard = await investmentService.getInvestorDashboard(walletAId);

    expect(dashboard.totalInvested).toBe("500.0000");
    expect(dashboard.totalReturns).toBe("0.0000");
    expect(dashboard.activeInvestments).toBe(1);
    expect(dashboard.activeCount).toBe(1);
    expect(dashboard.activeTotal).toBe("500.0000");
    expect(dashboard.settledCount).toBe(0);
    expect(dashboard.failedCount).toBe(0);
  });

  it("excludes cancelled investments from the active count", async () => {
    mockRepository.find.mockResolvedValue([
      seedInvestment({
        id: "inv-1",
        investmentAmount: "800.0000",
        status: InvestmentStatus.CANCELLED,
      }),
    ]);

    const dashboard = await investmentService.getInvestorDashboard(walletAId);

    expect(dashboard.totalInvested).toBe("800.0000");
    expect(dashboard.activeInvestments).toBe(0);
    expect(dashboard.activeCount).toBe(0);
    expect(dashboard.activeTotal).toBe("0.0000");
    expect(dashboard.settledCount).toBe(0);
    expect(dashboard.failedCount).toBe(1);
  });

  it("returns zero for all fields when the wallet has no investments", async () => {
    mockRepository.find.mockResolvedValue([]);

    const dashboard = await investmentService.getInvestorDashboard("wallet-with-nothing");

    expect(dashboard).toEqual({
      totalInvested: "0.0000",
      totalReturns: "0.0000",
      activeInvestments: 0,
      activeCount: 0,
      activeTotal: "0.0000",
      settledCount: 0,
      settledReturns: "0.0000",
      failedCount: 0,
    });
  });
});
