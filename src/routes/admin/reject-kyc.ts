import { Request, Response } from "express";
import { DataSource } from "typeorm";
import { User } from "@/models/User.model";
import { KYCStatus } from "@/types/enums";
import { logKYCStatusChange, logKYCReviewFailure } from "@/lib/kyc-status-log";
import { logger } from "@/observability/logger";

interface RejectKYCBody {
  userId: string;
  reviewerId: string;
  rejectionReason: string;
}

export async function rejectKYC(
  req: Request<unknown, unknown, RejectKYCBody>,
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
        action: "reject",
        failureCategory: "unauthorized",
        correlationId,
      });
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { userId, reviewerId, rejectionReason } = req.body;

    const userRepo = dataSource.getRepository(User);
    const user = await userRepo.findOneBy({ id: userId });
    if (!user) {
      logKYCReviewFailure(logger, {
        userId,
        reviewerId,
        action: "reject",
        failureCategory: "user_not_found",
        correlationId,
      });
      return res.status(404).json({ error: "User not found" });
    }

    // Captured before the update so the audit entry records what the status
    // actually moved from, not what it moved to.
    const previousStatus = user.kycStatus;
    const reviewer = await userRepo.findOneBy({ id: reviewerId });

    await userRepo.update(userId, { kycStatus: KYCStatus.REJECTED });

    // Logged only after the DB update succeeds, so the audit trail never
    // records a decision that didn't actually persist.
    logKYCStatusChange(logger, {
      wallet: user.stellarAddress,
      previousStatus,
      newStatus: KYCStatus.REJECTED,
      reviewerWallet: reviewer?.stellarAddress ?? reviewerId,
      reviewerId,
      action: "reject",
      reason: rejectionReason,
    });

    return res.json({ success: true });
  } catch (err: unknown) {
    const correlationId = req.headers["x-request-id"] as string | undefined;
    logKYCReviewFailure(logger, {
      userId: req.body?.userId,
      reviewerId: req.body?.reviewerId,
      action: "reject",
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
