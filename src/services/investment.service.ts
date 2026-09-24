import { DataSource, EntityManager, OptimisticLockVersionMismatchError } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { Decimal } from "decimal.js";
import {
  createInvoiceStateMachine,
  entityManagerTransitionStore,
  type InvoiceStateMachine,
  type InvoiceTransition,
} from "../lib/invoice-state-machine";
import { logger } from "../observability/logger";
import { stroopsToXlm } from "../lib/stellar-format";

// Formula for expected return:
// Investor's share of the invoice face value (amount) proportional to their contribution to the fundable amount (netAmount).
// expectedReturn = investmentAmount * (invoice.amount / invoice.netAmount)
// This ensures the investor captures the discount.

export interface CreateInvestmentInput {
  invoiceId: string;
  investorId: string;
  investmentAmount: string;
  investorWallet: string;
}

export interface InvestorDashboard {
  totalInvested: string;
  totalReturns: string;
  activeInvestments: number;
  activeCount: number;
  activeTotal: string;
  settledCount: number;
  settledReturns: string;
  failedCount: number;
}

export interface MonthlyYieldMetric {
  month: string;
  investedAmount: string;
  returnedAmount: string;
  profit: string;
  averageYieldPercent: string;
}

export interface InvestorAnalytics {
  totalDeployedCapital: string;
  totalProfitEarned: string;
  pendingPayouts: string;
  projectedTotalReturn: string;
  weightedAverageApy: string;
  statusDistribution: {
    pending: number;
    confirmed: number;
    settled: number;
    cancelled: number;
    overdue: number;
  };
  monthlyPerformance: MonthlyYieldMetric[];
}

const ACTIVE_INVESTMENT_STATUSES = [InvestmentStatus.PENDING, InvestmentStatus.CONFIRMED];
const SETTLED_INVESTMENT_STATUSES = [InvestmentStatus.SETTLED];
const FAILED_INVESTMENT_STATUSES = [InvestmentStatus.CANCELLED];

