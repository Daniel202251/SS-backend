import crypto from "crypto";
import { createKycController } from "../src/controllers/kyc.controller";
import { KYCStatus } from "../src/types/enums";

function response() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.send = jest.fn(() => res);
  return res;
}

describe("KYC webhook controller", () => {
  it("rejects an invalid provider signature", async () => {
    const service = {
      verifyWebhookSignature: jest.fn().mockReturnValue(false),
      processWebhook: jest.fn(),
    };
    const controller = createKycController(service as any);
    const res = response();
    await controller.webhook({ body: Buffer.from("{}"), header: () => "bad" } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(service.processWebhook).not.toHaveBeenCalled();
  });

  it("processes a signed raw webhook payload", async () => {
    const payload = { userId: "user-1", status: KYCStatus.APPROVED };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const secret = "secret";
    const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const service = {
      verifyWebhookSignature: jest.fn().mockReturnValue(true),
      processWebhook: jest.fn().mockResolvedValue(undefined),
    };
    const controller = createKycController(service as any);
    const res = response();
    await controller.webhook({ body: rawBody, header: () => signature } as any, res);
    expect(service.processWebhook).toHaveBeenCalledWith(payload);
    expect(res.status).toHaveBeenCalledWith(204);
  });
});
