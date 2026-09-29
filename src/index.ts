import type { Server } from "http";

import { createApp } from "./app";

import dataSource from "./config/database";
import { getConfig } from "./config/env";
import { logger } from "./observability/logger";
import { MetricsRegistry } from "./observability/metrics";

import { createAuthService } from "./services/auth.service";
import {
  createDedupedNotificationStore,
  createNotificationService,
} from "./services/notification.service";
import { InvoiceService } from "./services/invoice.service";
import {
  createInvoiceStateMachine,
  createSellerNotificationEffect,
} from "./lib/invoice-state-machine";
import {
  createNotificationDispatchEffect,
  InMemoryDeadLetterSink,
  NotificationDispatcher,
  unlessDispatched,
} from "./lib/notification-dispatcher";
import { createInvestmentNotifier, createInvestorDirectory } from "./lib/invoice-notifications";
import { Invoice } from "./models/Invoice.model";
import { createIPFSService } from "./services/ipfs.service";
import { createInvestmentService } from "./services/investment.service";
import { createSettlementService } from "./services/settlement.service";
import { createAdminSettlementService } from "./services/admin-settlement.service";
import { createMarketplaceService } from "./services/marketplace.service";
import { KycService } from "./services/kyc.service";
import { PaymentDistributorContractService } from "./services/stellar/payment-distributor-contract.service";
import { createOnchainProjections } from "./services/onchain-projections.service";
import { InvoiceEscrowContractService } from "./services/stellar/invoice-escrow-contract.service";
import { getSorobanConfig } from "./config/stellar";
import { createInvoiceMaturityWorker, SettlementEventBus } from "./workers/invoice-maturity.worker";
import { createRatingsLeaderboardService } from "./services/ratings-leaderboard.service";
import { createDividendCycleService } from "./services/dividend-cycle.service";
import { createSecondaryMarketService } from "./services/secondary-market.service";
import { createWatchlistService } from "./services/watchlist.service";
import { createSettlementWorker } from "./workers/settlement.worker";
import { scheduleAnalyticsSnapshotJob } from "./workers/analytics-snapshot.worker";

export async function bootstrap(): Promise<{
  server: Server;
  settlementEvents: SettlementEventBus;
}> {
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
  // Funded, settled, rejected and approved events fan out through the queued
  // dispatcher; the seller effect still covers every other status change.
  const notificationDispatcher = new NotificationDispatcher({
    store: createDedupedNotificationStore(dataSource),
    investors: createInvestorDirectory(dataSource),
    deadLetters: new InMemoryDeadLetterSink(),
    logger,
  });
  const invoiceStateMachine = createInvoiceStateMachine({
    effects: [
      unlessDispatched(createSellerNotificationEffect(notificationService)),
      createNotificationDispatchEffect(notificationDispatcher),
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
  
  const invoiceEscrowContract =
    sorobanConfig.escrowContractId && sorobanConfig.rpcUrl && sorobanConfig.platformSecretKey
      ? new InvoiceEscrowContractService(
          {
            ...sorobanConfig,
            contractId: sorobanConfig.escrowContractId,
            networkPassphrase: sorobanConfig.networkPassphrase,
          },
          logger
        )
      : undefined;

  const settlementService = createSettlementService(
    dataSource,
    distributor,
    distributorConfig,
    invoiceStateMachine,
    undefined,
    notificationService
  );
  
  const adminSettlementService =
    invoiceEscrowContract && notificationService
      ? createAdminSettlementService(
          dataSource,
          invoiceEscrowContract,
          notificationService,
          invoiceStateMachine
        )
      : undefined;

  const marketplaceService = createMarketplaceService(dataSource);
  const kycService = new KycService(dataSource, config.kyc.webhookSecret ?? "", logger);

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

  // Read models projected from Soroban contract events: creator key buy
  // limits, the integration ACL, curve migrations, atomic swap history, creator
  // royalty earnings and holder dividend cycles.
  const projections = createOnchainProjections({ dataSource, logger });

  // ---- Feature: Secondary Market ----
  const secondaryMarketService = createSecondaryMarketService(dataSource);

  // ---- Feature: Watchlist ----
  const watchlistService = createWatchlistService(dataSource);

  // ---- Feature: Settlement Worker ----
  const settlementWorker = createSettlementWorker(dataSource, settlementService);

  const app = createApp({
    authService,
    notificationService,
    invoiceService,
    investmentService,
    settlementService,
    adminSettlementService,
    marketplaceService,
    kycService,
    ratingsLeaderboardService,
    dividendCycleService,
    secondaryMarketService,
    watchlistService,
    settlementWorker,
    config,
    logger,
    metricsEnabled: config.observability.metricsEnabled,
    creatorKeyService: projections.creatorKeyService,
    aclService: projections.aclService,
    curveMigrationService: projections.curveMigrationService,
    swapService: projections.swapService,
    royaltyEarningsService: projections.royaltyEarningsService,
    dividendDistributionService: projections.dividendDistributionService,
  });

  const server = app.listen(config.port, () => {
    logger.info("Server running", { port: config.port });
  });

  // Settlement outcomes for notification dispatch; the state machine effects
  // above already notify sellers and investors of each status change.
  const settlementEvents = new SettlementEventBus();
  const maturityWorker = createInvoiceMaturityWorker(
    dataSource,
    settlementService,
    invoiceStateMachine,
    settlementEvents,
    config.maturity,
    logger
  );
  maturityWorker.start();
  server.on("close", () => {
    void maturityWorker.stop();
  });

  return { server, settlementEvents };
  // ---- Start daily analytics snapshot cron (midnight UTC) ----
  const snapshotScheduler = scheduleAnalyticsSnapshotJob(dataSource);

  // ---- Start settlement worker cron (hourly) ----
  settlementWorker.start("0 * * * *");

  // Stop schedulers on server close
  server.on("close", () => {
    snapshotScheduler.stop();
    settlementWorker.stop();
  });

  return { server };
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error("Startup failed", { error: err });
    process.exit(1);
  });
}
