import type { AppLogger } from "../observability/logger";
import { truncateWalletAddress } from "./kyc";
import { redactString } from "../observability/redaction-formatter";
import { stroopsToXlm } from "./stellar-format";
import { logSettlementCompletion } from "./settlement-completion-log";

export interface SettlementStartInput {
  invoiceId: string;
  actorWallet: string;
  startedAt: string;
}

export interface SettlementFailureInput {
  invoiceId: string;
  error: unknown;
  durationMs?: number;
  distributionTxHash?: string | null;
  category?: string;
  retryable?: boolean;
}

export interface SettlementSuccessInput {
  invoiceId: string;
  totalProceedsStroops: bigint;
  investorCount: number;
  durationMs?: number;
  distributionTxHash?: string | null;
}

export function logSettlementStart(logger: AppLogger, input: SettlementStartInput): void {
  logger.info("Starting settlement flow.", {
    event: "settlement_started",
    invoice_id: input.invoiceId,
    actor_wallet: truncateWalletAddress(input.actorWallet),
    started_at: input.startedAt,
  });
}

export function logSettlementFailure(logger: AppLogger, input: SettlementFailureInput): void {
  const safeMessage = redactString(
    input.error instanceof Error ? input.error.message : String(input.error ?? "")
  );

  logger.warn("Settlement flow failed.", {
    event: "settlement_failed",
    invoice_id: input.invoiceId,
    category:
      input.category ??
      (input.error instanceof Error && "code" in input.error
        ? String((input.error as Record<string, unknown>).code)
        : "unknown"),
    retryable: Boolean(input.retryable),
    duration_ms: input.durationMs ?? null,
    distribution_tx_hash: input.distributionTxHash ?? null,
    error_reason: safeMessage,
  });
}

export function logSettlementSuccess(logger: AppLogger, input: SettlementSuccessInput): void {
  // Emit the established completion log used by tests
  logSettlementCompletion(logger, {
    invoiceId: input.invoiceId,
    totalProceedsStroops: input.totalProceedsStroops,
    investorCount: input.investorCount,
  });

  // Additional lightweight success event with duration and correlation
  logger.info("Settlement flow completed.", {
    event: "settlement_completed",
    invoice_id: input.invoiceId,
    total_proceeds: stroopsToXlm(input.totalProceedsStroops),
    investor_count: input.investorCount,
    duration_ms: input.durationMs ?? null,
    distribution_tx_hash: input.distributionTxHash ?? null,
    settled_at: new Date().toISOString(),
  });
}

export default {
  logSettlementStart,
  logSettlementFailure,
  logSettlementSuccess,
};
