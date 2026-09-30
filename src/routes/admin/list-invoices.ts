import { Request, Response } from "express";
import { InvoiceService } from "../../services/invoice.service";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parseLimit(req: Request): number {
  const raw = Number.parseInt(String(req.query.limit ?? ""), 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(raw, MAX_PAGE_SIZE);
}

export async function listInvoices(req: Request, res: Response, invoiceService: InvoiceService) {
  try {
    const statusQuery = req.query.status as string;
    if (statusQuery && statusQuery !== "pending") {
      return res.status(400).json({ error: "Only pending status is supported for admin review list" });
    }

    const limit = parseLimit(req);
    const offset = Number.parseInt(String(req.query.offset ?? "0"), 10);
    const skip = Number.isFinite(offset) && offset > 0 ? offset : 0;

    const result = await invoiceService.getPendingInvoicesForAdmin({ limit, skip });

    res.json({
      success: true,
      data: result.invoices,
      meta: {
        limit: result.limit,
        total: result.total,
        hasMore: result.hasMore,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
}
