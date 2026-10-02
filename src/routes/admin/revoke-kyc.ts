import { Request, Response } from "express";
import { DataSource } from "typeorm";
import { User } from "@/models/User.model";
import { KYCStatus } from "@/types/enums";
import { logKYCStatusChange, logKYCReviewFailure } from "@/lib/kyc-status-log";
import { logger } from "@/observability/logger";

interface RevokeKYCBody {
  userId: string;
  reviewerId: string;
  revocationReason: string;
}

/**
 * Withdraws a previously granted KYC approval.
 *
 * Revocation returns the user to {@link KYCStatus.PENDING} rather than
 * {@link KYCStatus.REJECTED}: the user is no longer cleared to trade, but the
 * decision is "needs review again", not "rejected on the merits", and it leaves
 * them able to re-submit. Only an approved user can be revoked — revoking
 * anything else would be a no-op that still wrote an audit entry.
 */
export async function revokeKYC(
  req: Request<unknown, unknown, RevokeKYCBody>,
  res: Response,
  dataSource: DataSource
) {
  try {
    const adminKey = req.headers["x-admin-key"];
    const correlationId = req.headers["x-request-id"] as string | undefined;

    if (adminKey !== process.env.ADMIN_API_KEY) {
      logKYCReviewFailure(logger, {
        userId: req.body?.userId,
        reviewerId: req.body?.reviewerId,
        action: "revoke",
        failureCategory: "unauthorized",
        correlationId,
      });
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { userId, reviewerId, revocationReason } = req.body;

    const userRepo = dataSource.getRepository(User);
    const user = await userRepo.findOneBy({ id: userId });
    if (!user) {
      logKYCReviewFailure(logger, {
        userId,
        reviewerId,
        action: "revoke",
        failureCategory: "user_not_found",
        correlationId,
      });
      return res.status(404).json({ error: "User not found" });
    }

    const previousStatus = user.kycStatus;
    if (previousStatus !== KYCStatus.APPROVED) {
      logKYCReviewFailure(logger, {
        userId,
        reviewerId,
        action: "revoke",
        failureCategory: "invalid_state",
        correlationId,
        errorDetails: `Cannot revoke KYC for a user whose status is ${previousStatus}.`,
      });
      return res.status(409).json({
        error: {
          code: "KYC_NOT_APPROVED",
          message: `Cannot revoke KYC for a user whose status is ${previousStatus}.`,
        },
      });
    }

    const reviewer = await userRepo.findOneBy({ id: reviewerId });

    await userRepo.update(userId, { kycStatus: KYCStatus.PENDING });

    // Logged only after the DB update succeeds, so the audit trail never
    // records a decision that didn't actually persist.
    logKYCStatusChange(logger, {
      wallet: user.stellarAddress,
      previousStatus,
      newStatus: KYCStatus.PENDING,
      reviewerWallet: reviewer?.stellarAddress ?? reviewerId,
      reviewerId,
      action: "revoke",
      reason: revocationReason,
    });

    return res.json({ success: true });
  } catch (err: unknown) {
    const correlationId = req.headers["x-request-id"] as string | undefined;
    logKYCReviewFailure(logger, {
      userId: req.body?.userId,
      reviewerId: req.body?.reviewerId,
      action: "revoke",
      failureCategory: "database_error",
      correlationId,
      errorDetails: err instanceof Error ? err.message : String(err),
    });

    const appErr = err as { status?: number; code?: string; message?: string };
    return res.status(appErr.status ?? 500).json({
      error: {
        code: appErr.code ?? "INTERNAL_ERROR",
        message: appErr.message ?? "Internal server error",
      },
    });
  }
}
