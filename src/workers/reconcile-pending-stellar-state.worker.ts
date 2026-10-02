import { randomUUID } from "crypto";
import { DataSource, LessThanOrEqual, Not, IsNull, Repository } from "typeorm";
import type { AppConfig } from "../config/env";
import type {
  PaymentVerificationInput,
  PaymentVerificationResult,
  VerifyPaymentService,
} from "../services/stellar/verify-payment.service";
import { Investment } from "../models/Investment.model";
import { Transaction } from "../models/Transaction.model";
import { InvestmentStatus, TransactionStatus, TransactionType } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { classifyReconciliationError } from "../services/stellar/reconciliation-retry";
import type { AppLogger } from "../observability/logger";

type YieldControl = () => Promise<void>;
type IntervalHandle = ReturnType<typeof setInterval>;

export interface ReconciliationCandidate {
  investmentId: string;
  stellarTxHash: string;
  operationIndex?: number;
  source: "investment" | "transaction";
  queuedAt: Date;
}

export interface ReconciliationCandidateRepository {
  findPendingCandidates(olderThan: Date, limit: number): Promise<ReconciliationCandidate[]>;
}

export interface PaymentVerifier {
  verifyPayment(input: PaymentVerificationInput): Promise<PaymentVerificationResult>;
}

export interface ReconciliationTickResult {
  candidatesFetched: number;
  processed: number;
  verified: number;
  alreadyVerified: number;
  failed: number;
  deferredDueToRuntime: number;
  durationMs: number;
}

import type { EventIndexerService } from "../services/stellar/event-indexer.service";

export interface ReconcilePendingStellarStateWorkerDependencies {
  repository: ReconciliationCandidateRepository;
  paymentVerifier: PaymentVerifier;
  eventIndexer?: EventIndexerService;
  config: AppConfig["reconciliation"];
  logger: AppLogger;
  now?: () => Date;
  yieldControl?: YieldControl;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

const EMPTY_TICK_RESULT: ReconciliationTickResult = {
  candidatesFetched: 0,
  processed: 0,
  verified: 0,
  alreadyVerified: 0,
  failed: 0,
  deferredDueToRuntime: 0,
  durationMs: 0,
};

export class ReconcilePendingStellarStateWorker {
  private readonly repository: ReconciliationCandidateRepository;
  private readonly paymentVerifier: PaymentVerifier;
  private readonly eventIndexer?: EventIndexerService;
  private readonly config: AppConfig["reconciliation"];
  private readonly logger: AppLogger;
  private readonly now: () => Date;
  private readonly yieldControl: YieldControl;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private intervalHandle: IntervalHandle | null = null;
  private inFlightTick: Promise<ReconciliationTickResult> | null = null;
  private readonly attemptTracker = new Map<string, number>();

  constructor(dependencies: ReconcilePendingStellarStateWorkerDependencies) {
    this.repository = dependencies.repository;
    this.paymentVerifier = dependencies.paymentVerifier;
    this.eventIndexer = dependencies.eventIndexer;
    this.config = dependencies.config;
    this.logger = dependencies.logger.child({
      component: "stellar-reconciliation-worker",
    });
    this.now = dependencies.now ?? (() => new Date());
    this.yieldControl =
      dependencies.yieldControl ?? (() => new Promise((resolve) => setImmediate(resolve)));
    this.setIntervalFn = dependencies.setIntervalFn ?? setInterval;
    this.clearIntervalFn = dependencies.clearIntervalFn ?? clearInterval;
  }

  start(): void {
    if (!this.config.enabled || this.intervalHandle) {
      return;
    }

    this.logger.info("Starting Stellar reconciliation worker.", {
      intervalMs: this.config.intervalMs,
      batchSize: this.config.batchSize,
      gracePeriodMs: this.config.gracePeriodMs,
      maxRuntimeMs: this.config.maxRuntimeMs,
      singleReplicaAssumption: true,
    });

    void this.scheduleTick();
    this.intervalHandle = this.setIntervalFn(() => {
      void this.scheduleTick();
    }, this.config.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = null;
    }

    if (this.inFlightTick) {
      await this.inFlightTick;
    }

    this.logger.info("Stopped Stellar reconciliation worker.");
  }

