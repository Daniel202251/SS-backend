import "reflect-metadata";
import request from "supertest";
import jwt from "jsonwebtoken";
import { DataSource, getMetadataArgsStorage } from "typeorm";

import { createApp } from "../../src/app";
import { OnboardingProgress } from "../../src/models/OnboardingProgress.model";
import { AuthChallenge } from "../../src/models/AuthChallenge.model";
import { Investment } from "../../src/models/Investment.model";
import { Invoice } from "../../src/models/Invoice.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { Notification } from "../../src/models/Notification.model";
import { Transaction } from "../../src/models/Transaction.model";
import { User } from "../../src/models/User.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { SecondaryMarketListing } from "../../src/models/SecondaryMarketListing.model";
import { SecondaryMarketPurchase } from "../../src/models/SecondaryMarketPurchase.model";
import { Watchlist } from "../../src/models/Watchlist.model";
import { createAuthService } from "../../src/services/auth.service";
import { createOnboardingService } from "../../src/services/onboarding.service";
import { KYCStatus, UserType } from "../../src/types/enums";
import type { AppConfig } from "../../src/config/env";

const JWT_SECRET = "test-jwt-secret-key-32-chars-minimum-length";

const WALLET = "GWALLETA0000000000000000000000000000000000000000000000000000AA";
const OTHER_WALLET = "GWALLETB00000000000000000000000000000000000000000000000000000AA";

function patchEntityMetadataForSQLite(): void {
  for (const column of getMetadataArgsStorage().columns) {
    if (column.options.type === "timestamptz") column.options.type = "datetime" as never;
    if (column.options.type === "jsonb") column.options.type = "text" as never;
    if (column.options.type === "enum") column.options.type = "varchar" as never;
  }
}

describe("Integration: Onboarding tour completion (issue #540)", () => {
  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    patchEntityMetadataForSQLite();

    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [
        User,
        Invoice,
        Investment,
        AuthChallenge,
        Transaction,
        KYCVerification,
        Notification,
        OnboardingProgress,
        KycHistory,
        SecondaryListing,
        SecondaryMarketListing,
        SecondaryMarketPurchase,
        Watchlist,
      ],
      synchronize: true,
      dropSchema: true,
    });
    await dataSource.initialize();

    const config = {
      jwt: { secret: JWT_SECRET, expiresIn: "1h" },
      auth: { challengeTtlMs: 300_000 },
      stellar: { network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" },
    } as unknown as AppConfig;

    app = createApp({
      authService: createAuthService(dataSource, config),
      onboardingService: createOnboardingService(dataSource),
      metricsEnabled: false,
    });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  async function seedUser(wallet: string, userType: UserType): Promise<User> {
    const repo = dataSource.getRepository(User);
    return repo.save(
      repo.create({
        stellarAddress: wallet,
        userType,
        kycStatus: KYCStatus.APPROVED,
        isKycVerified: true,
      })
    );
  }

  function tokenFor(user: User): string {
    return jwt.sign(
      {
        sub: user.stellarAddress,
        stellarAddress: user.stellarAddress,
        wallet: user.stellarAddress,
        role: user.userType,
        userType: user.userType,
        userId: user.id,
      },
      JWT_SECRET,
      { expiresIn: "1h" }
    );
  }

  it("rejects unauthenticated status and completion requests", async () => {
    const status = await request(app).get("/api/v1/onboarding/status");
    expect(status.status).toBe(401);
    expect(status.body.success).toBe(false);

    const complete = await request(app).post("/api/v1/onboarding/complete");
    expect(complete.status).toBe(401);
    expect(complete.body.success).toBe(false);
  });

  it("reports the tour as incomplete for a wallet that has never finished it", async () => {
    const user = await seedUser(WALLET, UserType.SELLER);

    const res = await request(app)
      .get("/api/v1/onboarding/status")
      .set("Authorization", `Bearer ${tokenFor(user)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tourCompleted).toBe(false);
    expect(res.body.data.completedAt).toBeNull();
  });

  it("stores completion with a timestamp and returns it on the next read", async () => {
    const user = await seedUser(OTHER_WALLET, UserType.INVESTOR);

    const posted = await request(app)
      .post("/api/v1/onboarding/complete")
      .set("Authorization", `Bearer ${tokenFor(user)}`);

    expect(posted.status).toBe(200);
    expect(posted.body.data.tourCompleted).toBe(true);
    expect(posted.body.data.completedAt).not.toBeNull();
    const completedAt = posted.body.data.completedAt as string;
    expect(Number.isNaN(new Date(completedAt).getTime())).toBe(false);

    const fetched = await request(app)
      .get("/api/v1/onboarding/status")
      .set("Authorization", `Bearer ${tokenFor(user)}`);

    expect(fetched.status).toBe(200);
    expect(fetched.body.data.tourCompleted).toBe(true);
    expect(fetched.body.data.completedAt).toBe(completedAt);
  });

  it("keeps completion state per wallet and preserves the first timestamp", async () => {
    const first = await seedUser("GWALLETC0000000000000000000000000000000000000000000000000000AA", UserType.BOTH);
    const second = await seedUser("GWALLETD0000000000000000000000000000000000000000000000000000AA", UserType.BOTH);

    const firstComplete = await request(app)
      .post("/api/v1/onboarding/complete")
      .set("Authorization", `Bearer ${tokenFor(first)}`);
    expect(firstComplete.status).toBe(200);
    const firstTimestamp = firstComplete.body.data.completedAt as string;

    const otherStatus = await request(app)
      .get("/api/v1/onboarding/status")
      .set("Authorization", `Bearer ${tokenFor(second)}`);
    expect(otherStatus.body.data.tourCompleted).toBe(false);

    // Re-completing is idempotent and must not move the original timestamp.
    const repeat = await request(app)
      .post("/api/v1/onboarding/complete")
      .set("Authorization", `Bearer ${tokenFor(first)}`);
    expect(repeat.status).toBe(200);
    expect(repeat.body.data.completedAt).toBe(firstTimestamp);

    const rows = await dataSource
      .getRepository(OnboardingProgress)
      .find({ where: { walletAddress: first.stellarAddress } });
    expect(rows).toHaveLength(1);

    const otherRows = await dataSource
      .getRepository(OnboardingProgress)
      .find({ where: { walletAddress: second.stellarAddress } });
    expect(otherRows).toHaveLength(0);
  });

  it("answers a status check well inside 100ms", async () => {
    const user = await seedUser("GWALLETE0000000000000000000000000000000000000000000000000000AA", UserType.SELLER);

    const started = Date.now();
    const res = await request(app)
      .get("/api/v1/onboarding/status")
      .set("Authorization", `Bearer ${tokenFor(user)}`);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(100);
  });
});
