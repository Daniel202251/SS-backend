import { logger as defaultLogger, type AppLogger } from "../observability/logger";
import { InvoiceStatus, NotificationType } from "../types/enums";
import type { Invoice } from "../models/Invoice.model";
import type { InvestorDirectory } from "./invoice-notifications";
import type { InvoiceTransition, TransitionEffect } from "./invoice-state-machine";

/**
 * Queue-based batch notification dispatcher for invoice lifecycle events.
 *
 * Callers enqueue an event and return immediately; recipients are resolved
 * and notifications written in the background, so fan-out to many investors
 * never blocks the request that caused the event. Every notification carries
 * a dedupe key of `<eventId>:<userId>`, which the store enforces as unique,
 * so a re-dispatched event or a retried job cannot notify a wallet twice.
 * A job that keeps failing is retried up to {@link DEFAULT_MAX_ATTEMPTS}
 * times in total and then dead-lettered.
 */

export type InvoiceLifecycleEventKind =
  | "funded"
  | "settled"
  | "rejected"
  | "approved"
  | "deadline_extended"
  | "matured";

export type InvoiceEventSubject = Pick<Invoice, "id" | "sellerId" | "invoiceNumber">;

export interface InvoiceLifecycleEvent {
  kind: InvoiceLifecycleEventKind;
  invoice: InvoiceEventSubject;
  /** Rejection reason, or other free text shown in the message. */
  reason?: string | null;
  /** New deadline, for `deadline_extended`. */
  newDeadline?: Date;
  /**
   * Identifies the event for deduplication. Defaults to one id per
   * (kind, invoice), plus the new deadline for extensions, since those can
   * legitimately happen more than once.
   */
  eventId?: string;
}

export interface DedupedNotification {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  dedupeKey: string;
}

/** Writes notifications, skipping any whose dedupe key already exists. */
export interface DedupedNotificationStore {
  insertIgnoringDuplicates(entries: DedupedNotification[]): Promise<void>;
}

export interface DeadLetter {
  eventId: string;
  event: InvoiceLifecycleEvent;
  attempts: number;
  error: string;
  failedAt: Date;
}

export interface DeadLetterSink {
  record(entry: DeadLetter): void | Promise<void>;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_CONCURRENCY = 4;

type Audience = "seller" | "investors";

interface EventTemplate {
  type: NotificationType;
  audience: readonly Audience[];
  title: string;
  message: (event: InvoiceLifecycleEvent) => string;
}

const TEMPLATES: Record<InvoiceLifecycleEventKind, EventTemplate> = {
  funded: {
    type: NotificationType.INVOICE_FUNDED,
    audience: ["seller", "investors"],
    title: "Invoice Funded",
    message: ({ invoice }) => `Invoice ${invoice.invoiceNumber} has been fully funded.`,
  },
  settled: {
    type: NotificationType.INVOICE_SETTLED,
    audience: ["seller", "investors"],
    title: "Invoice Settled",
    message: ({ invoice }) =>
      `Invoice ${invoice.invoiceNumber} has settled and returns have been distributed.`,
  },
  rejected: {
    type: NotificationType.INVOICE_REJECTED,
    audience: ["seller"],
    title: "Invoice Rejected",
    message: ({ invoice, reason }) =>
      `Your invoice ${invoice.invoiceNumber} has been rejected: ${reason ?? "no reason given"}`,
  },
  approved: {
    type: NotificationType.INVOICE_APPROVED,
    audience: ["seller"],
    title: "Invoice Approved",
    message: ({ invoice }) =>
      `Your invoice ${invoice.invoiceNumber} has been approved and is now live on the marketplace.`,
  },
  deadline_extended: {
    type: NotificationType.INVOICE_DEADLINE_EXTENDED,
    audience: ["seller", "investors"],
    title: "Invoice Deadline Extended",
    message: ({ invoice, newDeadline }) =>
      `The deadline for invoice ${invoice.invoiceNumber} has been extended` +
      (newDeadline ? ` to ${newDeadline.toISOString().slice(0, 10)}.` : "."),
  },
  matured: {
    type: NotificationType.INVOICE_MATURED,
    audience: ["seller", "investors"],
    title: "Invoice Matured",
    message: ({ invoice }) => `Invoice ${invoice.invoiceNumber} has reached its maturity date.`,
  },
};

export function eventIdFor(event: InvoiceLifecycleEvent): string {
  if (event.eventId) return event.eventId;
  const base = `invoice:${event.invoice.id}:${event.kind}`;
  return event.kind === "deadline_extended" && event.newDeadline
    ? `${base}:${event.newDeadline.toISOString()}`
    : base;
}

/** Maps a committed status transition onto the lifecycle event it represents, if any. */
export function lifecycleEventForTransition(
  transition: InvoiceTransition
): InvoiceLifecycleEvent | null {
  const kind = ((): InvoiceLifecycleEventKind | null => {
    switch (transition.to) {
      case InvoiceStatus.FUNDED:
        return "funded";
      case InvoiceStatus.SETTLED:
        return "settled";
      case InvoiceStatus.REJECTED:
        return "rejected";
      case InvoiceStatus.PUBLISHED:
        return transition.trigger === "admin_approved" ? "approved" : null;
      default:
        return null;
    }
  })();

  return kind ? { kind, invoice: transition.invoice, reason: transition.reason } : null;
}

export interface NotificationDispatcherOptions {
  store: DedupedNotificationStore;
  investors: InvestorDirectory;
  deadLetters?: DeadLetterSink;
  logger?: AppLogger;
  maxAttempts?: number;
  /** Delay before retry n is `retryDelayMs * 2^(n-1)`. */
  retryDelayMs?: number;
  concurrency?: number;
  /** Test hook for scheduling; defaults to setTimeout. */
  schedule?: (work: () => void, delayMs: number) => void;
}

interface Job {
  eventId: string;
  event: InvoiceLifecycleEvent;
  attempts: number;
}

export class NotificationDispatcher {
  private readonly queue: Job[] = [];
  /** Event ids queued, running or awaiting retry; enqueueing one again is a no-op. */
  private readonly pending = new Set<string>();
  private active = 0;
  private readonly idleWaiters: Array<() => void> = [];
  private scheduledRetries = 0;

