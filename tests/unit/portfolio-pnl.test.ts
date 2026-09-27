import { PortfolioService } from "../../src/services/portfolio.service";
import { InvestmentStatus, InvoiceStatus } from "../../src/types/enums";

describe("PortfolioService P&L (issue #479)", () => {
  function makeService(investments: Array<Record<string, unknown>>) {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(investments),
    };
    const repo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      find: jest.fn().mockResolvedValue(investments),
    };
    const dataSource = { getRepository: jest.fn().mockReturnValue(repo) };
    return new PortfolioService(dataSource as never);
  }

  it("computes negative P&L for cancelled/rejected positions and positive for settled", async () => {
    const service = makeService([
      {
        id: "a",
        invoiceId: "inv-1",
        investorId: "u1",
        investmentAmount: "100.0000",
        expectedReturn: "110.0000",
        actualReturn: "110.0000",
        status: InvestmentStatus.SETTLED,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        invoice: { status: InvoiceStatus.SETTLED, fundingDeadline: null },
      },
      {
        id: "b",
        invoiceId: "inv-2",
        investorId: "u1",
        investmentAmount: "50.0000",
        expectedReturn: "55.0000",
        actualReturn: null,
        status: InvestmentStatus.CANCELLED,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        invoice: { status: InvoiceStatus.REJECTED, fundingDeadline: null },
      },
      {
        id: "c",
        invoiceId: "inv-3",
        investorId: "u1",
        investmentAmount: "25.0000",
        expectedReturn: "27.5000",
        actualReturn: null,
        status: InvestmentStatus.CONFIRMED,
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
        invoice: {
          status: InvoiceStatus.PUBLISHED,
          fundingDeadline: new Date("2026-06-01T00:00:00.000Z"),
        },
      },
    ]);

    const page = await service.getPortfolio("u1", { limit: 10 });
    expect(page.summary.totalInvested).toBe("175.0000");
    // Active current value = expected return of confirmed (27.5)
    expect(page.summary.currentPortfolioValue).toBe("27.5000");
    // Settled return 110; PnL = (110-100) + (0-50) = 10 - 50 = -40
    expect(page.summary.realisedReturns).toBe("110.0000");
    expect(page.summary.realisedPnl).toBe("-40.0000");

    const cancelled = page.positions.find((p) => p.investmentId === "b");
    expect(cancelled?.realisedPnl).toBe("-50.0000");
    expect(cancelled?.settlementAmount).toBe("0.0000");
  });
});
