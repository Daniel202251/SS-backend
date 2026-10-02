import type { AppLogger } from "../observability/logger";
import type { KYCStatus } from "../types/enums";
import { truncateWalletAddress } from "./kyc";

/** The administrative action that produced a KYC status change. */
export type KYCStatusChangeAction = "approve" | "reject" | "revoke";

/** The stable category of a KYC review failure. */
export type KYCReviewFailureCategory = "unauthorized" | "user_not_found" | "invalid_state" | "database_error";

export interface KYCStatusChangeInput {
  /** Wallet address of the user whose KYC status changed. */
  wallet: string;
  /** The status the user held immediately before this change. */
  previousStatus: KYCStatus;
  /** The status now persisted for the user. */
  newStatus: KYCStatus;
  /** Wallet address of the admin who made the decision. */
  reviewerWallet: string;
  /** Internal id of the reviewing admin, recorded alongside their wallet. */
  reviewerId?: string;
  /** Which admin action this was. */
  action: KYCStatusChangeAction;
  /** Free-form reason, recorded for rejections and revocations. */
  reason?: string;
  /** Override for the change timestamp; defaults to the server clock. */
  changedAt?: Date;
}

/**
 * The single audit-trail entry for a KYC status change.
 *
 * Every approve, reject and revoke goes through here so the five audit fields
 * — who, which wallet, from what, to what, and when — are always present and
 * always spelled the same way, which is what makes the log queryable.
 *
 * Call this *after* the status has been persisted and before the response is
 * sent: an entry here is a claim that the change is durable, so it must never
 * be written for a decision that failed to commit.
 *
 * Wallet addresses are truncated the same way as everywhere else in the
 * codebase — enough to identify an account in an investigation, not enough to
 * spill full addresses into log aggregation.
 */
export function logKYCStatusChange(logger: AppLogger, input: KYCStatusChangeInput): void {
  logger.info("KYC status change", {
    wallet: truncateWalletAddress(input.wallet),
    previous_status: input.previousStatus,
    new_status: input.newStatus,
    reviewer_wallet: truncateWalletAddress(input.reviewerWallet),
    changed_at: (input.changedAt ?? new Date()).toISOString(),
    action: input.action,
    ...(input.reviewerId ? { reviewer_id: input.reviewerId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  });
}

export interface KYCReviewFailureInput {
  /** Internal id of the user being reviewed, if known. */
  userId?: string;
  /** Internal id of the reviewing admin, if known. */
  reviewerId?: string;
  /** Which admin action failed. */
  action: KYCStatusChangeAction;
  /** The stable category of the failure. */
  failureCategory: KYCReviewFailureCategory;
  /** A correlation identifier for the request, if available. */
  correlationId?: string;
  /** Any error message or code. */
  errorDetails?: string;
}

/**
 * Audit log for failed KYC review decisions.
 */
export function logKYCReviewFailure(logger: AppLogger, input: KYCReviewFailureInput): void {
  logger.error("KYC review failed", {
    ...(input.userId ? { user_id: input.userId } : {}),
    ...(input.reviewerId ? { reviewer_id: input.reviewerId } : {}),
    action: input.action,
    failure_category: input.failureCategory,
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    ...(input.errorDetails ? { error_details: input.errorDetails } : {}),
  });
}
