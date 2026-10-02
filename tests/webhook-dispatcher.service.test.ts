import {
  WebhookDispatcherService,
  generateWebhookSignature,
} from "../src/services/webhook-dispatcher.service";
import { WebhookSubscription } from "../src/models/WebhookSubscription.model";
import { WebhookDeliveryLog } from "../src/models/WebhookDeliveryLog.model";

describe("WebhookDispatcherService", () => {
  const subscription = {
    id: "sub-1",
    url: "https://example.test/hook",
    secret: "secret",
    eventTypes: ["invoice.published"],
    active: true,
  } as WebhookSubscription;
  const log = { save: jest.fn().mockResolvedValue(undefined) };
  const dataSource = {
    getRepository: jest.fn((entity) =>
      entity === WebhookSubscription ? { find: jest.fn().mockResolvedValue([subscription]) } : log
    ),
  };

  afterEach(() => jest.restoreAllMocks());

  it("generates a deterministic HMAC signature", () =>
    expect(generateWebhookSignature("payload", "secret")).toBe(
      "b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4"
    ));

  it("posts signed event payloads and records delivery", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 202 }) as any;
    const result = await new WebhookDispatcherService(dataSource as any).dispatchWebhookEvent(
      "invoice.published",
      { id: "invoice-1" }
    );
    expect(result[0]).toMatchObject({ delivered: true, attempts: 1, responseStatus: 202 });
    expect(global.fetch).toHaveBeenCalledWith(
      subscription.url,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-signature": expect.any(String) }),
      })
    );
    expect(log.save).toHaveBeenCalledWith(expect.objectContaining({ delivered: true }));
  });

  it("retries failed responses three times", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 500 }) as any;
    const result = await new WebhookDispatcherService(dataSource as any).dispatchWebhookEvent(
      "invoice.published",
      {}
    );
    expect(result[0]).toMatchObject({ delivered: false, attempts: 3, responseStatus: 500 });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});
