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
import { createSecondaryMarketService } from "./services/secondary-market.service";
import { KycService } from "./services/kyc.service";
import { XlmUsdRateService } from "./services/xlm-usd-rate.service";
import { PaymentDistributorContractService } from "./services/stellar/payment-distributor-contract.service";
import { InvoiceEscrowContractService } from "./services/stellar/invoice-escrow-contract.service";
import { getSorobanConfig } from "./config/stellar";

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
  const sorobanConfig = getSorobanConfig();
  const escrowRefundService =
    sorobanConfig.escrowContractId && sorobanConfig.rpcUrl
      ? new InvoiceEscrowContractService(
          {
            contractId: sorobanConfig.escrowContractId,
            rpcUrl: sorobanConfig.rpcUrl,
            networkPassphrase: sorobanConfig.networkPassphrase,
            platformSecretKey: sorobanConfig.platformSecretKey,
          },
          logger
        )
      : undefined;
  const investmentService = createInvestmentService(
    dataSource,
    invoiceStateMachine,
    createInvestmentNotifier(notificationService, logger),
    escrowRefundService
  );
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
  const secondaryMarketService = createSecondaryMarketService(dataSource);
  const kycService = new KycService(dataSource, config.kyc.webhookSecret ?? "", logger);
  const xlmUsdRateService = new XlmUsdRateService({
    redisUrl: config.cache.redisUrl,
    enabled: config.cache.enabled,
    horizonUrl: config.rates.xlmUsd.horizonUrl,
    refreshIntervalMs: config.rates.xlmUsd.refreshIntervalMs,
    cacheTtlSeconds: config.rates.xlmUsd.cacheTtlSeconds,
    staleAfterMs: config.rates.xlmUsd.staleAfterMs,
    assetCode: config.rates.xlmUsd.assetCode,
    assetIssuer: config.rates.xlmUsd.assetIssuer,
    logger,
  });
  xlmUsdRateService.start();

  const app = createApp({
    authService,
    notificationService,
    invoiceService,
    investmentService,
    settlementService,
    marketplaceService,
    secondaryMarketService,
    kycService,
    xlmUsdRateService,
    config,
    logger,
    metricsEnabled: config.observability.metricsEnabled,
  });

  const server = app.listen(config.port, () => {
    logger.info("Server running", { port: config.port });
  });

  return { server };
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error("Startup failed", { error: err });
    process.exit(1);
  });
}
