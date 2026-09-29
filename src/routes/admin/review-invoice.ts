import { Request, Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { InvoiceService } from "../../services/invoice.service";
import { ServiceError } from "../../utils/service-error";
import { logger } from "../../observability/logger";
import { InvoiceEscrowContractService } from "../../services/stellar/invoice-escrow-contract.service";

interface ReviewInvoiceBody {
  action: "approve" | "reject";
  reason?: string;
}

/** USDC has 7 decimals, so a decimal amount becomes stroops by scaling. */
const STROOPS_DECIMALS = 7;

function toStroops(amount: string): string {
  const [whole, fraction = ""] = amount.split(".");
  const scaled = `${whole}${fraction.padEnd(STROOPS_DECIMALS, "0").slice(0, STROOPS_DECIMALS)}`;
  return scaled.replace(/^0+(?=\d)/, "");
}

export async function reviewInvoice(
  req: Request<ParamsDictionary, unknown, ReviewInvoiceBody>,
  res: Response,
  invoiceService: InvoiceService,
  contractService?: InvoiceEscrowContractService,
  resolveSellerAddress?: (sellerId: string) => Promise<string>
) {
  try {
    const { action, reason } = req.body;
    const rawInvoiceId = req.params.invoiceId;
    const invoiceId = Array.isArray(rawInvoiceId) ? rawInvoiceId[0] : rawInvoiceId;

    if (!invoiceId) {
      return res.status(400).json({ error: { code: "INVOICE_ID_REQUIRED", message: "Invoice id is required" } });
    }

    if (action === "reject" && (!reason || !reason.trim())) {
      return res.status(400).json({ error: { code: "REASON_REQUIRED", message: "Reason is required when rejecting an invoice" } });
    }

    if (action !== "approve" && action !== "reject") {
      return res.status(400).json({ error: { code: "INVALID_ACTION", message: "Action must be approve or reject" } });
    }

    if (action === "approve") {
      const result = await invoiceService.approveInvoice({
        invoiceId,
        actorId: "admin",
      });

      // Register the approved invoice on the Soroban contract
      if (contractService) {
        try {
          await contractService.executeRegisterInvoice({
            invoiceId,
            sellerAddress: resolveSellerAddress
              ? await resolveSellerAddress(result.sellerId)
              : "UNKNOWN",
            amountStroops: toStroops(result.amount)
          });
        } catch (contractError) {
          logger.error("Failed to register invoice on Soroban contract", { error: contractError, invoiceId });
          // Note: Depending on business rules, we might fail the whole request or just log it.
          // In a real app we'd probably fail the whole request and rollback DB state, but for now we'll throw
          throw new ServiceError("contract_registration_failed", "Failed to register invoice on smart contract", 500, { originalError: contractError instanceof Error ? contractError.message : contractError });
        }
      }

      logger.info("Admin invoice review decision", {
        invoice_id: invoiceId,
        decision: "approved",
        decided_at: new Date().toISOString(),
      });

      return res.status(200).json({ success: true, data: result });
    } else {
      const result = await invoiceService.rejectInvoice({
        invoiceId,
        actorId: "admin",
        rejectionReason: reason as string,
      });

      logger.info("Admin invoice review decision", {
        invoice_id: invoiceId,
        decision: "rejected",
        reason,
        decided_at: new Date().toISOString(),
      });

      return res.status(200).json({ success: true, data: result });
    }
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }

    logger.error("Internal error during invoice review", { error: err });
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  }
}
