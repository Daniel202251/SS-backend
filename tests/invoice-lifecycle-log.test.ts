import { logInvoiceTransition } from "../src/lib/invoice-lifecycle-log";
import { InvoiceStatus } from "../src/types/enums";
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

describe("logInvoiceTransition", () => {
  it("emits an info log with all six fields, truncating the actor wallet", () => {
    const logger = createMockLogger();

    logInvoiceTransition(logger, {
      invoiceId: "invoice-123",
      fromState: InvoiceStatus.PUBLISHED,
      toState: InvoiceStatus.FUNDED,
      actorWallet: "GABCDEFGHIJKLMNOPQRSTUVWXYZ",
      reason: "fully_funded",
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "Invoice lifecycle state transition.",
      expect.objectContaining({
        invoice_id: "invoice-123",
        from_state: InvoiceStatus.PUBLISHED,
        to_state: InvoiceStatus.FUNDED,
        actor_wallet: "GABC...WXYZ",
        reason: "fully_funded",
        transitioned_at: expect.any(String),
      })
    );
  });

  it("uses a machine-readable reason string, not free text", () => {
    const logger = createMockLogger();

    logInvoiceTransition(logger, {
      invoiceId: "invoice-456",
      fromState: InvoiceStatus.DRAFT,
      toState: InvoiceStatus.PUBLISHED,
      actorWallet: "GSELLER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      reason: "seller_published",
    });

    const metadata = logger.info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(metadata.reason).toMatch(/^[a-z_]+$/);
  });
});
