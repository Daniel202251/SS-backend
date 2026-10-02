import { Request, Response } from "express";
import type { InvoiceService } from "@/services/invoice.service";
import { ServiceError } from "@/utils/service-error";
import { logger } from "@/observability/logger";

interface RejectInvoiceBody {
  rejectionReason: string;
}

interface RejectInvoiceParams {
  id: string;
}

/**
 * POST /api/v1/admin/invoices/:id/reject (issue #206)
 *
 * Admin-only endpoint that rejects a pending invoice: persists the
 * rejection reason on the invoice record, transitions its status to
 * REJECTED, and notifies the seller. Follows the same `x-admin-key`
 * gating convention as approve-kyc.ts / reject-kyc.ts (this codebase has
 * no role-based user/admin model yet, so — as with those sibling
 * endpoints — an unauthenticated/incorrect admin key yields 401, not the
 * 403 a full role-based scheme might return for an authenticated
 * non-admin caller).
 */
export async function rejectInvoice(
  req: Request<RejectInvoiceParams, unknown, RejectInvoiceBody>,
  res: Response,
  invoiceService: InvoiceService
) {
  try {
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    const { rejectionReason } = req.body;

    if (!rejectionReason || typeof rejectionReason !== "string" || !rejectionReason.trim()) {
      return res.status(400).json({
        error: { code: "INVALID_REJECTION_REASON", message: "rejectionReason is required" },
      });
    }

    const result = await invoiceService.rejectInvoice({
      invoiceId: id,
      rejectionReason,
      actorId: "admin",
    });

    logger.info("Admin invoice rejection decision", {
      invoice_id: id,
      decision: "rejected",
      decided_at: new Date().toISOString(),
    });

    return res.status(200).json({ success: true, data: result });
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }

    const appErr = err as { status?: number; code?: string; message?: string };
    return res.status(appErr.status ?? 500).json({
      error: {
        code: appErr.code ?? "INTERNAL_ERROR",
        message: appErr.message ?? "Internal server error",
      },
    });
  }
}
