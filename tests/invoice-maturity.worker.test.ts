import {
  InvoiceMaturityWorker,
  MATURITY_JOB_ACTOR,
  SETTLEMENT_EVENTS,
  SettlementEventBus,
  type MaturedInvoice,
  type MaturedInvoiceRepository,
} from "../src/workers/invoice-maturity.worker";
import type { AppLogger, LogMetadata } from "../src/observability/logger";
import type { InvoiceTransition } from "../src/lib/invoice-state-machine";
import type { SettleInvoiceInput } from "../src/services/settlement.service";
import { InvoiceStatus } from "../src/types/enums";

interface LogEntry {
  level: string;
  message: string;
  metadata: LogMetadata;
}

class CaptureLogger implements AppLogger {
  constructor(readonly entries: LogEntry[] = []) {}
  debug(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: "debug", message, metadata });
  }
  info(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: "info", message, metadata });
  }
  warn(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: "warn", message, metadata });
  }
  error(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: "error", message, metadata });
  }
  child(): AppLogger {
    return this;
  }
}

const config = { enabled: true, intervalMs: 5 * 60 * 1000, batchSize: 50 };

function buildWorker(invoices: MaturedInvoice[], overrides: Partial<MaturedInvoiceRepository> = {}) {
  const transition = { invoice: { id: "x" } } as unknown as InvoiceTransition;
  const repository: MaturedInvoiceRepository = {
    findMaturedInvoices: jest.fn().mockResolvedValue(invoices),
    markUnderfunded: jest.fn().mockResolvedValue(transition),
    ...overrides,
  };
  const settler = {
    settleInvoice: jest.fn(async (input: SettleInvoiceInput) => ({
      invoiceId: input.invoiceId,
      status: InvoiceStatus.SETTLED as const,
      proceeds: input.proceeds,
      totalDistributed: input.proceeds,
      remainder: "0.0000",
      remainderDust: "0.0000",
      settlements: [
        { investmentId: "inv-1", investorId: "u-1", investmentAmount: "60", actualReturn: "600" },
        { investmentId: "inv-2", investorId: "u-2", investmentAmount: "40", actualReturn: "400" },
      ],
    })),
  };
  const stateMachine = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const events = new SettlementEventBus();
  const logger = new CaptureLogger();
  const worker = new InvoiceMaturityWorker({
    repository,
    settler,
    stateMachine,
    events,
    config,
    logger,
    now: () => new Date("2026-09-25T12:00:00Z"),
  });
  return { worker, repository, settler, stateMachine, events, logger, transition };
}

describe("InvoiceMaturityWorker", () => {
  it("settles funded matured invoices with face value as proceeds and emits a settlement event", async () => {
    const { worker, settler, events } = buildWorker([
      { id: "a", status: InvoiceStatus.FUNDED, amount: "1000.0000" },
    ]);
    const settled = jest.fn();
    events.on(SETTLEMENT_EVENTS.SETTLED, settled);

    const result = await worker.runTick();

    expect(settler.settleInvoice).toHaveBeenCalledWith({
      invoiceId: "a",
      proceeds: "1000.0000",
      actorWallet: MATURITY_JOB_ACTOR,
      trigger: "maturity_settled",
    });
    expect(result.settled).toEqual(["a"]);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0][0]).toMatchObject({
      invoiceId: "a",
      settlements: [{ actualReturn: "600" }, { actualReturn: "400" }],
    });
  });

  it("marks underfunded matured invoices as failed and dispatches the transition", async () => {
    const { worker, repository, stateMachine, events, transition } = buildWorker([
      { id: "b", status: InvoiceStatus.PUBLISHED, amount: "500" },
    ]);
    const failed = jest.fn();
    events.on(SETTLEMENT_EVENTS.FAILED, failed);

    const result = await worker.runTick();

    expect(repository.markUnderfunded).toHaveBeenCalledWith("b");
    expect(stateMachine.dispatch).toHaveBeenCalledWith(transition);
    expect(result.failed).toEqual(["b"]);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: "b" }));
  });

  it("skips invoices that no longer qualify for failure", async () => {
    const { worker, stateMachine } = buildWorker(
      [{ id: "c", status: InvoiceStatus.PUBLISHED, amount: "500" }],
      { markUnderfunded: jest.fn().mockResolvedValue(null) }
    );

    const result = await worker.runTick();

    expect(result.skipped).toEqual(["c"]);
    expect(stateMachine.dispatch).not.toHaveBeenCalled();
  });

  it("does not emit a settlement event when settlement fails, and keeps processing", async () => {
    const { worker, settler, events } = buildWorker([
      { id: "d", status: InvoiceStatus.FUNDED, amount: "100" },
      { id: "e", status: InvoiceStatus.FUNDED, amount: "200" },
    ]);
    settler.settleInvoice.mockRejectedValueOnce(new Error("boom"));
    const settled = jest.fn();
    events.on(SETTLEMENT_EVENTS.SETTLED, settled);

    const result = await worker.runTick();

    expect(result.errored).toEqual(["d"]);
    expect(result.settled).toEqual(["e"]);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("logs the invoice ids processed in each run", async () => {
    const { worker, logger } = buildWorker([
      { id: "f", status: InvoiceStatus.FUNDED, amount: "100" },
      { id: "g", status: InvoiceStatus.PUBLISHED, amount: "100" },
    ]);

    await worker.runTick();

    const summary = logger.entries.find((e) => e.message === "Completed invoice maturity run.");
    expect(summary?.metadata).toMatchObject({
      detected_count: 2,
      settled_invoice_ids: ["f"],
      failed_invoice_ids: ["g"],
      errored_invoice_ids: [],
    });
    expect(summary?.metadata.run_id).toEqual(expect.any(String));
  });

  it("schedules ticks on the configured interval", () => {
    const setIntervalFn = jest.fn().mockReturnValue(1) as unknown as typeof setInterval;
    const { repository } = buildWorker([]);
    const worker = new InvoiceMaturityWorker({
      repository,
      settler: { settleInvoice: jest.fn() },
      stateMachine: { dispatch: jest.fn() },
      events: new SettlementEventBus(),
      config,
      logger: new CaptureLogger(),
      setIntervalFn,
    });

    worker.start();

    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 300000);
    expect(repository.findMaturedInvoices).toHaveBeenCalled();
  });
});
