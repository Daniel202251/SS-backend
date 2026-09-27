import type { Server } from "http";

import { createApp } from "./app";

import dataSource from "./config/database";
import { getConfig } from "./config/env";
import { logger } from "./observability/logger";
import { MetricsRegistry } from "./observability/metrics";

import { createAuthService } from "./services/auth.service";
import { createNotificationService } from "./services/notification.service";
import { InvoiceService } from "./services/invoice.service";
import { createInvoiceStateMachine } from "./lib/invoice-state-machine";
import {
  createInvestmentNotifier,
  createInvestorDirectory,
  createInvestorNotificationEffect,
} from "./lib/invoice-notifications";
import { Invoice } from "./models/Invoice.model";
import { createIPFSService } from "./services/ipfs.service";
import { createInvestmentService } from "./services/investment.service";
import { createSettlementService } from "./services/settlement.service";
import { createMarketplaceService } from "./services/marketplace.service";
import { KycService } from "./services/kyc.service";
import { createInvestorAcknowledgementService } from "./services/investor-acknowledgement.service";
import { createInvoiceExtensionService } from "./services/invoice-extension.service";
import { createAdminMetricsService } from "./services/admin-metrics.service";
import { createPortfolioService } from "./services/portfolio.service";
import { PaymentDistributorContractService } from "./services/stellar/payment-distributor-contract.service";
import { createOnchainProjections } from "./services/onchain-projections.service";
import { getSorobanConfig } from "./config/stellar";
import { createRatingsLeaderboardService } from "./services/ratings-leaderboard.service";
import { createDividendCycleService } from "./services/dividend-cycle.service";
import { createOnboardingService } from "./services/onboarding.service";
import { createSubscriptionStatusService } from "./services/subscription-status.service";
import { createSorobanSubscriptionReader } from "./services/stellar/soroban-subscription-reader";
import { scheduleAnalyticsSnapshotJob } from "./workers/analytics-snapshot.worker";

export async function bootstrap(): Promise<{ server: Server }> {
  const config = getConfig();

  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }

  const metricsRegistry = new MetricsRegistry();

  const authService = createAuthService(dataSource, config, logger, metricsRegistry);
  const notificationService = createNotificationService(dataSource);
  const ipfsService = createIPFSService(config.ipfs, logger);
  // One state machine shared by every service that changes invoice status,
  // so transitions are validated, recorded and notified the same way.
  const invoiceStateMachine = createInvoiceStateMachine({
    notificationSink: notificationService,
    effects: [
      createInvestorNotificationEffect(notificationService, createInvestorDirectory(dataSource)),
    ],
  });
  const invoiceService = new InvoiceService({
    invoiceRepository: dataSource.getRepository(Invoice),
    ipfsService,
    dataSource,
    stateMachine: invoiceStateMachine,
  });
  const investmentService = createInvestmentService(
    dataSource,
    invoiceStateMachine,
    createInvestmentNotifier(notificationService, logger)
  );
  const sorobanConfig = getSorobanConfig();
  const distributor =
    sorobanConfig.paymentDistributorContractId && sorobanConfig.platformSecretKey
      ? new PaymentDistributorContractService(
          { ...sorobanConfig, contractId: sorobanConfig.paymentDistributorContractId },
          logger
        )
      : undefined;
  const distributorConfig =
    distributor && sorobanConfig.platformFeeRecipient
      ? { feeRecipient: sorobanConfig.platformFeeRecipient, feeBps: sorobanConfig.platformFeeBps }
      : undefined;
  const settlementService = createSettlementService(
    dataSource,
    distributor,
    distributorConfig,
    invoiceStateMachine
  );
  const marketplaceService = createMarketplaceService(dataSource);
  const kycService = new KycService(dataSource, config.kyc.webhookSecret ?? "", logger);
  const acknowledgementService = createInvestorAcknowledgementService(dataSource);
  const extensionService = createInvoiceExtensionService(dataSource, notificationService);
  const adminMetricsService = createAdminMetricsService(dataSource);
  const portfolioService = createPortfolioService(dataSource);

  // Keep process.env.TERMS_VERSION aligned with resolved config for services
  // that read the env directly (acknowledgement gate in InvestmentService).
  if (!process.env.TERMS_VERSION) {
    process.env.TERMS_VERSION = config.termsVersion;
  }

  // ---- Feature: Ratings Leaderboard ----
  const ratingsLeaderboardService = createRatingsLeaderboardService(dataSource, {
    redisUrl: config.cache.redisUrl,
  });

  // ---- Feature: Dividend Cycle Config ----
  const dividendCycleService = createDividendCycleService(dataSource);

  // ---- Feature: Onboarding Tour Completion ----
  const onboardingService = createOnboardingService(dataSource);

  // Read models projected from Soroban contract events: creator key buy
  // limits, the integration ACL, curve migrations, atomic swap history, creator
  // royalty earnings and holder dividend cycles.
  const projections = createOnchainProjections({ dataSource, logger });

  // ---- Feature: Gated-content subscription status ----
  // Only wired up when a gated-content contract and an RPC endpoint are both
  // configured; otherwise the endpoint is not mounted rather than reporting a
  // status nobody can verify.
  const subscriptionStatusService =
    config.sorobanEscrow.contractId && config.sorobanEscrow.rpcUrl
      ? createSubscriptionStatusService({
          holdingReader: createSorobanSubscriptionReader({
            contractId: config.sorobanEscrow.contractId,
            rpcUrl: config.sorobanEscrow.rpcUrl,
            logger,
          }),
          logger,
        })
      : undefined;

  // The subscription cache must not outlive a holding change, so the service
  // joins the same event bus that projects the contract events.
  if (subscriptionStatusService) {
    projections.eventBus.register(subscriptionStatusService);
  }

  const app = createApp({
    authService,
    notificationService,
    invoiceService,
    investmentService,
    settlementService,
    marketplaceService,
    kycService,
    ratingsLeaderboardService,
    dividendCycleService,
    dividendDistributionService: projections.dividendDistributionService,
    aclService: projections.aclService,
    creatorKeyService: projections.creatorKeyService,
    curveMigrationService: projections.curveMigrationService,
    royaltyEarningsService: projections.royaltyEarningsService,
    subscriptionStatusService,
    onboardingService,
    acknowledgementService,
    extensionService,
    adminMetricsService,
    portfolioService,
    config,
    logger,
    metricsEnabled: config.observability.metricsEnabled,
  });

  const server = app.listen(config.port, () => {
    logger.info("Server running", { port: config.port });
  });

  // ---- Start daily analytics snapshot cron (midnight UTC) ----
  const snapshotScheduler = scheduleAnalyticsSnapshotJob(dataSource);

  // Stop scheduler on server close
  server.on("close", () => {
    snapshotScheduler.stop();
  });

  return { server };
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error("Startup failed", { error: err });
    process.exit(1);
  });
}
