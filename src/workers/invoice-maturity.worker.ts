import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { DataSource, EntityManager, In, LessThanOrEqual } from "typeorm";
import { Decimal } from "decimal.js";
import type { AppConfig } from "../config/env";
import { Invoice } from "../models/Invoice.model";
import { InvoiceStatus } from "../types/enums";
import {
  entityManagerTransitionStore,
  type InvoiceStateMachine,
  type InvoiceTransition,
} from "../lib/invoice-state-machine";
import type { SettleInvoiceInput, SettleInvoiceResult } from "../services/settlement.service";
import type { AppLogger } from "../observability/logger";

type IntervalHandle = ReturnType<typeof setInterval>;

export const MATURITY_JOB_ACTOR = "system:invoice-maturity-job";

export interface MaturedInvoice {
  id: string;
  status: InvoiceStatus.PUBLISHED | InvoiceStatus.FUNDED;
  /** Face value; repaid at maturity and distributed to investors pro-rata. */
  amount: string;
}

export interface MaturedInvoiceRepository {
  /** Published or funded invoices whose due date is on or before `asOf`. */
  findMaturedInvoices(asOf: Date, limit: number): Promise<MaturedInvoice[]>;
  /**
   * Moves an under-funded invoice to `failed`. Returns null when the invoice
   * no longer qualifies (it changed status or is actually fully funded).
   */
  markUnderfunded(invoiceId: string): Promise<InvoiceTransition | null>;
}

export interface InvoiceSettler {
  settleInvoice(input: SettleInvoiceInput): Promise<SettleInvoiceResult>;
}

export interface InvoiceSettledEvent extends SettleInvoiceResult {
  settledAt: Date;
}

export interface InvoiceMaturityFailedEvent {
  invoiceId: string;
  failedAt: Date;
}

/** Consumers (e.g. notification dispatch) subscribe to settlement outcomes here. */
export interface SettlementEventSink {
  emitSettled(event: InvoiceSettledEvent): void;
  emitFailed(event: InvoiceMaturityFailedEvent): void;
}

export const SETTLEMENT_EVENTS = {
  SETTLED: "invoice.settled",
  FAILED: "invoice.maturity_failed",
} as const;

export class SettlementEventBus extends EventEmitter implements SettlementEventSink {
  emitSettled(event: InvoiceSettledEvent): void {
    this.emit(SETTLEMENT_EVENTS.SETTLED, event);
  }

  emitFailed(event: InvoiceMaturityFailedEvent): void {
    this.emit(SETTLEMENT_EVENTS.FAILED, event);
  }
}

export interface MaturityTickResult {
  runId: string;
  detected: string[];
  settled: string[];
  failed: string[];
  skipped: string[];
  errored: string[];
  durationMs: number;
}

