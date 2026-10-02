import {
  DataSource,
  EntityManager,
  OptimisticLockVersionMismatchError,
  QueryFailedError,
} from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvestorAcknowledgement } from "../models/InvestorAcknowledgement.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { Decimal } from "decimal.js";
import { getCurrentTermsVersion } from "./investor-acknowledgement.service";
import {
  createInvoiceStateMachine,
  entityManagerTransitionStore,
  type InvoiceStateMachine,
  type InvoiceTransition,
} from "../lib/invoice-state-machine";
import type { InvestmentNotifier } from "../lib/invoice-notifications";
import { logger } from "../observability/logger";
import { stroopsToXlm } from "../lib/stellar-format";
import { truncateWalletAddress } from "../lib/kyc";

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

export interface InvestInInvoiceInput {
  invoiceId: string;
  investorId: string;
  /** Stellar address the investment is made from; must be the investor's own. */
  walletAddress: string;
  amount: string;
  /**
   * Ledger the investment's payment targets. Defaults to the current
   * server-side funding window (one Stellar ledger close interval).
   */
  ledgerSequence?: number;
}

export interface InvoiceFundingState {
  invoiceId: string;
  status: InvoiceStatus;
  targetAmount: string;
  fundedAmount: string;
  remainingCapacity: string;
  fundedPercent: string;
  version: number;
}

export interface InvestInInvoiceResult {
  investment: Investment;
  funding: InvoiceFundingState;
}

/** Approximate Stellar ledger close time, used to bucket requests without a ledger. */
export const FUNDING_WINDOW_MS = 5_000;

function currentFundingWindow(now = Date.now()): number {
  return Math.floor(now / FUNDING_WINDOW_MS);
}

/** Raised when the conditional funded_amount update loses a race; retried. */
class FundingConflictError extends Error {
  constructor() {
    super("Invoice was modified concurrently");
    this.name = "FundingConflictError";
  }
}