  async runTick(): Promise<ReconciliationTickResult> {
    const startedAt = this.now();
    const cutoff = new Date(startedAt.getTime() - this.config.gracePeriodMs);
    const deadline = startedAt.getTime() + this.config.maxRuntimeMs;

    try {
      const candidates = await this.repository.findPendingCandidates(cutoff, this.config.batchSize);

      this.attemptTracker.clear();

      const cycleId = randomUUID();
      this.logger.info("Started Stellar reconciliation tick.", {
        cycle_id: cycleId,
        pending_count: candidates.length,
        started_at: startedAt.toISOString(),
      });

      const result: ReconciliationTickResult = {
        ...EMPTY_TICK_RESULT,
        candidatesFetched: candidates.length,
      };

      for (let index = 0; index < candidates.length; index += 1) {
        if (this.now().getTime() >= deadline) {
          result.deferredDueToRuntime = candidates.length - index;
          break;
        }

        const candidate = candidates[index];
        const candidateKey = this.candidateKey(candidate);

        try {
          const verificationResult = await this.paymentVerifier.verifyPayment({
            investmentId: candidate.investmentId,
            stellarTxHash: candidate.stellarTxHash,
            operationIndex: candidate.operationIndex,
          });

          result.processed += 1;
          this.attemptTracker.delete(candidateKey);

          if (verificationResult.outcome === "verified") {
            result.verified += 1;
          } else {
            result.alreadyVerified += 1;
          }
        } catch (error) {
          result.processed += 1;
          result.failed += 1;

          const attempt = (this.attemptTracker.get(candidateKey) ?? 0) + 1;
          this.attemptTracker.set(candidateKey, attempt);

          const classification = classifyReconciliationError(error, attempt);

          this.logger.warn("Failed to reconcile pending Stellar state.", {
            event: "investment_funding_failed",
            investment_id: candidate.investmentId,
            stellar_tx_hash: candidate.stellarTxHash,
            operation_index: candidate.operationIndex,
            source: candidate.source,
            errorCode: error instanceof ServiceError ? error.code : undefined,
            retryable: classification.retryable,
            failureKind: classification.kind,
            attempt: classification.attempt,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }

        await this.yieldControl();
      }

      if (this.eventIndexer) {
        try {
          const events = await this.eventIndexer.pollContractEvents();
          if (events.length > 0) {
            await this.eventIndexer.ingestEvents(events);
          }
        } catch (indexerErr) {
          this.logger.warn("Failed to poll or ingest contract events during reconciliation tick", {
            err: indexerErr,
          });
        }
      }

      result.durationMs = this.now().getTime() - startedAt.getTime();

      this.logger.debug("Completed Stellar reconciliation tick.", {
        cycle_id: cycleId,
        confirmed_count: result.verified,
        failed_count: result.failed,
        skipped_count: result.alreadyVerified,
        duration_ms: result.durationMs,
      });

      return result;
    } catch (error) {
      const result = {
        ...EMPTY_TICK_RESULT,
        durationMs: this.now().getTime() - startedAt.getTime(),
      };

      this.logger.error("Stellar reconciliation tick crashed.", {
        error: error instanceof Error ? error.message : "Unknown error",
        durationMs: result.durationMs,
      });

      return result;
    }
  }

  private async scheduleTick(): Promise<void> {
    if (this.inFlightTick) {
      this.logger.warn("Skipping Stellar reconciliation tick because one is already running.");
      return;
    }

    this.inFlightTick = this.runTick().finally(() => {
      this.inFlightTick = null;
    });

    await this.inFlightTick;
  }

  private candidateKey(candidate: ReconciliationCandidate): string {
    return `${candidate.source}:${candidate.investmentId}:${candidate.stellarTxHash}`;
  }
}

class TypeOrmReconciliationCandidateRepository implements ReconciliationCandidateRepository {
  constructor(
    private readonly investmentRepository: Repository<Investment>,
    private readonly transactionRepository: Repository<Transaction>
  ) {}

  async findPendingCandidates(olderThan: Date, limit: number): Promise<ReconciliationCandidate[]> {
    const investmentRows = await this.investmentRepository.find({
      where: {
        status: InvestmentStatus.PENDING,
        createdAt: LessThanOrEqual(olderThan),
        transactionHash: Not(IsNull()),
      },
      order: {
        createdAt: "ASC",
      },
      take: limit,
    });
    const transactionRows = await this.transactionRepository.find({
      where: {
        status: TransactionStatus.PENDING,
        type: TransactionType.INVESTMENT,
        timestamp: LessThanOrEqual(olderThan),
        investmentId: Not(IsNull()),
        stellarTxHash: Not(IsNull()),
      },
      order: {
        timestamp: "ASC",
      },
      take: limit,
    });

    const candidatesByInvestmentId = new Map<string, ReconciliationCandidate>();

    for (const investment of investmentRows) {
      if (!investment.transactionHash) {
        continue;
      }

      candidatesByInvestmentId.set(investment.id, {
        investmentId: investment.id,
        stellarTxHash: investment.transactionHash,
        operationIndex: investment.stellarOperationIndex ?? undefined,
        source: "investment",
        queuedAt: investment.createdAt,
      });
    }

    for (const transaction of transactionRows) {
      if (!transaction.investmentId || !transaction.stellarTxHash) {
        continue;
      }

      if (candidatesByInvestmentId.has(transaction.investmentId)) {
        continue;
      }

      candidatesByInvestmentId.set(transaction.investmentId, {
        investmentId: transaction.investmentId,
        stellarTxHash: transaction.stellarTxHash,
        operationIndex: transaction.stellarOperationIndex ?? undefined,
        source: "transaction",
        queuedAt: transaction.timestamp,
      });
    }

    return [...candidatesByInvestmentId.values()]
      .sort((left, right) => left.queuedAt.getTime() - right.queuedAt.getTime())
      .slice(0, limit);
  }
}

export function createReconcilePendingStellarStateWorker(
  dataSource: DataSource,
  paymentVerifier: VerifyPaymentService,
  config: AppConfig["reconciliation"],
  logger: AppLogger
): ReconcilePendingStellarStateWorker {
  return new ReconcilePendingStellarStateWorker({
    repository: new TypeOrmReconciliationCandidateRepository(
      dataSource.getRepository(Investment),
      dataSource.getRepository(Transaction)
    ),
    paymentVerifier,
    config,
    logger,
  });
}
