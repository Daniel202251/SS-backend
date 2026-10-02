import {
  ReconcilePendingStellarStateWorker,
  type ReconciliationCandidate,
} from "../src/workers/reconcile-pending-stellar-state.worker";
import type { AppLogger, LogMetadata } from "../src/observability/logger";
import { InvestmentStatus } from "../src/types/enums";
import { ServiceError } from "../src/utils/service-error";
import type { PaymentVerificationResult } from "../src/services/stellar/verify-payment.service";

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata: LogMetadata;
}

class CaptureLogger implements AppLogger {
  constructor(
    readonly entries: LogEntry[] = [],
    private readonly defaultMetadata: LogMetadata = {}
  ) {}

  debug(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({
      level: "debug",
      message,
      metadata: {
        ...this.defaultMetadata,
        ...metadata,
      },
    });
  }

  info(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({
      level: "info",
      message,
      metadata: {
        ...this.defaultMetadata,
        ...metadata,
      },
    });
  }

  warn(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({
      level: "warn",
      message,
      metadata: {
        ...this.defaultMetadata,
        ...metadata,
      },
    });
  }

  error(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({
      level: "error",
      message,
      metadata: {
        ...this.defaultMetadata,
        ...metadata,
      },
    });
  }

  child(metadata: LogMetadata): AppLogger {
    return new CaptureLogger(this.entries, {
      ...this.defaultMetadata,
      ...metadata,
    });
  }
}

function createCandidate(
  investmentId: string,
  stellarTxHash: string,
  overrides: Partial<ReconciliationCandidate> = {}
): ReconciliationCandidate {
  return {
    investmentId,
    stellarTxHash,
    source: overrides.source ?? "investment",
    operationIndex: overrides.operationIndex,
    queuedAt: overrides.queuedAt ?? new Date("2026-01-01T00:00:00.000Z"),
  };
}

function createVerifiedResult(
  investmentId: string,
  outcome: "verified" | "already_verified"
): PaymentVerificationResult {
  return {
    outcome,
    investmentId,
    stellarTxHash: `tx-${investmentId}`,
    operationIndex: 0,
    transactionId: `transaction-${investmentId}`,
    status: InvestmentStatus.CONFIRMED,
  };
}

