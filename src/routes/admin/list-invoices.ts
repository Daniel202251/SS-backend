import { Request, Response } from "express";
import { InvoiceService } from "../../services/invoice.service";
import { InvoiceStatus } from "../../types/enums";
import { getCursorPaginationParams } from "../../utils/query-pagination.utils";

export async function listInvoices(req: Request, res: Response, invoiceService: InvoiceService) {
  try {
    const statusQuery = req.query.status as string;
    if (statusQuery && statusQuery !== "pending") {
      return res.status(400).json({ error: "Only pending status is supported for admin review list" });
    }

    const { limit, cursor } = getCursorPaginationParams(req);

    // Get the pending invoices
    const result = await invoiceService.getInvoicesList({
      status: InvoiceStatus.PENDING,
      limit,
      cursor,
    });

    res.json({
      success: true,
      data: result.data,
      meta: {
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
}