function duplicateInvestmentError(fundingBlock: string): ServiceError {
  return new ServiceError(
    "DUPLICATE_INVESTMENT",
    "This wallet has already invested in this invoice within the same block",
    409,
    { fundingBlock }
  );
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const code = (error.driverError as { code?: string } | undefined)?.code;
  // 23505: Postgres unique_violation; SQLITE_CONSTRAINT for local sqlite runs.
  return code === "23505" || code === "SQLITE_CONSTRAINT";
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
    private readonly stateMachine: InvoiceStateMachine = createInvoiceStateMachine(),
    private readonly investmentNotifier?: InvestmentNotifier
  ) {}

  /**
   * Issue #473 — block investment until the wallet has acknowledged the
   * current TERMS_VERSION. Prior acknowledgements for older versions do not
   * satisfy this check (re-ack required on bump).
   */
  private async assertAccreditationAcknowledged(walletAddress: string | null | undefined): Promise<void> {
    const wallet = walletAddress?.trim();
    if (!wallet) {
      throw new ServiceError(
        "ACKNOWLEDGEMENT_REQUIRED",
        "Investor accreditation acknowledgement is required before investing",
        403
      );
    }
    const currentVersion = getCurrentTermsVersion();
    const ack = await this.dataSource.getRepository(InvestorAcknowledgement).findOne({
      where: { walletAddress: wallet, termsVersion: currentVersion },
      order: { acknowledgedAt: "DESC" },
    });
    if (!ack) {
      throw new ServiceError(
        "ACKNOWLEDGEMENT_REQUIRED",
        `Investor must acknowledge terms version ${currentVersion} before investing`,
        403
      );
    }
  }

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
   * Buys a fractional share of a published invoice (POST /invoices/:id/invest).
   *
   * Over-funding is prevented at three levels:
   *  1. the remaining capacity is checked against the invoice as read;
   *  2. funded_amount is advanced with a single conditional UPDATE that only
   *     matches if the invoice's version is unchanged since that read
   *     (optimistic lock) and the new total still fits within net_amount;
   *  3. a CHECK constraint on invoices rejects funded_amount > net_amount.
   * A concurrent writer makes the UPDATE match no rows; the attempt is then
   * retried from a fresh read, where it either fits or is rejected for
   * insufficient capacity.
   *
   * The funded_amount update, the investment row and (when the invoice
   * fills up) the transition to FUNDED share one transaction.
   */
  async investInInvoice(input: InvestInInvoiceInput): Promise<InvestInInvoiceResult> {
    const { invoiceId, investorId, walletAddress } = input;

    await this.assertAccreditationAcknowledged(walletAddress);

    let amount: Decimal;
    try {
      amount = new Decimal(input.amount);
    } catch {
      throw new ServiceError("INVALID_AMOUNT", "Investment amount must be a number", 400);
    }
    if (!amount.isFinite() || amount.lte(0)) {
      throw new ServiceError("INVALID_AMOUNT", "Investment amount must be greater than zero", 400);
    }
    if (amount.decimalPlaces() > 4) {
      throw new ServiceError(
        "INVALID_AMOUNT",
        "Investment amount supports at most 4 decimal places",
        400
      );
    }

    const fundingBlock = String(input.ledgerSequence ?? currentFundingWindow());
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; ; attempt++) {
      try {
        const { investment, invoice, fundedAmount, fundedTransition } =
          await this.dataSource.transaction(async (manager: EntityManager) => {
            const invoice = await manager.findOne(Invoice, { where: { id: invoiceId } });
            if (!invoice) {
              throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
            }

            if (invoice.status !== InvoiceStatus.PUBLISHED) {
              throw new ServiceError(
                "INVOICE_NOT_OPEN_FOR_INVESTMENT",
                `Cannot invest in an invoice with status ${invoice.status}`,
                422
              );
            }
            if (invoice.dueDate && new Date(invoice.dueDate) < new Date()) {
              throw new ServiceError(
                "invoice_expired",
                "Invoice has passed its due date and is no longer accepting investments",
                422
              );
            }
            if (invoice.sellerId === investorId) {
              throw new ServiceError(
                "SELF_DEALING",
                "Investors cannot invest in their own invoices",
                403
              );
            }

            const netAmount = new Decimal(invoice.netAmount);
            const funded = new Decimal(invoice.fundedAmount ?? 0);
            const remaining = Decimal.max(netAmount.minus(funded), 0);
            if (amount.gt(remaining)) {
              throw new ServiceError(
                "INSUFFICIENT_CAPACITY",
                `Investment amount ${amount.toFixed(4)} exceeds remaining capacity ${remaining.toFixed(4)}`,
                422,
                { remainingCapacity: remaining.toFixed(4) }
              );
            }

            const duplicate = await manager.findOne(Investment, {
              where: { invoiceId, investorWallet: walletAddress, fundingBlock },
            });
            if (duplicate) {
              throw duplicateInvestmentError(fundingBlock);
            }

            const update = await manager
              .createQueryBuilder()
              .update(Invoice)
              .set({
                fundedAmount: () => "funded_amount + :amount",
                version: () => "version + 1",
              })
              .where("id = :id", { id: invoiceId })
              .andWhere("version = :version", { version: invoice.version })
              .andWhere("status = :status", { status: InvoiceStatus.PUBLISHED })
              .andWhere("funded_amount + :amount <= net_amount")
              .setParameter("amount", amount.toFixed(4))
              .execute();

            if (update.affected !== 1) {
              throw new FundingConflictError();
            }

            const newFunded = funded.plus(amount);
            // Keep the in-memory entity in step with the row just written, so
            // the FUNDED save below neither reverts funded_amount nor trips
            // the version check.
            invoice.fundedAmount = newFunded.toFixed(4);
            invoice.version += 1;

            const expectedReturn = amount
              .times(new Decimal(invoice.amount).dividedBy(netAmount))
              .toDecimalPlaces(4);

            let investment: Investment;
            try {
              investment = await manager.save(
                Investment,
                manager.create(Investment, {
                  invoiceId,
                  investorId,
                  investorWallet: walletAddress,
                  fundingBlock,
                  investmentAmount: amount.toFixed(4),
                  expectedReturn: expectedReturn.toFixed(4),
                  status: InvestmentStatus.PENDING,
                })
              );
            } catch (error) {
              // Two identical requests can both pass the duplicate check
              // above; the unique index decides which one wins.
              if (isUniqueViolation(error)) {
                throw duplicateInvestmentError(fundingBlock);
              }
              throw error;
            }

            let fundedTransition: InvoiceTransition | null = null;
            if (newFunded.gte(netAmount)) {
              fundedTransition = await this.stateMachine.transition(
                entityManagerTransitionStore(manager),
                invoice,
                InvoiceStatus.FUNDED,
                {
                  actor: { role: "system", wallet: walletAddress },
                  trigger: "fully_funded",
                  context: { fundedAmount: newFunded.toFixed(4) },
                }
              );
            }

            return { investment, invoice, fundedAmount: newFunded, fundedTransition };
          });

        logger.info("investment.committed", {
          investment_id: investment.id,
          invoice_id: invoiceId,
          investor_wallet: truncateWalletAddress(walletAddress),
          amount_xlm: stroopsToXlm(BigInt(amount.times(10_000_000).toFixed(0))),
          funding_block: fundingBlock,
          attempt,
        });

        await this.investmentNotifier?.investmentCreated({ invoice, investment });
        if (fundedTransition) {
          await this.stateMachine.dispatch(fundedTransition);
        }

        const netAmount = new Decimal(invoice.netAmount);
        return {
          investment,
          funding: {
            invoiceId,
            status: invoice.status,
            targetAmount: netAmount.toFixed(4),
            fundedAmount: fundedAmount.toFixed(4),
            remainingCapacity: Decimal.max(netAmount.minus(fundedAmount), 0).toFixed(4),
            fundedPercent: fundedAmount.dividedBy(netAmount).times(100).toFixed(2),
            version: invoice.version,
          },
        };
      } catch (error) {
        const conflict =
          error instanceof FundingConflictError ||
          error instanceof OptimisticLockVersionMismatchError;
        if (!conflict) throw error;

        if (attempt >= MAX_ATTEMPTS) {
          logger.warn("Optimistic lock retry exhausted for invoice investment", {
            invoiceId,
            investorId,
            attempt,
          });
          throw new ServiceError(
            "CONCURRENT_INVESTMENT_CONFLICT",
            "Unable to process investment due to concurrent modifications. Please retry.",
            409
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  }

  /**
   * Creates a new investment commitment for an invoice.
   * Uses a database transaction with a row-level lock on the invoice to prevent over-subscription.
   * Implements optimistic locking retry logic to handle concurrent investment attempts.
   */
  async createInvestment(input: CreateInvestmentInput): Promise<Investment> {
    const { invoiceId, investorId, investmentAmount, investorWallet } = input;

    await this.assertAccreditationAcknowledged(investorWallet);

    // Validate investment amount
    const amount = new Decimal(investmentAmount);
    if (amount.isNegative() || amount.isZero()) {
      throw new ServiceError("INVALID_AMOUNT", "Investment amount must be greater than zero");
    }

    const MAX_RETRIES = 3;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      try {
        // Side effects are collected from the transaction's return value, so
        // a rolled-back or retried attempt never has any to run.
        const { savedInvestment, invoice, fundedTransition } = await this.dataSource.transaction(async (transactionalEntityManager: EntityManager) => {
          // 1. Lock the invoice row for update (if supported by the driver).
          //    SQLite does not support row-level locking, so we fall back to a plain read.
          let invoice: Invoice | null;
          const invoiceRepo = typeof transactionalEntityManager.getRepository === "function"
            ? transactionalEntityManager.getRepository(Invoice)
            : null;
          const getInvoiceQb = (lock: boolean) => {
            const qb = typeof transactionalEntityManager.createQueryBuilder === "function"
              ? transactionalEntityManager.createQueryBuilder(Invoice, "invoice")
              : invoiceRepo && typeof invoiceRepo.createQueryBuilder === "function"
              ? invoiceRepo.createQueryBuilder("invoice")
              : null;
            if (qb && lock && typeof qb.setLock === "function") {
              return qb.setLock("pessimistic_write");
            }
            return qb;
          };

          try {
            const qb = getInvoiceQb(true);
            if (qb) {
              invoice = await qb.where("invoice.id = :id", { id: invoiceId }).getOne();
            } else if (typeof transactionalEntityManager.findOne === "function") {
              invoice = await transactionalEntityManager.findOne(Invoice, { where: { id: invoiceId } });
            } else if (invoiceRepo) {
              invoice = await invoiceRepo.findOne({ where: { id: invoiceId } });
            } else {
              invoice = null;
            }
          } catch {
            const qb = getInvoiceQb(false);
            if (qb) {
              invoice = await qb.where("invoice.id = :id", { id: invoiceId }).getOne();
            } else if (invoiceRepo) {
              invoice = await invoiceRepo.findOne({ where: { id: invoiceId } });
            } else if (typeof transactionalEntityManager.findOne === "function") {
              invoice = await transactionalEntityManager.findOne(Invoice, { where: { id: invoiceId } });
            } else {
              invoice = null;
            }
          }

          if (!invoice) {
            throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
          }

          // 2. Validate invoice status
          if (invoice.status !== InvoiceStatus.PUBLISHED) {
            if (invoice.status === InvoiceStatus.FUNDED) {
              throw new ServiceError(
                "INSUFFICIENT_CAPACITY",
                "Invoice is already fully funded"
              );
            }
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
            investorWallet,
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
          // Keep funded_amount in step with this path too, so it and
          // POST /invoices/:id/invest agree on remaining capacity. The row is
          // locked above, so the plain save is safe here.
          invoice.fundedAmount = newTotalInvested.toFixed(4);
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
          } else {
            await transactionalEntityManager.save(Invoice, invoice);
          }

          return { savedInvestment, invoice, fundedTransition };
        });

        await this.investmentNotifier?.investmentCreated({ invoice, investment: savedInvestment });
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

    throw new ServiceError(
      "CONCURRENT_INVESTMENT_CONFLICT",
      "Unable to process investment due to concurrent modifications. Please retry.",
      409
    );
  }
}

export function createInvestmentService(
  dataSource: DataSource,
  stateMachine?: InvoiceStateMachine,
  investmentNotifier?: InvestmentNotifier
): InvestmentService {
  return new InvestmentService(dataSource, stateMachine, investmentNotifier);
}