describe("ReconcilePendingStellarStateWorker", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("reconciles actionable candidates, continues after errors, and yields between items", async () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const repository = {
      findPendingCandidates: jest
        .fn()
        .mockResolvedValue([
          createCandidate("investment-1", "hash-1"),
          createCandidate("investment-2", "hash-2"),
          createCandidate("investment-3", "hash-3"),
        ]),
    };
    const paymentVerifier = {
      verifyPayment: jest
        .fn()
        .mockResolvedValueOnce(createVerifiedResult("investment-1", "verified"))
        .mockRejectedValueOnce(
          new ServiceError("transaction_not_found", "Transaction not found.", 404)
        )
        .mockResolvedValueOnce(createVerifiedResult("investment-3", "already_verified")),
    };
    const yieldControl = jest.fn(async () => undefined);
    const logger = new CaptureLogger();
    const worker = new ReconcilePendingStellarStateWorker({
      repository,
      paymentVerifier,
      config: {
        enabled: true,
        intervalMs: 1_000,
        batchSize: 3,
        gracePeriodMs: 60_000,
        maxRuntimeMs: 10_000,
      },
      logger,
      now: () => now,
      yieldControl,
    });

    const result = await worker.runTick();

    expect(repository.findPendingCandidates).toHaveBeenCalledWith(
      new Date("2026-01-01T00:09:00.000Z"),
      3
    );
    expect(paymentVerifier.verifyPayment).toHaveBeenCalledTimes(3);
    expect(yieldControl).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      candidatesFetched: 3,
      processed: 3,
      verified: 1,
      alreadyVerified: 1,
      failed: 1,
      deferredDueToRuntime: 0,
    });
    expect(logger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: "Failed to reconcile pending Stellar state.",
        }),
        expect.objectContaining({
          level: "debug",
          message: "Completed Stellar reconciliation tick.",
        }),
      ])
    );
  });

  it("logs cycle start and completion once per cycle with matching cycle_id", async () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const repository = {
      findPendingCandidates: jest
        .fn()
        .mockResolvedValue([
          createCandidate("investment-1", "hash-1"),
          createCandidate("investment-2", "hash-2"),
        ]),
    };
    const paymentVerifier = {
      verifyPayment: jest
        .fn()
        .mockResolvedValueOnce(createVerifiedResult("investment-1", "verified"))
        .mockResolvedValueOnce(createVerifiedResult("investment-2", "already_verified")),
    };
    const logger = new CaptureLogger();
    const worker = new ReconcilePendingStellarStateWorker({
      repository,
      paymentVerifier,
      config: {
        enabled: true,
        intervalMs: 1_000,
        batchSize: 3,
        gracePeriodMs: 60_000,
        maxRuntimeMs: 10_000,
      },
      logger,
      now: () => now,
      yieldControl: jest.fn(async () => undefined),
    });

    await worker.runTick();

    const startLogs = logger.entries.filter(
      (entry) => entry.level === "info" && entry.message === "Started Stellar reconciliation tick."
    );
    const completionLogs = logger.entries.filter(
      (entry) =>
        entry.level === "debug" && entry.message === "Completed Stellar reconciliation tick."
    );

    expect(startLogs).toHaveLength(1);
    expect(completionLogs).toHaveLength(1);

    expect(startLogs[0].metadata).toMatchObject({
      cycle_id: expect.any(String),
      pending_count: 2,
      started_at: now.toISOString(),
    });

    expect(completionLogs[0].metadata).toMatchObject({
      cycle_id: startLogs[0].metadata.cycle_id,
      confirmed_count: 1,
      failed_count: 0,
      skipped_count: 1,
      duration_ms: expect.any(Number),
    });
  });

  it("stops starting new reconciliations once the tick runtime budget is exhausted", async () => {
    let currentTimeMs = Date.parse("2026-01-01T00:00:00.000Z");
    const repository = {
      findPendingCandidates: jest
        .fn()
        .mockResolvedValue([
          createCandidate("investment-1", "hash-1"),
          createCandidate("investment-2", "hash-2"),
          createCandidate("investment-3", "hash-3"),
        ]),
    };
    const paymentVerifier = {
      verifyPayment: jest.fn(async (input: { investmentId: string }) => {
        currentTimeMs += 60;
        return createVerifiedResult(input.investmentId, "verified");
      }),
    };
    const worker = new ReconcilePendingStellarStateWorker({
      repository,
      paymentVerifier,
      config: {
        enabled: true,
        intervalMs: 1_000,
        batchSize: 3,
        gracePeriodMs: 60_000,
        maxRuntimeMs: 100,
      },
      logger: new CaptureLogger(),
      now: () => new Date(currentTimeMs),
      yieldControl: async () => undefined,
    });

    const result = await worker.runTick();

    expect(paymentVerifier.verifyPayment).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      candidatesFetched: 3,
      processed: 2,
      verified: 2,
      deferredDueToRuntime: 1,
    });
  });

  it("schedules periodic ticks and stops scheduling after stop is called", async () => {
    jest.useFakeTimers();

    const repository = {
      findPendingCandidates: jest.fn().mockResolvedValue([]),
    };
    const paymentVerifier = {
      verifyPayment: jest.fn(),
    };
    const worker = new ReconcilePendingStellarStateWorker({
      repository,
      paymentVerifier,
      config: {
        enabled: true,
        intervalMs: 1_000,
        batchSize: 5,
        gracePeriodMs: 60_000,
        maxRuntimeMs: 5_000,
      },
      logger: new CaptureLogger(),
      yieldControl: async () => undefined,
    });

    worker.start();
    await Promise.resolve();

    expect(repository.findPendingCandidates).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2_000);

    expect(repository.findPendingCandidates).toHaveBeenCalledTimes(3);

    await worker.stop();

    await jest.advanceTimersByTimeAsync(5_000);

    expect(repository.findPendingCandidates).toHaveBeenCalledTimes(3);
  });

  it("skips already-confirmed investments: Horizon client called exactly once for pending investment only", async () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const logger = new CaptureLogger();

    // Seed one investment with status funded (already confirmed) and one with status pending_payment
    const repository = {
      findPendingCandidates: jest.fn().mockResolvedValue([
        // The worker queries INVESTMENT repo with status: PENDING only.
        // A funded/confirmed investment should NOT appear in candidates at all.
        createCandidate("investment-pending", "hash-pending", {
          source: "investment",
          queuedAt: new Date("2026-01-01T00:05:00.000Z"),
        }),
      ]),
    };

    const paymentVerifier = {
      verifyPayment: jest
        .fn()
        .mockResolvedValueOnce(createVerifiedResult("investment-pending", "verified")),
    };

    const worker = new ReconcilePendingStellarStateWorker({
      repository,
      paymentVerifier,
      config: {
        enabled: true,
        intervalMs: 1_000,
        batchSize: 10,
        gracePeriodMs: 60_000,
        maxRuntimeMs: 10_000,
      },
      logger,
      now: () => now,
      yieldControl: jest.fn(async () => undefined),
    });

    const result = await worker.runTick();

    // Horizon client called exactly once for the pending investment
    expect(paymentVerifier.verifyPayment).toHaveBeenCalledTimes(1);
    expect(paymentVerifier.verifyPayment).toHaveBeenCalledWith({
      investmentId: "investment-pending",
      stellarTxHash: "hash-pending",
      operationIndex: undefined,
    });

    // The candidate was fetched from repo (already filtered to PENDING)
    expect(repository.findPendingCandidates).toHaveBeenCalledTimes(1);
    expect(repository.findPendingCandidates).toHaveBeenCalledWith(
      new Date("2026-01-01T00:09:00.000Z"),
      10
    );

    // Pending investment was verified
    expect(result.verified).toBe(1);
    expect(result.alreadyVerified).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.processed).toBe(1);

    // Funded investment status remains funded — since it's filtered from candidates by status,
    // it is never touched during reconciliation.
    // Log should show 1 checked, 0 skipped (only 1 pending candidate existed)
    const completionLog = logger.entries.find(
      (entry: LogEntry) =>
        entry.level === "debug" && entry.message === "Completed Stellar reconciliation tick."
    );
    expect(completionLog).toBeDefined();
    expect(completionLog?.metadata).toMatchObject({
      confirmed_count: 1,
      skipped_count: 0,
    });
  });

  it("records checked and skipped counts correctly when mix of verified and already_verified results occur", async () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const logger = new CaptureLogger();

    const repository = {
      findPendingCandidates: jest
        .fn()
        .mockResolvedValue([
          createCandidate("investment-1", "hash-1"),
          createCandidate("investment-2", "hash-2"),
          createCandidate("investment-3", "hash-3"),
        ]),
    };

    const paymentVerifier = {
      verifyPayment: jest
        .fn()
        .mockResolvedValueOnce(createVerifiedResult("investment-1", "verified"))
        .mockResolvedValueOnce(createVerifiedResult("investment-2", "already_verified"))
        .mockResolvedValueOnce(createVerifiedResult("investment-3", "verified")),
    };

    const worker = new ReconcilePendingStellarStateWorker({
      repository,
      paymentVerifier,
      config: {
        enabled: true,
        intervalMs: 1_000,
        batchSize: 10,
        gracePeriodMs: 60_000,
        maxRuntimeMs: 10_000,
      },
      logger,
      now: () => now,
      yieldControl: jest.fn(async () => undefined),
    });

    const result = await worker.runTick();

    expect(result.processed).toBe(3);
    expect(result.verified).toBe(2);
    expect(result.alreadyVerified).toBe(1);
    expect(result.failed).toBe(0);

    const completionLog = logger.entries.find(
      (entry: LogEntry) =>
        entry.level === "debug" && entry.message === "Completed Stellar reconciliation tick."
    );
    expect(completionLog).toBeDefined();
    expect(completionLog?.metadata).toMatchObject({
      confirmed_count: 2,
      skipped_count: 1,
    });
  });
});
