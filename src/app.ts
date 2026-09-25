import cors from "cors";
import helmet from "helmet";
import express, { Request } from "express";

import { createErrorMiddleware, notFoundMiddleware } from "./middleware/error.middleware";
import { applyRateLimiters } from "./middleware/rate-limit.middleware";
import { createRequestObservabilityMiddleware } from "./middleware/request-observability.middleware";
import { sanitizeInputMiddleware } from "./middleware/sanitize-input.middleware";

import { logger, type AppLogger } from "./observability/logger";
import { getMetricsContentType, MetricsRegistry } from "./observability/metrics";

import { createAuthRouter } from "./routes/auth.routes";
import { createKycRouter, createKycWebhookRouter } from "./routes/kyc.routes";
import { createNotificationRouter } from "./routes/notification.routes";
import { createInvoiceRouter } from "./routes/invoice.routes";
import { createInvestmentRouter } from "./routes/investment.routes";
import { createSettlementRouter } from "./routes/settlement.routes";
import { createMarketplaceRouter } from "./routes/marketplace.routes";
import { createSecondaryMarketRouter } from "./routes/secondary-market.routes";
import { createAdminRouter } from "./routes/admin/admin.routes";
import { createXlmUsdRateRouter } from "./routes/xlm-usd-rate.routes";
import { createContractGuardService } from "./services/stellar/contract-guard.service";

import type { AuthService } from "./services/auth.service";
import type { NotificationService } from "./services/notification.service";
import type { InvoiceService } from "./services/invoice.service";
import type { InvestmentService } from "./services/investment.service";
import type { SettlementService } from "./services/settlement.service";
import type { MarketplaceService } from "./services/marketplace.service";
import type { SecondaryMarketService } from "./services/secondary-market.service";
import type { KycService } from "./services/kyc.service";
import type { XlmUsdRateService } from "./services/xlm-usd-rate.service";

import dataSource from "./config/database";

//  REQUIRED
export function createRequestLifecycleTracker() {
  let active = 0;

  return {
    onRequestStart() {
      active++;
    },
    onRequestEnd() {
      active = Math.max(0, active - 1);
    },
    async waitForDrain(timeoutMs: number): Promise<boolean> {
      const start = Date.now();
      while (active > 0) {
        if (Date.now() - start > timeoutMs) return false;
        await new Promise((r) => setTimeout(r, 10));
      }
      return true;
    },
  };
}

interface RequestWithId extends Request {
  requestId?: string;
}

export interface AppDependencies {
  authService: AuthService;
  notificationService?: NotificationService;
  invoiceService?: InvoiceService;
  investmentService?: InvestmentService;
  settlementService?: SettlementService;
  marketplaceService?: MarketplaceService;
  secondaryMarketService?: SecondaryMarketService;
  kycService?: KycService;
  xlmUsdRateService?: XlmUsdRateService;
  logger?: AppLogger;
  metricsEnabled?: boolean;
  metricsRegistry?: MetricsRegistry;
  config?: import("./config/env").AppConfig;

  http?: {
    trustProxy?: boolean | number | string;
    nodeEnv?: string;
    corsAllowedOrigins?: string[];
    corsAllowCredentials?: boolean;
    rateLimit?: {
      enabled?: boolean;
      windowMs?: number;
      max?: number;
    };
  };
}

