import { DataSource } from "typeorm";
import { Decimal } from "decimal.js";
import { Investment } from "../models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";

export interface PortfolioPosition {
  investmentId: string;
  invoiceId: string;
  invoiceStatus: InvoiceStatus | null;
  status: InvestmentStatus;
  amountInvested: string;
  expectedReturn: string;
  currentValue: string;
  settlementAmount: string | null;
  realisedPnl: string | null;
  fundingDeadline: string | null;
  createdAt: string;
}

export interface PortfolioSummary {
  totalInvested: string;
  currentPortfolioValue: string;
  realisedReturns: string;
  realisedPnl: string;
}

export interface PortfolioPage {
  summary: PortfolioSummary;
  positions: PortfolioPosition[];
  nextCursor: string | null;
  hasMore: boolean;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const raw = Buffer.from(cursor.trim(), "base64").toString("utf-8");
    const [iso, id] = raw.split("|");
    const createdAt = new Date(iso);
    if (!id || Number.isNaN(createdAt.getTime())) {
      throw new Error("bad cursor");
    }
    return { createdAt, id };
  } catch {
    throw new ServiceError("INVALID_CURSOR", "Invalid portfolio cursor", 400);
  }
}

/**
 * Investor portfolio with active + historical positions and realised P&L.
 * Issue #479 — P&L = settlement amount − principal; negative for rejected/cancelled.
 */
export class PortfolioService {
  constructor(private readonly dataSource: DataSource) {}

  async getPortfolio(
    investorId: string,
    options: { cursor?: string | null; limit?: number } = {}
  ): Promise<PortfolioPage> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const repo = this.dataSource.getRepository(Investment);

    const qb = repo
      .createQueryBuilder("investment")
      .leftJoinAndSelect("investment.invoice", "invoice")
      .where("investment.investorId = :investorId", { investorId })
      .orderBy("investment.createdAt", "DESC")
      .addOrderBy("investment.id", "DESC")
      .take(limit + 1);

    if (options.cursor) {
      const { createdAt, id } = decodeCursor(options.cursor);
      qb.andWhere(
        "(investment.createdAt < :createdAt OR (investment.createdAt = :createdAt AND investment.id < :id))",
        { createdAt, id }
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    // Summary aggregates across the full portfolio (not just the page).
    const all = await repo.find({
      where: { investorId },
      relations: ["invoice"],
    });

    let totalInvested = new Decimal(0);
    let currentPortfolioValue = new Decimal(0);
    let realisedReturns = new Decimal(0);
    let realisedPnl = new Decimal(0);

    for (const inv of all) {
      const principal = new Decimal(inv.investmentAmount);
      totalInvested = totalInvested.plus(principal);

      if (
        inv.status === InvestmentStatus.PENDING ||
        inv.status === InvestmentStatus.CONFIRMED
      ) {
        // Active: mark-to-model as expected return (invoice funding state).
        currentPortfolioValue = currentPortfolioValue.plus(new Decimal(inv.expectedReturn));
      } else if (inv.status === InvestmentStatus.SETTLED) {
        const settlement = new Decimal(inv.actualReturn ?? inv.expectedReturn);
        realisedReturns = realisedReturns.plus(settlement);
        realisedPnl = realisedPnl.plus(settlement.minus(principal));
      } else if (inv.status === InvestmentStatus.CANCELLED) {
        // Rejected / cancelled: settlement is zero → negative P&L of principal.
        realisedPnl = realisedPnl.plus(new Decimal(0).minus(principal));
      }
    }

    const positions: PortfolioPosition[] = pageRows.map((inv) => {
      const principal = new Decimal(inv.investmentAmount);
      const invoiceStatus = inv.invoice?.status ?? null;
      const isActive =
        inv.status === InvestmentStatus.PENDING || inv.status === InvestmentStatus.CONFIRMED;
      const isSettled = inv.status === InvestmentStatus.SETTLED;
      const isCancelled = inv.status === InvestmentStatus.CANCELLED;

      let settlementAmount: string | null = null;
      let realised: string | null = null;
      let currentValue: string;

      if (isActive) {
        currentValue = new Decimal(inv.expectedReturn).toFixed(4);
      } else if (isSettled) {
        settlementAmount = new Decimal(inv.actualReturn ?? inv.expectedReturn).toFixed(4);
        realised = new Decimal(settlementAmount).minus(principal).toFixed(4);
        currentValue = "0.0000";
      } else if (isCancelled) {
        settlementAmount = "0.0000";
        realised = new Decimal(0).minus(principal).toFixed(4);
        currentValue = "0.0000";
      } else {
        currentValue = "0.0000";
      }

      return {
        investmentId: inv.id,
        invoiceId: inv.invoiceId,
        invoiceStatus,
        status: inv.status,
        amountInvested: principal.toFixed(4),
        expectedReturn: new Decimal(inv.expectedReturn).toFixed(4),
        currentValue,
        settlementAmount,
        realisedPnl: realised,
        fundingDeadline: inv.invoice?.fundingDeadline
          ? inv.invoice.fundingDeadline.toISOString()
          : null,
        createdAt: inv.createdAt.toISOString(),
      };
    });

    const last = pageRows[pageRows.length - 1];
    return {
      summary: {
        totalInvested: totalInvested.toFixed(4),
        currentPortfolioValue: currentPortfolioValue.toFixed(4),
        realisedReturns: realisedReturns.toFixed(4),
        realisedPnl: realisedPnl.toFixed(4),
      },
      positions,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      hasMore,
    };
  }
}

export function createPortfolioService(dataSource: DataSource): PortfolioService {
  return new PortfolioService(dataSource);
}