  private readonly log: AppLogger;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly concurrency: number;
  private readonly schedule: (work: () => void, delayMs: number) => void;

  constructor(private readonly options: NotificationDispatcherOptions) {
    this.log = options.logger ?? defaultLogger;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.schedule =
      options.schedule ??
      ((work, delayMs) => {
        setTimeout(work, delayMs).unref?.();
      });
  }

  /** Queues an event and returns immediately. Returns false if it was already pending. */
  enqueue(event: InvoiceLifecycleEvent): boolean {
    const eventId = eventIdFor(event);
    if (this.pending.has(eventId)) {
      return false;
    }
    this.pending.add(eventId);
    this.queue.push({ eventId, event, attempts: 0 });
    // Defer so enqueue never runs dispatch work on the caller's stack.
    setImmediate(() => this.pump());
    return true;
  }

  get size(): number {
    return this.queue.length + this.active + this.scheduledRetries;
  }

  /** Resolves once every queued job, including pending retries, has finished. */
  drain(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.pump();
        this.notifyIfIdle();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    job.attempts += 1;
    try {
      const count = await this.deliver(job);
      this.pending.delete(job.eventId);
      this.log.info("Dispatched invoice lifecycle notifications.", {
        event_id: job.eventId,
        kind: job.event.kind,
        invoice_id: job.event.invoice.id,
        recipient_count: count,
        attempt: job.attempts,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (job.attempts < this.maxAttempts) {
        const delay = this.retryDelayMs * 2 ** (job.attempts - 1);
        this.log.warn("Notification dispatch failed; retrying.", {
          event_id: job.eventId,
          attempt: job.attempts,
          max_attempts: this.maxAttempts,
          retry_in_ms: delay,
          error: message,
        });
        this.scheduledRetries += 1;
        this.schedule(() => {
          this.scheduledRetries -= 1;
          this.queue.push(job);
          this.pump();
          this.notifyIfIdle();
        }, delay);
        return;
      }

      this.pending.delete(job.eventId);
      const deadLetter: DeadLetter = {
        eventId: job.eventId,
        event: job.event,
        attempts: job.attempts,
        error: message,
        failedAt: new Date(),
      };
      this.log.error("Notification dispatch dead-lettered.", {
        event_id: job.eventId,
        kind: job.event.kind,
        invoice_id: job.event.invoice.id,
        attempts: job.attempts,
        error: message,
      });
      try {
        await this.options.deadLetters?.record(deadLetter);
      } catch (sinkError) {
        this.log.error("Failed to record notification dead letter.", {
          event_id: job.eventId,
          error: sinkError instanceof Error ? sinkError.message : String(sinkError),
        });
      }
    }
  }

  private async deliver({ eventId, event }: Job): Promise<number> {
    const template = TEMPLATES[event.kind];
    const recipients = new Set<string>();
    if (template.audience.includes("seller")) {
      recipients.add(event.invoice.sellerId);
    }
    if (template.audience.includes("investors")) {
      for (const id of await this.options.investors.findInvestorIds(event.invoice.id)) {
        recipients.add(id);
      }
    }

    const message = template.message(event);
    await this.options.store.insertIgnoringDuplicates(
      [...recipients].map((userId) => ({
        userId,
        type: template.type,
        title: template.title,
        message,
        dedupeKey: `${eventId}:${userId}`,
      }))
    );
    return recipients.size;
  }

  private notifyIfIdle(): void {
    if (this.size > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}

/** In-memory dead-letter list; entries are also logged at error level by the dispatcher. */
export class InMemoryDeadLetterSink implements DeadLetterSink {
  readonly entries: DeadLetter[] = [];
  record(entry: DeadLetter): void {
    this.entries.push(entry);
  }
}

/** State machine effect: enqueue the lifecycle event for a committed transition. */
export function createNotificationDispatchEffect(
  dispatcher: Pick<NotificationDispatcher, "enqueue">
): TransitionEffect {
  return function enqueueLifecycleNotifications(transition) {
    const event = lifecycleEventForTransition(transition);
    if (event) dispatcher.enqueue(event);
  };
}

/** True for transitions whose notifications the dispatcher owns. */
export function isDispatchedTransition(transition: InvoiceTransition): boolean {
  return lifecycleEventForTransition(transition) !== null;
}

/** Wraps an effect so it skips transitions the dispatcher already notifies about. */
export function unlessDispatched(effect: TransitionEffect): TransitionEffect {
  return function skipDispatchedTransitions(transition) {
    return isDispatchedTransition(transition) ? undefined : effect(transition);
  };
}
