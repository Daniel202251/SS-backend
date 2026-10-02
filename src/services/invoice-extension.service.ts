import { DataSource, Repository } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvoiceExtensionRequest } from "../models/InvoiceExtensionRequest.model";
import { ExtensionRequestStatus, InvoiceStatus, NotificationType } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import type { NotificationService } from "./notification.service";

const BLOCKED_STATUSES = new Set<InvoiceStatus>([
  InvoiceStatus.FUNDED,
  InvoiceStatus.SETTLED,
  InvoiceStatus.CANCELLED,
  InvoiceStatus.REJECTED,
]);

export class InvoiceExtensionService {
  private readonly requestRepo: Repository<InvoiceExtensionRequest>;
  private readonly invoiceRepo: Repository<Invoice>;
  private readonly investmentRepo: Repository<Investment>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly notificationService?: NotificationService
  ) {
    this.requestRepo = dataSource.getRepository(InvoiceExtensionRequest);
    this.invoiceRepo = dataSource.getRepository(Invoice);
    this.investmentRepo = dataSource.getRepository(Investment);
  }

  async requestExtension(input: {
    invoiceId: string;
    sellerId: string;
    proposedDeadline: Date;
    reason?: string | null;
  }): Promise<InvoiceExtensionRequest> {
    const invoice = await this.invoiceRepo.findOne({ where: { id: input.invoiceId } });
    if (!invoice) {
      throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
    }
    if (invoice.sellerId !== input.sellerId) {
      throw new ServiceError("FORBIDDEN", "Only the invoice seller can request an extension", 403);
    }
    if (BLOCKED_STATUSES.has(invoice.status)) {
      throw new ServiceError(
        "EXTENSION_NOT_ALLOWED",
        `Extension is not permitted on a ${invoice.status} invoice`,
        422
      );
    }

    const proposed = input.proposedDeadline;
    if (!(proposed instanceof Date) || Number.isNaN(proposed.getTime())) {
      throw new ServiceError("INVALID_DEADLINE", "proposedDeadline must be a valid date", 400);
    }
    if (proposed.getTime() <= Date.now()) {
      throw new ServiceError("INVALID_DEADLINE", "proposedDeadline must be in the future", 400);
    }

    const pending = await this.requestRepo.findOne({
      where: { invoiceId: input.invoiceId, status: ExtensionRequestStatus.PENDING },
    });
    if (pending) {
      throw new ServiceError(
        "EXTENSION_PENDING",
        "An extension request is already pending for this invoice",
        409
      );
    }

    const row = this.requestRepo.create({
      invoiceId: input.invoiceId,
      requestedBy: input.sellerId,
      proposedDeadline: proposed,
      previousDeadline: invoice.fundingDeadline ?? null,
      reason: input.reason ?? null,
      status: ExtensionRequestStatus.PENDING,
    });
    return this.requestRepo.save(row);
  }

  async reviewExtension(input: {
    invoiceId: string;
    requestId: string;
    decision: "approve" | "reject";
    reviewedBy: string;
    reviewNote?: string | null;
  }): Promise<{ request: InvoiceExtensionRequest; invoice: Invoice | null }> {
    return this.dataSource.transaction(async (manager) => {
      const requestRepo = manager.getRepository(InvoiceExtensionRequest);
      const invoiceRepo = manager.getRepository(Invoice);

      const request = await requestRepo.findOne({
        where: { id: input.requestId, invoiceId: input.invoiceId },
      });
      if (!request) {
        throw new ServiceError("EXTENSION_NOT_FOUND", "Extension request not found", 404);
      }
      if (request.status !== ExtensionRequestStatus.PENDING) {
        throw new ServiceError(
          "EXTENSION_NOT_PENDING",
          `Extension request is already ${request.status}`,
          409
        );
      }

      const invoice = await invoiceRepo.findOne({ where: { id: input.invoiceId } });
      if (!invoice) {
        throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
      }

      if (input.decision === "reject") {
        request.status = ExtensionRequestStatus.REJECTED;
        request.reviewedBy = input.reviewedBy;
        request.reviewedAt = new Date();
        request.reviewNote = input.reviewNote ?? null;
        const saved = await requestRepo.save(request);
        return { request: saved, invoice };
      }

      if (BLOCKED_STATUSES.has(invoice.status)) {
        throw new ServiceError(
          "EXTENSION_NOT_ALLOWED",
          `Extension is not permitted on a ${invoice.status} invoice`,
          422
        );
      }

      request.previousDeadline = invoice.fundingDeadline ?? request.previousDeadline;
      invoice.fundingDeadline = request.proposedDeadline;
      await invoiceRepo.save(invoice);

      request.status = ExtensionRequestStatus.APPROVED;
      request.reviewedBy = input.reviewedBy;
      request.reviewedAt = new Date();
      request.reviewNote = input.reviewNote ?? null;
      const saved = await requestRepo.save(request);

      return { request: saved, invoice };
    }).then(async (result) => {
      if (result.request.status === ExtensionRequestStatus.APPROVED && this.notificationService) {
        await this.notifyInvestors(result.request, result.invoice!);
      }
      return result;
    });
  }

  private async notifyInvestors(
    request: InvoiceExtensionRequest,
    invoice: Invoice
  ): Promise<void> {
    if (!this.notificationService) return;

    const investments = await this.investmentRepo.find({
      where: { invoiceId: invoice.id },
      select: ["investorId"],
    });
    const uniqueInvestorIds = [...new Set(investments.map((i) => i.investorId))];
    if (uniqueInvestorIds.length === 0) return;

    const deadlineIso = request.proposedDeadline.toISOString();
    await this.notificationService.createNotifications(
      uniqueInvestorIds.map((userId) => ({
        userId,
        type: NotificationType.INVOICE_DEADLINE_EXTENDED,
        title: "Funding deadline extended",
        message: `Invoice ${invoice.invoiceNumber} funding deadline was extended to ${deadlineIso}.`,
      }))
    );
  }
}

export function createInvoiceExtensionService(
  dataSource: DataSource,
  notificationService?: NotificationService
): InvoiceExtensionService {
  return new InvoiceExtensionService(dataSource, notificationService);
}
