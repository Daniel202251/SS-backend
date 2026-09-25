import { DataSource, EntityManager } from "typeorm";
import { Decimal } from "decimal.js";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvestorPayout } from "../models/InvestorPayout.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";
import { InvestorPayoutStatus } from "../models/InvestorPayout.model";
import { Transaction } from "../models/Transaction.model";
import { TransactionType, TransactionStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { computeInvestorReturn } from "../lib/investor-return";
import { decimalStringToScaledBigInt, scaledBigIntToDecimalString } from "../lib/decimal-bigint";
import {
  createInvoiceStateMachine,
  entityManagerTransitionStore,
  type InvoiceStateMachine,
} from "../lib/invoice-state-machine";
import { logger } from "../observability/logger";
import { NotificationService } from "./notification.service";
import { NotificationType } from "../types/enums";
import type { InvoiceEscrowContractService } from "./stellar/invoice-escrow-contract.service";

const DECIMAL_SCALE_TO_STROOP_FACTOR = 10n ** 3n;

export interface AdminSettleInvoiceInput {
  invoiceId: string;
  repaymentAmount: string;
  actorWallet: string;
}

export interface AdminSettleInvoiceResult {
  invoiceId: string;
  status: InvoiceStatus.SETTLED;
  repaymentAmount: string;
  payouts: {
    investorId: string;
    investmentId: string;
    amount: string;
    payoutId: string;
  }[];
  distributionTransactionHash?: string;
}

export class AdminSettlementService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly invoiceEscrowContract: InvoiceEscrowContractService,
    private readonly notificationService: NotificationService,
    private readonly stateMachine: InvoiceStateMachine = createInvoiceStateMachine()
  ) {}

  /**
   * Settles a funded invoice by calling settle_escrow on-chain,
   * recording per-investor payouts, and transitioning invoice to SETTLED.
   */
  async settleInvoice(input: AdminSettleInvoiceInput): Promise<AdminSettleInvoiceResult> {
    const { invoiceId, repaymentAmount: repaymentAmountInput, actorWallet } = input;

    const repaymentAmount = new Decimal(repaymentAmountInput);
    if (repaymentAmount.isNegative() || repaymentAmount.isZero()) {
      throw new ServiceError("INVALID_REPAYMENT_AMOUNT", "Repayment amount must be greater than zero", 400);
    }

    const startedAt = Date.now();
    logger.info("Admin settlement started", {
      invoiceId,
      actorWallet,
      repaymentAmount: repaymentAmount.toFixed(4),
      startedAt: new Date(startedAt).toISOString(),
    });

    try {
      // 1. First, execute on-chain settlement (outside transaction to avoid DB writes before confirmation)
      let distributionTransactionHash: string;
      let ledger: number | null;
      try {
        const result = await this.invoiceEscrowContract.settleEscrowOnChain(invoiceId);
        distributionTransactionHash = result.transactionHash;
        ledger = result.ledger;
      } catch (err) {
        if (err instanceof ServiceError) throw err;
        logger.error("On-chain settlement failed", {
          invoiceId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new ServiceError(
          "ON_CHAIN_SETTLEMENT_ERROR",
          "Failed to execute on-chain settlement",
          502,
          { originalError: err instanceof Error ? err.message : String(err) }
        );
      }

      // 2. Now that on-chain settlement is confirmed, do DB updates in a transaction
      const result = await this.dataSource.transaction(
        async (transactionalEntityManager: EntityManager) => {
          // Lock the invoice row for update
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

          // Validate invoice status is FUNDED (re-check after on-chain confirmation)
          if (invoice.status !== InvoiceStatus.FUNDED) {
            throw new ServiceError(
              "INVALID_INVOICE_STATUS",
              `Cannot settle an invoice with status ${invoice.status}. Invoice must be FUNDED.`,
              400
            );
          }

          // Find confirmed investments backing this invoice
          const investments = await transactionalEntityManager.find(Investment, {
            where: { invoiceId: invoice.id, status: InvestmentStatus.CONFIRMED },
            relations: { investor: true },
          });

          if (investments.length === 0) {
            throw new ServiceError(
              "NO_CONFIRMED_INVESTMENTS",
              "Invoice has no confirmed investments to settle",
              400
            );
          }

          // Record the settlement transaction
          await transactionalEntityManager.save(
            Transaction,
            transactionalEntityManager.create(Transaction, {
              userId: invoice.sellerId,
              invoiceId: invoice.id,
              investmentId: null,
              type: TransactionType.PAYMENT,
              amount: repaymentAmount.toFixed(4),
              stellarTxHash: distributionTransactionHash,
              stellarOperationIndex: 0,
              status: TransactionStatus.COMPLETED,
            })
          );

          // Calculate pro-rata payouts and record investor_payouts
          const totalFunded = investments.reduce(
            (sum, investment) => sum.plus(new Decimal(investment.investmentAmount)),
            new Decimal(0)
          );
          const totalFundedScaled = decimalStringToScaledBigInt(totalFunded.toFixed(4));
          const repaymentAmountScaled = decimalStringToScaledBigInt(repaymentAmount.toFixed(4));

          const payouts: {
            investorId: string;
            investmentId: string;
            amount: string;
            payoutId: string;
          }[] = [];

          const investorPayoutRepo = transactionalEntityManager.getRepository(InvestorPayout);

          for (const investment of investments) {
            const investmentAmountScaled = decimalStringToScaledBigInt(investment.investmentAmount);
            const actualReturnScaled = computeInvestorReturn(
              investmentAmountScaled,
              totalFundedScaled,
              repaymentAmountScaled
            );
            const actualReturn = scaledBigIntToDecimalString(actualReturnScaled);

            // Create investor_payout record
            const payout = investorPayoutRepo.create({
              invoiceId: invoice.id,
              investorId: investment.investorId,
              investmentId: investment.id,
              amount: actualReturn,
              status: InvestorPayoutStatus.COMPLETED,
              stellarTxHash: distributionTransactionHash,
            });
            await investorPayoutRepo.save(payout);

            // Update investment with actual return and settled status
            investment.actualReturn = actualReturn;
            investment.status = InvestmentStatus.SETTLED;
            await transactionalEntityManager.save(Investment, investment);

            payouts.push({
              investorId: investment.investorId,
              investmentId: investment.id,
              amount: actualReturn,
              payoutId: payout.id,
            });
          }

          // Transition invoice to SETTLED (history row written in this transaction)
          const transition = await this.stateMachine.transition(
            entityManagerTransitionStore(transactionalEntityManager),
            invoice,
            InvoiceStatus.SETTLED,
            { actor: { role: "admin", wallet: actorWallet }, trigger: "admin_settled" }
          );

          await this.stateMachine.dispatch(transition);

          logger.info("Admin settlement completed successfully", {
            invoiceId: invoice.id,
            repaymentAmount: repaymentAmount.toFixed(4),
            payoutCount: payouts.length,
            durationMs: Date.now() - startedAt,
            distributionTxHash: distributionTransactionHash,
            ledger,
          });

          return {
            invoiceId: invoice.id,
            status: InvoiceStatus.SETTLED as const,
            repaymentAmount: repaymentAmount.toFixed(4),
            payouts,
            distributionTransactionHash,
          };
        }
      );

      // 3. Notify every investor (outside transaction, after DB settlement succeeds)
      await this.notifyInvestors(result.invoiceId, result.payouts);

      return result;
    } catch (err) {
      logger.error("Admin settlement failed", {
        invoiceId,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  private async notifyInvestors(
    invoiceId: string,
    payouts: { investorId: string; amount: string }[]
  ): Promise<void> {
    const notificationEntries = payouts.map((payout) => ({
      userId: payout.investorId,
      type: NotificationType.PAYMENT,
      title: "Invoice Settled - Payout Received",
      message: `Your investment in invoice ${invoiceId} has been settled. You received ${payout.amount} XLM.`,
    }));

    if (notificationEntries.length > 0) {
      try {
        await this.notificationService.createNotifications(notificationEntries);
        logger.info("Investor settlement notifications sent", {
          invoiceId,
          notificationCount: notificationEntries.length,
        });
      } catch (err) {
        logger.error("Failed to send investor settlement notifications", {
          invoiceId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Don't throw - notifications are best-effort
      }
    }
  }
}

export function createAdminSettlementService(
  dataSource: DataSource,
  invoiceEscrowContract: InvoiceEscrowContractService,
  notificationService: NotificationService,
  stateMachine?: InvoiceStateMachine
): AdminSettlementService {
  return new AdminSettlementService(dataSource, invoiceEscrowContract, notificationService, stateMachine);
}