export function createApp({
  authService,
  notificationService,
  invoiceService,
  investmentService,
  settlementService,
  marketplaceService,
  secondaryMarketService,
  kycService,
  xlmUsdRateService,
  logger: appLogger = logger,
  metricsEnabled = true,
  metricsRegistry = new MetricsRegistry(),
  config,
  http,
}: AppDependencies) {
  const app = express();

  // ✅ FIX TRUST PROXY
  if (http?.trustProxy !== undefined) {
    app.set("trust proxy", http.trustProxy);
  }

  // Registered first so every request, including ones rejected by helmet,
  // CORS, the KYC webhook router or a rate limiter, is logged and carries a
  // correlation ID.
  app.use(
    createRequestObservabilityMiddleware({
      logger: appLogger,
      metricsEnabled,
      metricsRegistry,
    })
  );

  app.use(helmet());

  app.use(
    cors({
      origin: http?.corsAllowedOrigins ?? true,
      credentials: http?.corsAllowCredentials ?? false,
    })
  );

  if (kycService) {
    app.use("/api/v1/kyc", createKycWebhookRouter(kycService));
  }

  app.use(express.json());

  app.use(sanitizeInputMiddleware);

  // FORCE RATE LIMITER (tests depend on it)
  if (http?.rateLimit?.enabled !== false) {
    applyRateLimiters(app, appLogger, {
      global: http?.rateLimit
        ? {
            windowMs: http.rateLimit.windowMs ?? 60_000,
            max: http.rateLimit.max ?? 100,
          }
        : undefined,
    });
  }
  app.get("/health", (req, res) => {
    const requestId = (req as RequestWithId).requestId ?? "unknown";

    res.status(200).json({
      success: true,
      requestId,
      data: {
        status: "ok",
        timestamp: new Date().toISOString(),
        uptimeSeconds: Number(process.uptime().toFixed(3)),
        requestId,
      },
    });
  });

  app.get("/health/db", async (_req, res) => {
    if (!dataSource.isInitialized) {
      return res.status(503).json({
        success: false,
        error: {
          code: "DB_NOT_INITIALIZED",
          message: "Database connection is not initialized.",
        },
      });
    }

    res.status(200).json({ success: true });
  });

  if (metricsEnabled) {
    app.get("/metrics", (_req, res) => {
      res.setHeader("Content-Type", getMetricsContentType());
      res.send(metricsRegistry.renderPrometheusMetrics());
    });
  }

  app.use("/api/v1/auth", createAuthRouter(authService, appLogger));

  if (kycService) {
    app.use("/api/v1/kyc", createKycRouter(kycService, authService));
  }

  if (notificationService) {
    app.use("/api/v1/notifications", createNotificationRouter(notificationService, authService));
  }

  // The emergency pause guard only has something to check when a Soroban
  // contract and an RPC endpoint are both configured; otherwise the routers
  // mount without it and behave exactly as before.
  const pauseGuardContractId = config?.sorobanEscrow.contractId ?? null;
  const pauseGuardRpcUrl = config?.sorobanEscrow.rpcUrl ?? null;
  const contractGuardService =
    pauseGuardRpcUrl && pauseGuardContractId
      ? createContractGuardService({ rpcUrl: pauseGuardRpcUrl })
      : undefined;

  if (invoiceService && config) {
    app.use(
      "/api/v1/invoices",
      createInvoiceRouter({
        invoiceService,
        config,
        investmentService,
        authService,
        contractGuardService,
        contractId: pauseGuardContractId,
      })
    );
  }

  if (investmentService) {
    app.use(
      "/api/v1/investments",
      createInvestmentRouter({
        investmentService,
        authService,
        contractGuardService,
        contractId: pauseGuardContractId,
      })
    );
  }

  if (settlementService) {
    app.use(
      "/api/v1/settlements",
      createSettlementRouter({
        settlementService,
        contractGuardService,
        contractId: pauseGuardContractId,
      })
    );
  }

  if (marketplaceService) {
    app.use("/api/v1/marketplace", createMarketplaceRouter({ marketplaceService }));
  }

  if (secondaryMarketService) {
    app.use("/api/v1/secondary-market", createSecondaryMarketRouter({
      secondaryMarketService,
      authService,
    }));
    app.use("/secondary-market", createSecondaryMarketRouter({
      secondaryMarketService,
      authService,
    }));
  }

  if (xlmUsdRateService) {
    app.use("/rates", createXlmUsdRateRouter({ xlmUsdRateService }));
  }

  if (config?.admin?.ipWhitelist?.length) {
    app.use(
      "/api/v1/admin",
      createAdminRouter({ dataSource, allowedCidrs: config.admin.ipWhitelist, invoiceService })
    );
  }

  app.use(notFoundMiddleware);
  app.use(createErrorMiddleware(appLogger));

  return app;
}
