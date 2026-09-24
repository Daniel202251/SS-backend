import crypto from "crypto";
import { DataSource } from "typeorm";
import { WebhookSubscription } from "../models/WebhookSubscription.model";
import { WebhookDeliveryLog } from "../models/WebhookDeliveryLog.model";
import { logger, type AppLogger } from "../observability/logger";
import { withCorrelationHeaders } from "../observability/request-context";

export function generateWebhookSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export interface WebhookDispatchResult {
  subscriptionId: string;
  delivered: boolean;
  attempts: number;
  responseStatus: number | null;
  /**
   * `true` when the event was already delivered for this subscription and was
   * therefore skipped. A duplicate response lets callers/logs identify the
   * event as already handled instead of re-triggering downstream side effects.
   */
  duplicate?: boolean;
}

export class WebhookDispatcherService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly appLogger: AppLogger = logger
  ) {}

  async dispatchWebhookEvent(
    eventType: string,
    payload: unknown,
    eventId?: string
  ): Promise<WebhookDispatchResult[]> {
    const subscriptions = await this.dataSource
      .getRepository(WebhookSubscription)
      .find({ where: { active: true } });
    const body = JSON.stringify({ eventType, payload });
    const eligible = subscriptions.filter((subscription) =>
      subscription.eventTypes.includes(eventType)
    );
    return Promise.all(
      eligible.map((subscription) => this.deliver(subscription, eventType, body, eventId))
    );
  }

  private async deliver(
    subscription: WebhookSubscription,
    eventType: string,
    body: string,
    eventId?: string
  ): Promise<WebhookDispatchResult> {
    // Idempotency: a duplicate event (same subscription + eventId) that has
    // already been delivered successfully must not be re-delivered, otherwise
    // the receiving system sees the same downstream notification/state
    // transition twice.
    if (eventId && (await this.alreadyDelivered(subscription.id, eventId))) {
      this.appLogger.info("webhook.event.already_handled", {
        subscription_id: subscription.id,
        event_type: eventType,
        event_id: eventId,
      });
      return {
        subscriptionId: subscription.id,
        delivered: false,
        attempts: 0,
        responseStatus: null,
        duplicate: true,
      };
    }

    let lastStatus: number | null = null;
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(subscription.url, {
          method: "POST",
          headers: withCorrelationHeaders({
            "content-type": "application/json",
            "x-signature": generateWebhookSignature(body, subscription.secret),
            ...(eventId ? { "x-event-id": eventId } : {}),
          }),
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        lastStatus = response.status;
        const delivered = response.status >= 200 && response.status < 300;
        await this.logDelivery(
          subscription.id,
          eventType,
          eventId,
          attempt,
          response.status,
          delivered,
          delivered ? null : `HTTP ${response.status}`
        );
        if (delivered) {
          return {
            subscriptionId: subscription.id,
            delivered: true,
            attempts: attempt,
            responseStatus: response.status,
            duplicate: false,
          };
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Webhook request failed";
        await this.logDelivery(
          subscription.id,
          eventType,
          eventId,
          attempt,
          lastStatus,
          false,
          lastError
        );
      }
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
      }
    }
    this.appLogger.warn("webhook.delivery.failed", {
      subscription_id: subscription.id,
      event_type: eventType,
      event_id: eventId ?? null,
      status: lastStatus,
      error: lastError,
    });
    return {
      subscriptionId: subscription.id,
      delivered: false,
      attempts: 3,
      responseStatus: lastStatus,
      duplicate: false,
    };
  }

  private async alreadyDelivered(subscriptionId: string, eventId: string): Promise<boolean> {
    const existing = await this.dataSource
      .getRepository(WebhookDeliveryLog)
      .findOne({ where: { subscriptionId, eventId, delivered: true } });
    return existing !== null;
  }

  private async logDelivery(
    subscriptionId: string,
    eventType: string,
    eventId: string | undefined,
    attempt: number,
    responseStatus: number | null,
    delivered: boolean,
    errorMessage: string | null
  ): Promise<void> {
    await this.dataSource.getRepository(WebhookDeliveryLog).save({
      subscriptionId,
      eventType,
      eventId: eventId ?? null,
      attempt,
      responseStatus,
      delivered,
      errorMessage,
    });
    this.appLogger.info("webhook.delivery.attempt", {
      subscription_id: subscriptionId,
      event_type: eventType,
      event_id: eventId ?? null,
      attempt,
      response_status: responseStatus,
      delivered,
    });
  }
}

export function createWebhookDispatcherService(
  dataSource: DataSource,
  appLogger?: AppLogger
): WebhookDispatcherService {
  return new WebhookDispatcherService(dataSource, appLogger);
}
