import { Request, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import { submitInvoiceSchema } from "@/lib/invoice-submission.schema";
import { adminNotificationQueue } from "@/services/admin-notification-queue.service";
import { InvoiceStatus, UserType } from "@/types/enums";
import type { AuthenticatedRequest } from "@/types/auth";
import type { InvoiceService } from "@/services/invoice.service";
import dataSource from "@/config/database";
import { Invoice } from "@/models/Invoice.model";

export async function submitInvoice(
  req: Request | AuthenticatedRequest,
  res: Response,
  invoiceService?: InvoiceService
) {
  try {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Must be a seller (not an investor)
    if (user.userType && user.userType === UserType.INVESTOR) {
      return res.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: "Only sellers can submit invoices for review",
        },
      });
    }

    const parseResult = submitInvoiceSchema.safeParse(req.body);
    if (!parseResult.success) {
      const fieldErrors = parseResult.error.issues.map((e: z.ZodIssue) => ({
        field: e.path.join(".") || "unknown",
        message: e.message,
        code: e.code,
      }));
      return res.status(422).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          details: fieldErrors,
        },
        errors: fieldErrors,
      });
    }

    const {
      title,
      description,
      faceValue,
      fundingTarget,
      yieldBps,
      fundingDeadline,
      ipfsDocumentUrl,
    } = parseResult.data;

    const sellerWallet = user.stellarAddress;
    const sellerId = user.id;
    const invoiceId = crypto.randomUUID();
    const invoiceNumber = `INV-${Date.now().toString().slice(-6)}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    let savedInvoice: Partial<Invoice> = {
      id: invoiceId,
      sellerId,
      sellerWallet,
      invoiceNumber,
      customerName: title,
      title,
      description,
      amount: faceValue.toString(),
      faceValue: faceValue.toString(),
      discountRate: (yieldBps / 100).toFixed(2),
      yieldBps,
      fundingTarget: fundingTarget.toString(),
      netAmount: fundingTarget.toString(),
      dueDate: fundingDeadline,
      fundingDeadline,
      ipfsHash: ipfsDocumentUrl,
      ipfsDocumentUrl,
      status: InvoiceStatus.PENDING,
      rejectionReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const invSvc = invoiceService as unknown as {
      submitInvoice?: (params: unknown) => Promise<Invoice>;
    };
    if (invSvc && typeof invSvc.submitInvoice === "function") {
      savedInvoice = await invSvc.submitInvoice({
        sellerId,
        sellerWallet,
        title,
        description,
        faceValue,
        fundingTarget,
        yieldBps,
        fundingDeadline,
        ipfsDocumentUrl,
      });
    } else if (dataSource.isInitialized) {
      const repo = dataSource.getRepository(Invoice);
      const invoiceEntity = repo.create(savedInvoice as Invoice);
      savedInvoice = await repo.save(invoiceEntity);
    }

    // Emit invoice_submitted event to admin notification queue
    await adminNotificationQueue.emitEvent("invoice_submitted", {
      invoiceId: savedInvoice.id || invoiceId,
      sellerId,
      sellerWallet,
      title,
      description,
      faceValue,
      fundingTarget,
      yieldBps,
      fundingDeadline,
      ipfsDocumentUrl,
      submittedAt: new Date(),
    });

    return res.status(201).json({
      success: true,
      data: savedInvoice,
    });
  } catch (err: unknown) {
    const appErr = err as { status?: number; code?: string; message?: string };
    return res.status(appErr.status ?? 500).json({
      error: {
        code: appErr.code ?? "INTERNAL_ERROR",
        message: appErr.message ?? "Internal server error",
      },
    });
  }
}
