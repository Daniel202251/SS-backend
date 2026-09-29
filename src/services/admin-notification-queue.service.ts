import { EventEmitter } from "events";
import { logger } from "../observability/logger";

export interface InvoiceSubmittedEventPayload {
  invoiceId: string;
  sellerId?: string;
  sellerWallet: string;
  title: string;
  description: string;
  faceValue: number | string;
  fundingTarget: number | string;
  yieldBps: number;
  fundingDeadline: Date | string;
  ipfsDocumentUrl: string;
  submittedAt: Date;
}

export interface CurveMigrationExecutedEventPayload {
  migrationId: string;
  keyId: string;
  contractAddress: string;
  status: string;
  timelockExpiry: string | null;
  appliedParams: Record<string, unknown> | null;
  executedAt: string | null;
}

export interface AdminNotificationQueueEvents {
  invoice_submitted: InvoiceSubmittedEventPayload;
  curve_migration_executed: CurveMigrationExecutedEventPayload;
  [key: string]: unknown;
}

export interface QueuedEvent<T = unknown> {
  event: string;
  type?: string;
  payload: T;
  timestamp: Date;
}

export class AdminNotificationQueue extends EventEmitter {
  private queue: QueuedEvent[] = [];

  async emitEvent<K extends keyof AdminNotificationQueueEvents>(
    event: K,
    payload: AdminNotificationQueueEvents[K]
  ): Promise<void> {
    const item: QueuedEvent<AdminNotificationQueueEvents[K]> = {
      event: event as string,
      type: event as string,
      payload,
      timestamp: new Date(),
    };
    this.queue.push(item);
    logger.info(`Admin notification queue received event: ${String(event)}`, {
      event,
      payload,
    });
    this.emit(event as string, payload);
  }

  // Also support standard event emitter emit
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (typeof event === "string" && !this.queue.some((q) => q.payload === args[0])) {
      this.queue.push({
        event,
        type: event,
        payload: args[0],
        timestamp: new Date(),
      });
    }
    return super.emit(event, ...args);
  }

  getEvents<K extends keyof AdminNotificationQueueEvents>(
    eventName: K
  ): QueuedEvent<AdminNotificationQueueEvents[K]>[];
  getEvents<T = Record<string, unknown>>(eventName?: string): QueuedEvent<T>[];
  getEvents(eventName?: string): QueuedEvent<unknown>[] {
    if (eventName) {
      return this.queue.filter((item) => item.event === eventName);
    }
    return [...this.queue];
  }

  clear(): void {
    this.queue = [];
  }
}

export const adminNotificationQueue = new AdminNotificationQueue();