export interface InvoiceMaturityWorkerDependencies {
  repository: MaturedInvoiceRepository;
  settler: InvoiceSettler;
  stateMachine: Pick<InvoiceStateMachine, "dispatch">;
  events: SettlementEventSink;
  config: AppConfig["maturity"];
  logger: AppLogger;
  now?: () => Date;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export class InvoiceMaturityWorker {
  private readonly logger: AppLogger;
  private readonly now: () => Date;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private intervalHandle: IntervalHandle | null = null;
  private inFlightTick: Promise<MaturityTickResult> | null = null;

  constructor(private readonly deps: InvoiceMaturityWorkerDependencies) {
    this.logger = deps.logger.child({ component: "invoice-maturity-worker" });
    this.now = deps.now ?? (() => new Date());
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  start(): void {
    if (!this.deps.config.enabled || this.intervalHandle) {
      return;
    }

    this.logger.info("Starting invoice maturity worker.", {
      intervalMs: this.deps.config.intervalMs,
      batchSize: this.deps.config.batchSize,
    });

    void this.scheduleTick();
    this.intervalHandle = this.setIntervalFn(() => {
      void this.scheduleTick();
    }, this.deps.config.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = null;
    }

    if (this.inFlightTick) {
      await this.inFlightTick;
    }

    this.logger.info("Stopped invoice maturity worker.");
  }

  async runTick(): Promise<MaturityTickResult> {
    const startedAt = this.now();
    const result: MaturityTickResult = {
      runId: randomUUID(),
      detected: [],
      settled: [],
      failed: [],
      skipped: [],
      errored: [],
      durationMs: 0,
    };

    try {
      const invoices = await this.deps.repository.findMaturedInvoices(
        startedAt,
        this.deps.config.batchSize
      );
      result.detected = invoices.map((invoice) => invoice.id);

      for (const invoice of invoices) {
        try {
          if (invoice.status === InvoiceStatus.FUNDED) {
            await this.settle(invoice, result);
          } else {
            await this.fail(invoice, result);
          }
        } catch (error) {
          result.errored.push(invoice.id);
          this.logger.warn("Failed to process matured invoice.", {
            run_id: result.runId,
            invoice_id: invoice.id,
            invoice_status: invoice.status,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    } catch (error) {
      this.logger.error("Invoice maturity tick crashed.", {
        run_id: result.runId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }

    result.durationMs = this.now().getTime() - startedAt.getTime();

    this.logger.info("Completed invoice maturity run.", {
      run_id: result.runId,
      detected_count: result.detected.length,
      settled_invoice_ids: result.settled,
      failed_invoice_ids: result.failed,
      skipped_invoice_ids: result.skipped,
      errored_invoice_ids: result.errored,
      duration_ms: result.durationMs,
    });

    return result;
  }

  private async settle(invoice: MaturedInvoice, result: MaturityTickResult): Promise<void> {
    // settleInvoice computes and stores each investor's pro-rata return and
    // moves the invoice to settled in one database transaction.
    const settlement = await this.deps.settler.settleInvoice({
      invoiceId: invoice.id,
      proceeds: invoice.amount,
      actorWallet: MATURITY_JOB_ACTOR,
      trigger: "maturity_settled",
    });
    result.settled.push(invoice.id);
    this.deps.events.emitSettled({ ...settlement, settledAt: this.now() });
  }

  private async fail(invoice: MaturedInvoice, result: MaturityTickResult): Promise<void> {
    const transition = await this.deps.repository.markUnderfunded(invoice.id);
    if (!transition) {
      result.skipped.push(invoice.id);
      return;
    }
    result.failed.push(invoice.id);
    await this.deps.stateMachine.dispatch(transition);
    this.deps.events.emitFailed({ invoiceId: invoice.id, failedAt: this.now() });
  }

  private async scheduleTick(): Promise<void> {
    if (this.inFlightTick) {
      this.logger.warn("Skipping invoice maturity tick because one is already running.");
      return;
    }

    this.inFlightTick = this.runTick().finally(() => {
      this.inFlightTick = null;
    });

    await this.inFlightTick;
  }
}

/** `due_date` is a DATE column, so compare against the calendar day (UTC). */
function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

class TypeOrmMaturedInvoiceRepository implements MaturedInvoiceRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly stateMachine: InvoiceStateMachine
  ) {}

  async findMaturedInvoices(asOf: Date, limit: number): Promise<MaturedInvoice[]> {
    const rows = await this.dataSource.getRepository(Invoice).find({
      select: { id: true, status: true, amount: true },
      where: {
        status: In([InvoiceStatus.PUBLISHED, InvoiceStatus.FUNDED]),
        dueDate: LessThanOrEqual(toDateOnly(asOf) as unknown as Date),
      },
      order: { dueDate: "ASC" },
      take: limit,
    });
    return rows as MaturedInvoice[];
  }

  async markUnderfunded(invoiceId: string): Promise<InvoiceTransition | null> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      let invoice: Invoice | null;
      try {
        invoice = await manager
          .createQueryBuilder(Invoice, "invoice")
          .setLock("pessimistic_write")
          .where("invoice.id = :id", { id: invoiceId })
          .getOne();
      } catch {
        // SQLite has no row locks.
        invoice = await manager.findOne(Invoice, { where: { id: invoiceId } });
      }

      if (!invoice || invoice.status !== InvoiceStatus.PUBLISHED) {
        return null;
      }
      // Fully funded but not yet transitioned: leave it for the funding flow
      // rather than failing money that is actually committed.
      if (new Decimal(invoice.fundedAmount ?? 0).gte(invoice.netAmount)) {
        return null;
      }

      return this.stateMachine.transition(
        entityManagerTransitionStore(manager),
        invoice,
        InvoiceStatus.FAILED,
        {
          actor: { role: "system", wallet: MATURITY_JOB_ACTOR },
          trigger: "maturity_underfunded",
          context: { reason: "Not fully funded by maturity date." },
        }
      );
    });
  }
}

export function createInvoiceMaturityWorker(
  dataSource: DataSource,
  settler: InvoiceSettler,
  stateMachine: InvoiceStateMachine,
  events: SettlementEventSink,
  config: AppConfig["maturity"],
  logger: AppLogger
): InvoiceMaturityWorker {
  return new InvoiceMaturityWorker({
    repository: new TypeOrmMaturedInvoiceRepository(dataSource, stateMachine),
    settler,
    stateMachine,
    events,
    config,
    logger,
  });
}