export class InvestmentService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly stateMachine: InvoiceStateMachine = createInvoiceStateMachine()
  ) {}

  /**
   * Aggregates an investor's portfolio across all their investments.
   *
   * - totalInvested sums investmentAmount across every status (a commitment
   *   counts once made, regardless of how it later resolves).
   * - totalReturns sums actualReturn for SETTLED investments only — pending
   *   or confirmed investments have no realised return yet.
   * - activeInvestments counts investments still in flight (PENDING/CONFIRMED).
   */
  async getInvestorDashboard(investorId: string): Promise<InvestorDashboard> {
    const investments = await this.dataSource.getRepository(Investment).find({
      where: { investorId },
    });

    let totalInvested = new Decimal(0);
    let totalReturns = new Decimal(0);
    let activeCount = 0;
    let activeTotal = new Decimal(0);
    let settledCount = 0;
    let failedCount = 0;

    for (const investment of investments) {
      const amount = new Decimal(investment.investmentAmount);
      totalInvested = totalInvested.plus(amount);

      if (ACTIVE_INVESTMENT_STATUSES.includes(investment.status)) {
        activeCount += 1;
        activeTotal = activeTotal.plus(amount);
      }

      if (SETTLED_INVESTMENT_STATUSES.includes(investment.status)) {
        settledCount += 1;
        if (investment.actualReturn !== null) {
          totalReturns = totalReturns.plus(new Decimal(investment.actualReturn));
        }
      }

      if (FAILED_INVESTMENT_STATUSES.includes(investment.status)) {
        failedCount += 1;
      }
    }

    return {
      totalInvested: totalInvested.toFixed(4),
      totalReturns: totalReturns.toFixed(4),
      activeInvestments: activeCount,
      activeCount,
      activeTotal: activeTotal.toFixed(4),
      settledCount,
      settledReturns: totalReturns.toFixed(4),
      failedCount,
    };
  }

  /**
   * Calculates comprehensive investor portfolio performance analytics including:
   * - Weighted average APY across all active investments
   * - Deployed capital, total profit earned, pending payouts, projected return
   * - Status distribution breakdown (including overdue detection)
   * - Monthly historical yield & return metrics
   */
  async calculateInvestorAnalytics(investorId: string): Promise<InvestorAnalytics> {
    const investments = await this.dataSource.getRepository(Investment).find({
      where: { investorId },
      relations: ["invoice"],
      order: { createdAt: "ASC" },
    });

    let totalDeployedCapital = new Decimal(0);
    let totalProfitEarned = new Decimal(0);
    let pendingPayouts = new Decimal(0);
    let weightedYieldSum = new Decimal(0);

    const statusDistribution = {
      pending: 0,
      confirmed: 0,
      settled: 0,
      cancelled: 0,
      overdue: 0,
    };

    const monthlyMap = new Map<
      string,
      { invested: Decimal; returned: Decimal; profit: Decimal; yieldSum: Decimal; count: number }
    >();

    const now = new Date();

    for (const investment of investments) {
      const amount = new Decimal(investment.investmentAmount || 0);
      const expectedReturn = new Decimal(investment.expectedReturn || 0);
      const invoice = investment.invoice;

      // Status distribution
      if (investment.status === InvestmentStatus.PENDING) {
        statusDistribution.pending += 1;
      } else if (investment.status === InvestmentStatus.CONFIRMED) {
        statusDistribution.confirmed += 1;
      } else if (investment.status === InvestmentStatus.SETTLED) {
        statusDistribution.settled += 1;
      } else if (investment.status === InvestmentStatus.CANCELLED) {
        statusDistribution.cancelled += 1;
      }

      // Check if overdue
      if (
        (investment.status === InvestmentStatus.PENDING ||
          investment.status === InvestmentStatus.CONFIRMED) &&
        invoice?.dueDate &&
        new Date(invoice.dueDate) < now
      ) {
        statusDistribution.overdue += 1;
      }

      // Active investments analytics
      if (ACTIVE_INVESTMENT_STATUSES.includes(investment.status)) {
        totalDeployedCapital = totalDeployedCapital.plus(amount);
        pendingPayouts = pendingPayouts.plus(expectedReturn);

        // APY / Yield rate calculation
        let yieldRate = new Decimal(0);
        if (invoice?.discountRate) {
          yieldRate = new Decimal(invoice.discountRate);
        } else if (amount.gt(0) && expectedReturn.gte(amount)) {
          yieldRate = expectedReturn.minus(amount).dividedBy(amount).times(100);
        }
        weightedYieldSum = weightedYieldSum.plus(amount.times(yieldRate));
      }

      // Settled returns
      if (SETTLED_INVESTMENT_STATUSES.includes(investment.status)) {
        const actualReturn =
          investment.actualReturn !== null && investment.actualReturn !== undefined
            ? new Decimal(investment.actualReturn)
            : expectedReturn;
        const profit = actualReturn.minus(amount);
        if (profit.gt(0)) {
          totalProfitEarned = totalProfitEarned.plus(profit);
        }
      }

      // Monthly aggregation
      const createdDate = investment.createdAt ? new Date(investment.createdAt) : new Date();
      const year = createdDate.getUTCFullYear();
      const month = String(createdDate.getUTCMonth() + 1).padStart(2, "0");
      const monthKey = `${year}-${month}`;

      let monthEntry = monthlyMap.get(monthKey);
      if (!monthEntry) {
        monthEntry = {
          invested: new Decimal(0),
          returned: new Decimal(0),
          profit: new Decimal(0),
          yieldSum: new Decimal(0),
          count: 0,
        };
        monthlyMap.set(monthKey, monthEntry);
      }

      monthEntry.invested = monthEntry.invested.plus(amount);
      if (investment.status === InvestmentStatus.SETTLED) {
        const actualReturn =
          investment.actualReturn !== null && investment.actualReturn !== undefined
            ? new Decimal(investment.actualReturn)
            : expectedReturn;
        monthEntry.returned = monthEntry.returned.plus(actualReturn);
        const profit = actualReturn.minus(amount);
        if (profit.gt(0)) {
          monthEntry.profit = monthEntry.profit.plus(profit);
        }
      }

      let invYield = new Decimal(0);
      if (invoice?.discountRate) {
        invYield = new Decimal(invoice.discountRate);
      } else if (amount.gt(0) && expectedReturn.gte(amount)) {
        invYield = expectedReturn.minus(amount).dividedBy(amount).times(100);
      }
      monthEntry.yieldSum = monthEntry.yieldSum.plus(invYield);
      monthEntry.count += 1;
    }

    const weightedAverageApy = totalDeployedCapital.gt(0)
      ? weightedYieldSum.dividedBy(totalDeployedCapital).toFixed(2)
      : "0.00";

    const projectedTotalReturn = pendingPayouts.gt(0) ? pendingPayouts : totalDeployedCapital;

    const monthlyPerformance: MonthlyYieldMetric[] = Array.from(monthlyMap.entries()).map(
      ([month, data]) => ({
        month,
        investedAmount: data.invested.toFixed(4),
        returnedAmount: data.returned.toFixed(4),
        profit: data.profit.toFixed(4),
        averageYieldPercent:
          data.count > 0 ? data.yieldSum.dividedBy(data.count).toFixed(2) : "0.00",
      })
    );

    return {
      totalDeployedCapital: totalDeployedCapital.toFixed(4),
      totalProfitEarned: totalProfitEarned.toFixed(4),
      pendingPayouts: pendingPayouts.toFixed(4),
      projectedTotalReturn: projectedTotalReturn.toFixed(4),
      weightedAverageApy,
      statusDistribution,
      monthlyPerformance,
    };
  }

  /**
   * Creates a new investment commitment for an invoice.
   * Uses a database transaction with a row-level lock on the invoice to prevent over-subscription.
   * Implements optimistic locking retry logic to handle concurrent investment attempts.
   */
  async createInvestment(input: CreateInvestmentInput): Promise<Investment> {
    const { invoiceId, investorId, investmentAmount, investorWallet } = input;

    // Validate investment amount
    const amount = new Decimal(investmentAmount);
    if (amount.isNegative() || amount.isZero()) {
      throw new ServiceError("INVALID_AMOUNT", "Investment amount must be greater than zero");
    }

    const MAX_RETRIES = 3;
    let attempt = 0;

    while (true) {
      try {
        // Side effects are collected from the transaction's return value, so
        // a rolled-back or retried attempt never has any to run.
        const { savedInvestment, fundedTransition } = await this.dataSource.transaction(async (transactionalEntityManager: EntityManager) => {
          // 1. Lock the invoice row for update (if supported by the driver).
          //    SQLite does not support row-level locking, so we fall back to a plain read.
          let invoice: Invoice | null;
          try {
            invoice = await transactionalEntityManager
              .createQueryBuilder(Invoice, "invoice")
              .setLock("pessimistic_write")
              .where("invoice.id = :id", { id: invoiceId })
              .getOne();
          } catch {
            invoice = await transactionalEntityManager
              .createQueryBuilder(Invoice, "invoice")
              .where("invoice.id = :id", { id: invoiceId })
              .getOne();
          }

          if (!invoice) {
            throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
          }

          // 2. Validate invoice status
          if (invoice.status !== InvoiceStatus.PUBLISHED) {
            throw new ServiceError(
              "INVALID_INVOICE_STATUS",
              `Cannot invest in an invoice with status ${invoice.status}`
            );
          }

          // 3. Reject if the invoice has passed its due date
          if (invoice.dueDate && new Date(invoice.dueDate) < new Date()) {
            throw new ServiceError(
              "invoice_expired",
              "Invoice has passed its due date and is no longer accepting investments",
              422
            );
          }

          // 4. Prevent self-dealing
          if (invoice.sellerId === investorId) {
            throw new ServiceError("SELF_DEALING", "Investors cannot invest in their own invoices");
          }

          // 5. Check remaining capacity
          // We count both PENDING and CONFIRMED investments towards the cap to prevent over-subscription
          const activeInvestments = await transactionalEntityManager.find(Investment, {
            where: [
              { invoiceId, status: InvestmentStatus.PENDING },
              { invoiceId, status: InvestmentStatus.CONFIRMED },
            ],
          });

          const totalInvested = activeInvestments.reduce(
            (sum, inv) => sum.plus(new Decimal(inv.investmentAmount)),
            new Decimal(0)
          );

          const netAmount = new Decimal(invoice.netAmount);
          const remainingCapacity = netAmount.minus(totalInvested);

          if (amount.gt(remainingCapacity)) {
            throw new ServiceError(
              "INSUFFICIENT_CAPACITY",
              `Investment amount ${amount.toString()} exceeds remaining capacity ${remainingCapacity.toString()}`
            );
          }

          // 6. Calculate expected return
          // expectedReturn = investmentAmount * (invoice.amount / invoice.netAmount)
          const faceAmount = new Decimal(invoice.amount);
          const expectedReturn = amount.times(faceAmount.dividedBy(netAmount)).toDecimalPlaces(4);

          // 7. Create investment
          const investment = transactionalEntityManager.create(Investment, {
            invoiceId,
            investorId,
            investmentAmount: amount.toFixed(4),
            expectedReturn: expectedReturn.toFixed(4),
            status: InvestmentStatus.PENDING,
          });

          const savedInvestment = await transactionalEntityManager.save(Investment, investment);

          // 8. Emit structured log for the investment commitment
          const truncatedWallet =
            investorWallet.length >= 8
              ? `${investorWallet.slice(0, 4)}…${investorWallet.slice(-4)}`
              : investorWallet;
          const sharePercent = amount.dividedBy(netAmount).times(100).toFixed(2);

          logger.info("investment.committed", {
            investment_id: savedInvestment.id,
            invoice_id: invoiceId,
            investor_wallet: truncatedWallet,
            amount_xlm: stroopsToXlm(BigInt(amount.times(10_000_000).toFixed(0))),
            share_percent: sharePercent,
            committed_at: savedInvestment.createdAt?.toISOString() ?? new Date().toISOString(),
          });

          // 9. Transition invoice to FUNDED if fully subscribed
          const newTotalInvested = totalInvested.plus(amount);
          let fundedTransition: InvoiceTransition | null = null;
          if (newTotalInvested.gte(netAmount)) {
            fundedTransition = await this.stateMachine.transition(
              entityManagerTransitionStore(transactionalEntityManager),
              invoice,
              InvoiceStatus.FUNDED,
              {
                actor: { role: "system", wallet: investorWallet },
                trigger: "fully_funded",
                context: { fundedAmount: newTotalInvested.toFixed(4) },
              }
            );
          }

          return { savedInvestment, fundedTransition };
        });

        if (fundedTransition) {
          await this.stateMachine.dispatch(fundedTransition);
        }
        return savedInvestment;
      } catch (error) {
        if (error instanceof OptimisticLockVersionMismatchError) {
          attempt++;
          if (attempt >= MAX_RETRIES) {
            logger.warn("Optimistic lock retry exhausted for investment", {
              invoiceId,
              investorId,
              attempt,
              maxRetries: MAX_RETRIES,
            });
            throw new ServiceError(
              "CONCURRENT_INVESTMENT_CONFLICT",
              "Unable to process investment due to concurrent modifications. Please retry.",
              409
            );
          }
          // Brief exponential backoff before retry
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
          continue;
        }
        throw error;
      }
    }
  }
}

export function createInvestmentService(
  dataSource: DataSource,
  stateMachine?: InvoiceStateMachine
): InvestmentService {
  return new InvestmentService(dataSource, stateMachine);
}
