import {
  InMemoryDeadLetterSink,
  NotificationDispatcher,
  createNotificationDispatchEffect,
  unlessDispatched,
  type DedupedNotification,
  type DedupedNotificationStore,
} from "../../src/lib/notification-dispatcher";
import type { InvoiceTransition } from "../../src/lib/invoice-state-machine";
import type { AppLogger } from "../../src/observability/logger";
import { InvoiceStatus, NotificationType } from "../../src/types/enums";

const silentLogger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const invoice = { id: "inv-1", sellerId: "seller-1", invoiceNumber: "INV-001" };

/** Mirrors the unique dedupe_key index: duplicate keys are silently skipped. */
class FakeStore implements DedupedNotificationStore {
  readonly rows = new Map<string, DedupedNotification>();
  failuresRemaining = 0;
  calls = 0;

  async insertIgnoringDuplicates(entries: DedupedNotification[]): Promise<void> {
    this.calls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("db unavailable");
    }
    for (const entry of entries) {
      if (!this.rows.has(entry.dedupeKey)) this.rows.set(entry.dedupeKey, entry);
    }
  }

  recipients(): string[] {
    return [...this.rows.values()].map((row) => row.userId).sort();
  }
}

function setup(investorIds: string[] = ["investor-1", "investor-2"]) {
  const store = new FakeStore();
  const deadLetters = new InMemoryDeadLetterSink();
  const dispatcher = new NotificationDispatcher({
    store,
    investors: { findInvestorIds: async () => investorIds },
    deadLetters,
    logger: silentLogger,
    retryDelayMs: 0,
    schedule: (work) => setImmediate(work),
  });
  return { store, deadLetters, dispatcher };
}

function transition(to: InvoiceStatus, trigger = "fully_funded", reason: string | null = null) {
  return {
    invoice,
    from: InvoiceStatus.PUBLISHED,
    to,
    actor: { role: "system" },
    trigger,
    reason,
    history: null,
    occurredAt: new Date(),
  } as unknown as InvoiceTransition;
}

describe("NotificationDispatcher", () => {
  it.each(["funded", "settled"] as const)(
    "fans %s out to the seller and every investor",
    async (kind) => {
      const { store, dispatcher } = setup();

      dispatcher.enqueue({ kind, invoice });
      await dispatcher.drain();

      expect(store.recipients()).toEqual(["investor-1", "investor-2", "seller-1"]);
    }
  );

  it("notifies only the seller on review decisions", async () => {
    const { store, dispatcher } = setup();

    dispatcher.enqueue({ kind: "approved", invoice });
    dispatcher.enqueue({ kind: "rejected", invoice, reason: "Missing documents" });
    await dispatcher.drain();

    const rows = [...store.rows.values()];
    expect(rows.map((r) => r.userId)).toEqual(["seller-1", "seller-1"]);
    expect(rows.map((r) => r.type)).toEqual([
      NotificationType.INVOICE_APPROVED,
      NotificationType.INVOICE_REJECTED,
    ]);
    expect(rows[1].message).toContain("Missing documents");
  });

  it("returns before any dispatch work runs", () => {
    const { store, dispatcher } = setup();

    expect(dispatcher.enqueue({ kind: "funded", invoice })).toBe(true);

    expect(store.calls).toBe(0);
    expect(dispatcher.size).toBe(1);
  });

  it("does not duplicate notifications for the same event and wallet", async () => {
    const { store, dispatcher } = setup(["investor-1", "investor-1"]);

    expect(dispatcher.enqueue({ kind: "funded", invoice })).toBe(true);
    expect(dispatcher.enqueue({ kind: "funded", invoice })).toBe(false);
    await dispatcher.drain();
    // A later re-dispatch of the same event is absorbed by the dedupe key.
    dispatcher.enqueue({ kind: "funded", invoice });
    await dispatcher.drain();

    expect(store.recipients()).toEqual(["investor-1", "seller-1"]);
  });

  it("treats separate deadline extensions as separate events", async () => {
    const { store, dispatcher } = setup([]);

    dispatcher.enqueue({ kind: "deadline_extended", invoice, newDeadline: new Date("2026-10-01") });
    dispatcher.enqueue({ kind: "deadline_extended", invoice, newDeadline: new Date("2026-11-01") });
    await dispatcher.drain();

    expect(store.rows.size).toBe(2);
  });

  it("retries a failed dispatch and succeeds within 3 attempts", async () => {
    const { store, deadLetters, dispatcher } = setup();
    store.failuresRemaining = 2;

    dispatcher.enqueue({ kind: "settled", invoice });
    await dispatcher.drain();

    expect(store.calls).toBe(3);
    expect(store.rows.size).toBe(3);
    expect(deadLetters.entries).toHaveLength(0);
  });

  it("dead-letters after 3 failed attempts", async () => {
    const { store, deadLetters, dispatcher } = setup();
    store.failuresRemaining = Infinity;

    dispatcher.enqueue({ kind: "settled", invoice });
    await dispatcher.drain();

    expect(store.calls).toBe(3);
    expect(deadLetters.entries).toEqual([
      expect.objectContaining({
        eventId: "invoice:inv-1:settled",
        attempts: 3,
        error: "db unavailable",
      }),
    ]);
  });
});

describe("state machine integration", () => {
  it("enqueues events for funded, settled, rejected and admin-approved transitions only", () => {
    const enqueue = jest.fn();
    const effect = createNotificationDispatchEffect({ enqueue });

    void effect(transition(InvoiceStatus.FUNDED));
    void effect(transition(InvoiceStatus.SETTLED, "admin_settled"));
    void effect(transition(InvoiceStatus.REJECTED, "admin_rejected", "Bad docs"));
    void effect(transition(InvoiceStatus.PUBLISHED, "admin_approved"));
    void effect(transition(InvoiceStatus.PUBLISHED, "seller_published"));
    void effect(transition(InvoiceStatus.CANCELLED, "admin_cancelled"));

    expect(enqueue.mock.calls.map(([event]) => event.kind)).toEqual([
      "funded",
      "settled",
      "rejected",
      "approved",
    ]);
    expect(enqueue.mock.calls[2][0].reason).toBe("Bad docs");
  });

  it("keeps the seller effect for transitions the dispatcher does not own", async () => {
    const seller = jest.fn();
    const effect = unlessDispatched(seller);

    await effect(transition(InvoiceStatus.FUNDED));
    await effect(transition(InvoiceStatus.CANCELLED, "admin_cancelled"));

    expect(seller).toHaveBeenCalledTimes(1);
    expect(seller.mock.calls[0][0].to).toBe(InvoiceStatus.CANCELLED);
  });
});
