import { logSettlementCompletion } from "../src/lib/settlement-completion-log";
import type { AppLogger } from "../src/observability/logger";

function createMockLogger(): jest.Mocked<AppLogger> {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  } as unknown as jest.Mocked<AppLogger>;
}

describe("logSettlementCompletion", () => {
  it("emits an info log with all four required fields, formatting proceeds in XLM via stroopsToXlm", () => {
    const logger = createMockLogger();

    logSettlementCompletion(logger, {
      invoiceId: "invoice-123",
      totalProceedsStroops: 12_345_000_0000n, // 12,345 XLM
      investorCount: 3,
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "Settlement flow completed.",
      expect.objectContaining({
        invoice_id: "invoice-123",
        total_proceeds: "12345.0000000",
        investor_count: 3,
        settled_at: expect.any(String),
      })
    );
  });

  it("formats fractional stroop amounts to full XLM precision", () => {
    const logger = createMockLogger();

    logSettlementCompletion(logger, {
      invoiceId: "invoice-456",
      totalProceedsStroops: 1n, // smallest possible unit
      investorCount: 1,
    });

    const metadata = logger.info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(metadata.total_proceeds).toBe("0.0000001");
  });

  it("settled_at is a valid ISO timestamp", () => {
    const logger = createMockLogger();

    logSettlementCompletion(logger, {
      invoiceId: "invoice-789",
      totalProceedsStroops: 10_000_000n,
      investorCount: 2,
    });

    const metadata = logger.info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(new Date(metadata.settled_at as string).toISOString()).toBe(metadata.settled_at);
  });
});
