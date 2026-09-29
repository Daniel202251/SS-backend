import { DataSource, In, LessThan, IsNull, type SelectQueryBuilder, type FindOptionsWhere } from "typeorm";
import Decimal from "decimal.js";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { User } from "../models/User.model";
import { InvoiceStatus, KYCStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { validateInvoiceForPublish } from "../lib/validate-invoice-for-publish";
import {
  createInvoiceStateMachine,
  entityManagerTransitionStore,
  type InvoiceStateMachine,
  type InvoiceTransition,
  type NotificationSink,
  type TransitionOptions,
} from "../lib/invoice-state-machine";
import { InvoiceStatusHistory } from "../models/InvoiceStatusHistory.model";
import { logger } from "../observability/logger";
import { AppError } from "../utils/http-error";
import type { IPFSService, IPFSUploadResult } from "./ipfs.service";
import { decodeInvoiceCursor, encodeInvoiceCursor } from "../utils/invoice-cursor.utils";

export interface InvoiceRepositoryContract {
  findOne(options: { where: { id: string }; relations?: string[] }): Promise<Invoice | null>;
  findOneBy(options: { id?: string; invoiceNumber?: string }): Promise<Invoice | null>;
  find(options: {
    where: FindOptionsWhere<Invoice> | FindOptionsWhere<Invoice>[];
    skip?: number;
    take?: number;
    order?: { [key: string]: "ASC" | "DESC" };
    relations?: string[];
  }): Promise<Invoice[]>;
  save(invoice: Invoice): Promise<Invoice>;
  count(options: { where: FindOptionsWhere<Invoice> | FindOptionsWhere<Invoice>[] }): Promise<number>;
  create(data: Partial<Invoice>): Invoice;
  createQueryBuilder?(alias?: string): SelectQueryBuilder<Invoice>;
}

// Kept exported from here for existing importers; defined alongside the
// state machine whose side effects use it.
export type { NotificationSink } from "../lib/invoice-state-machine";

export interface InvoiceServiceDependencies {
  invoiceRepository: InvoiceRepositoryContract;
  ipfsService: IPFSService;
  dataSource?: DataSource;
  /** Optional: lets status transitions notify the seller. If omitted,
   *  transitions still persist but skip notifying. */
  notificationSink?: NotificationSink;
  /** Optional: overrides the default state machine (mainly for tests). */
  stateMachine?: InvoiceStateMachine;
}

export interface UploadDocumentInput {
  invoiceId: string;
  sellerId: string;
  fileBuffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface UploadDocumentResult {
  invoiceId: string;
  ipfsHash: string;
  fileSize: number;
  uploadedAt: string;
}

export interface CreateInvoiceInput {
  sellerId: string;
  invoiceNumber: string;
  customerName: string;
  amount: string;
  discountRate: string;
  dueDate: Date;
  ipfsHash?: string;
  riskScore?: string;
}

export interface UpdateInvoiceInput {
  sellerId: string;
  invoiceId: string;
  customerName?: string;
  amount?: string;
  discountRate?: string;
  dueDate?: Date;
  riskScore?: string;
}

export interface PublishInvoiceInput {
  invoiceId: string;
  sellerId: string;
}

export interface RejectInvoiceInput {
  invoiceId: string;
  rejectionReason: string;
  /** Admin identifier recorded in the status history, when known. */
  actorId?: string;
}

export interface SubmitInvoiceForReviewInput {
  invoiceId: string;
  sellerId: string;
}

export interface ApproveInvoiceInput {
  invoiceId: string;
  actorId?: string;
}

export interface InvoiceStatusHistoryDTO {
  id: string;
  fromStatus: InvoiceStatus;
  toStatus: InvoiceStatus;
  actorRole: string;
  actorId: string | null;
  trigger: string;
  reason: string | null;
  createdAt: Date;
}

export interface BatchPublishInvoicesInput {
  invoiceIds: string[];
  sellerId: string;
}

/** Why a single invoice in a batch could not be published. */
export interface BatchPublishRejection {
  invoiceId: string;
  code:
    | "invoice_not_found"
    | "unauthorized_invoice_access"
    | "invalid_status_transition"
    | "invoice_not_publishable";
  message: string;
}

export interface BatchPublishInvoicesResult {
  published: InvoiceDTO[];
  count: number;
}

export interface CommitmentDTO {
  investor_wallet: string;
  amount: string;
  share_percent: string;
}

export interface InvoiceDTO {
  id: string;
  sellerId: string;
  invoiceNumber: string;
  customerName: string;
  amount: string;
  discountRate: string;
  netAmount: string;
  dueDate: Date;
  status: InvoiceStatus;
  ipfsHash: string | null;
  riskScore: string | null;
  smartContractId: string | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  commitments?: CommitmentDTO[];
}

export interface GetInvoicesOptions {
  sellerId: string;
  status?: InvoiceStatus;
  skip?: number;
  take?: number;
  cursor?: string | null;
  limit?: number;
}

export class InvoiceService {
  private readonly invoiceRepository: InvoiceRepositoryContract;
  private readonly ipfsService: IPFSService;
  private readonly dataSource?: DataSource;
  private readonly stateMachine: InvoiceStateMachine;

  constructor(dependencies: InvoiceServiceDependencies) {
    this.invoiceRepository = dependencies.invoiceRepository;
    this.ipfsService = dependencies.ipfsService;
    this.dataSource = dependencies.dataSource;
    this.stateMachine =
      dependencies.stateMachine ??
      createInvoiceStateMachine({ notificationSink: dependencies.notificationSink });
  }

  /**
   * Calculate net_amount from amount and discount_rate
   * Formula: net_amount = amount - (amount * discount_rate / 100)
   *
   * Uses Decimal (as the rest of this file's money math already does in
   * getInvoiceTokenHolders) rather than native floats: parseFloat-based
   * arithmetic here silently rounded some amount/discountRate combinations
   * to the wrong cent — e.g. amount="29.99", discountRate="0.5" produced
   * "29.8400" instead of the correct "29.8401" — because IEEE-754 doubles
   * can't represent most decimal fractions exactly.
   * Validates inputs to prevent NaN/Infinity propagation under load.
   */
  private calculateNetAmount(amount: string, discountRate: string): string {
    try {
      const amt = new Decimal(amount);
      const disc = new Decimal(discountRate);
      if (
        !amt.isFinite() ||
        !disc.isFinite() ||
        amt.isNegative() ||
        disc.isNegative() ||
        disc.gt(100)
      ) {
        throw new ServiceError("invalid_amount", "Invalid amount or discount rate", 400);
      }
      const netAmount = amt.minus(amt.times(disc.dividedBy(100)));
      return netAmount.toFixed(4);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      logger.error("Failed to calculate net amount", { error, amount, discountRate });
      throw new ServiceError("invalid_amount", "Invalid amount or discount rate", 400);
    }
  }

  private sanitizeInvoiceNumber(value: string): string {
    return value.trim().slice(0, 64);
  }

  /**
   * Applies a status transition and its history row atomically, then runs
   * the transition's side effects once the write has committed.
   */
  private async applyTransition(
    invoice: Invoice,
    to: InvoiceStatus,
    options: TransitionOptions
  ): Promise<Invoice> {
    let transition: InvoiceTransition;
    if (this.dataSource) {
      transition = await this.dataSource.transaction((manager) =>
        this.stateMachine.transition(entityManagerTransitionStore(manager), invoice, to, options)
      );
    } else {
      transition = await this.stateMachine.transition(
        { saveInvoice: (entity) => this.invoiceRepository.save(entity) },
        invoice,
        to,
        options
      );
    }

    await this.stateMachine.dispatch(transition);
    return transition.invoice;
  }

  private async findInvoiceWithSeller(invoiceId: string): Promise<Invoice> {
    const invoice = await this.invoiceRepository.findOne({
      where: { id: invoiceId },
      relations: ["seller"],
    });
    if (!invoice) {
      throw new ServiceError("invoice_not_found", "Invoice not found", 404);
    }
    return invoice;
  }

  /**
   * Create a new invoice - hardened with input sanitization, precise math,
   * and resilient error handling for downstream DB failures.
   */
  async createInvoice(input: CreateInvoiceInput): Promise<InvoiceDTO> {
    try {
      const invoiceNumber = this.sanitizeInvoiceNumber(input.invoiceNumber);
      if (!invoiceNumber) {
        throw new ServiceError("invalid_invoice_number", "Invoice number is required", 400);
      }

      const existing = await this.invoiceRepository.findOneBy({
        invoiceNumber,
      });

      if (existing) {
        throw new ServiceError("invoice_number_exists", "Invoice number must be unique", 409);
      }

      const netAmount = this.calculateNetAmount(input.amount, input.discountRate);

      const invoice = this.invoiceRepository.create({
        sellerId: input.sellerId,
        invoiceNumber,
        customerName: input.customerName.trim().slice(0, 255),
        amount: input.amount,
        discountRate: input.discountRate,
        netAmount,
        dueDate: input.dueDate,
        ipfsHash: input.ipfsHash?.trim() || null,
        riskScore: input.riskScore?.trim() || null,
        status: InvoiceStatus.DRAFT,
      } as Partial<Invoice>);

      const saved = await this.invoiceRepository.save(invoice);
      return this.toDTO(saved);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      logger.error("Failed to create invoice", { error, sellerId: input.sellerId });
      throw new ServiceError("invoice_create_failed", "Failed to create invoice", 500);
    }
  }

  /**
   * Get invoice by ID - with graceful handling of DB failures
   */
  async getInvoiceById(invoiceId: string, sellerId?: string): Promise<InvoiceDTO | null> {
    try {
      const sanitizedId = invoiceId.trim();
      if (!sanitizedId) return null;

      const invoice = await this.invoiceRepository.findOne({
        where: { id: sanitizedId },
      });

      if (!invoice) {
        return null;
      }

      if (sellerId && invoice.sellerId !== sellerId) {
        throw new ServiceError(
          "unauthorized_invoice_access",
          "You do not have access to this invoice",
          403
        );
      }

      return this.toDTO(invoice);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      logger.error("Failed to fetch invoice by id", { error, invoiceId });
      throw new ServiceError("invoice_fetch_failed", "Failed to fetch invoice", 500);
    }
  }

  /**
   * Get all invoices for a seller - parallel fetch, input sanitization, and bounded pagination
   */
  async getInvoicesBySellerId(options: GetInvoicesOptions): Promise<{
    invoices: InvoiceDTO[];
    total: number;
    nextCursor: string | null;
    hasMore?: boolean;
  }> {
    try {
      const sellerId = options.sellerId?.trim();
      if (!sellerId) {
        throw new ServiceError("invalid_seller_id", "Seller id is required", 400);
      }

      const where: FindOptionsWhere<Invoice> = {
        sellerId,
        deletedAt: IsNull(),
      };

      const normalizedStatus = options.status
        ? (String(options.status).trim().toLowerCase() as InvoiceStatus)
        : undefined;

      if (normalizedStatus && Object.values(InvoiceStatus).includes(normalizedStatus)) {
        where.status = normalizedStatus;
      }

      // Keyset cursor pagination path
      if (options.cursor !== undefined) {
        const limit = Math.max(1, Math.min(options.limit ?? options.take ?? 20, 100));

        let cursorCreatedAt: Date | undefined;
        let cursorId: string | undefined;

        if (options.cursor && options.cursor.trim()) {
          const decoded = decodeInvoiceCursor(options.cursor);
          if (decoded.id && !decoded.createdAt) {
            const refInvoice = await this.invoiceRepository.findOne({
              where: { id: decoded.id },
            });
            if (!refInvoice) {
              throw new ServiceError("invalid_cursor", "Invoice referenced by cursor not found", 400);
            }
            cursorCreatedAt = refInvoice.createdAt;
            cursorId = refInvoice.id;
          } else {
            cursorCreatedAt = decoded.createdAt;
            cursorId = decoded.id;
          }
        }

        let invoices: Invoice[];

        if (typeof this.invoiceRepository.createQueryBuilder === "function") {
          const qb = this.invoiceRepository.createQueryBuilder("invoice");
          qb.where("invoice.sellerId = :sellerId", { sellerId })
            .andWhere("invoice.deletedAt IS NULL");

          if (normalizedStatus && Object.values(InvoiceStatus).includes(normalizedStatus)) {
            qb.andWhere("invoice.status = :status", { status: normalizedStatus });
          }

          if (cursorCreatedAt && cursorId) {
            qb.andWhere(
              "(invoice.createdAt < :cursorCreatedAt OR (invoice.createdAt = :cursorCreatedAt AND invoice.id < :cursorId))",
              { cursorCreatedAt, cursorId }
            );
          } else if (cursorCreatedAt) {
            qb.andWhere("invoice.createdAt < :cursorCreatedAt", { cursorCreatedAt });
          } else if (cursorId) {
            qb.andWhere("invoice.id < :cursorId", { cursorId });
          }

          qb.orderBy("invoice.createdAt", "DESC")
            .addOrderBy("invoice.id", "DESC")
            .take(limit + 1);

          invoices = await qb.getMany();
        } else {
          let findWhere: FindOptionsWhere<Invoice> | FindOptionsWhere<Invoice>[] = where;
          if (cursorCreatedAt && cursorId) {
            findWhere = [
              { ...where, createdAt: LessThan(cursorCreatedAt) },
              { ...where, createdAt: cursorCreatedAt, id: LessThan(cursorId) },
            ];
          } else if (cursorCreatedAt) {
            findWhere = { ...where, createdAt: LessThan(cursorCreatedAt) };
          } else if (cursorId) {
            findWhere = { ...where, id: LessThan(cursorId) };
          }

          invoices = await this.invoiceRepository.find({
            where: findWhere,
            take: limit + 1,
            order: { createdAt: "DESC", id: "DESC" },
          });
        }

        const hasMore = invoices.length > limit;
        const pageItems = hasMore ? invoices.slice(0, limit) : invoices;
        const total = await this.invoiceRepository.count({ where });

        let nextCursor: string | null = null;
        if (hasMore && pageItems.length > 0) {
          nextCursor = encodeInvoiceCursor(pageItems[pageItems.length - 1]);
        }

        return {
          invoices: pageItems.map((inv) => this.toDTO(inv)),
          total,
          nextCursor,
          hasMore,
        };
      }

      // Legacy offset pagination path
      const skip = Math.max(0, Math.min(options.skip ?? 0, 10000));
      const take = Math.max(1, Math.min(options.take ?? options.limit ?? 20, 100));

      const [invoices, total] = await Promise.all([
        this.invoiceRepository.find({
          where,
          skip,
          take,
          order: { createdAt: "DESC" },
        }),
        this.invoiceRepository.count({ where }),
      ]);

      return {
        invoices: invoices.map((inv) => this.toDTO(inv)),
        total,
        nextCursor: null,
        hasMore: skip + invoices.length < total,
      };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      logger.error("Failed to fetch invoices by seller", { error, sellerId: options.sellerId });
      throw new ServiceError("invoice_list_failed", "Failed to fetch invoices", 500);
    }
  }

  /**
   * Update an invoice (only draft invoices can be updated)
   */
  async updateInvoice(input: UpdateInvoiceInput): Promise<InvoiceDTO> {
    try {
      const invoice = await this.invoiceRepository.findOne({
        where: { id: input.invoiceId },
      });

      if (!invoice) {
        throw new ServiceError("invoice_not_found", "Invoice not found", 404);
      }

      // Verify ownership
      if (invoice.sellerId !== input.sellerId) {
        throw new ServiceError(
          "unauthorized_invoice_access",
          "You can only update your own invoices",
          403
        );
      }

      // Only draft invoices can be updated
      if (invoice.status !== InvoiceStatus.DRAFT) {
        throw new ServiceError(
          "invalid_invoice_status",
          `Cannot update invoice in ${invoice.status} status. Only draft invoices can be updated.`,
          400
        );
      }

      // Update fields
      if (input.customerName) {
        invoice.customerName = input.customerName;
      }
      if (input.amount) {
        invoice.amount = input.amount;
        invoice.discountRate = input.discountRate || invoice.discountRate;
        invoice.netAmount = this.calculateNetAmount(invoice.amount, invoice.discountRate);
      } else if (input.discountRate) {
        invoice.discountRate = input.discountRate;
        invoice.netAmount = this.calculateNetAmount(invoice.amount, invoice.discountRate);
      }
      if (input.dueDate) {
        invoice.dueDate = input.dueDate;
      }
      if (input.riskScore) {
        invoice.riskScore = input.riskScore;
      }

      const updated = await this.invoiceRepository.save(invoice);
      return this.toDTO(updated);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      logger.error('Failed to process', { error });
      throw new AppError(500, 'Processing failed', 'PROCESSING_FAILED', { error });
    }
  }

  /**
   * Soft delete an invoice
   */
  async deleteInvoice(invoiceId: string, sellerId: string): Promise<void> {
    try {
      const invoice = await this.invoiceRepository.findOne({
        where: { id: invoiceId },
      });

      if (!invoice) {
        throw new ServiceError("invoice_not_found", "Invoice not found", 404);
      }

      // Verify ownership
      if (invoice.sellerId !== sellerId) {
        throw new ServiceError(
          "unauthorized_invoice_access",
          "You can only delete your own invoices",
          403
        );
      }

      // Only draft and cancelled invoices can be deleted
      if (invoice.status !== InvoiceStatus.DRAFT && invoice.status !== InvoiceStatus.CANCELLED) {
        throw new ServiceError(
          "invalid_invoice_status",
          `Cannot delete invoice in ${invoice.status} status`,
          400
        );
      }

      invoice.deletedAt = new Date();
      await this.invoiceRepository.save(invoice);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      logger.error('Failed to process', { error });
      throw new AppError(500, 'Processing failed', 'PROCESSING_FAILED', { error });
    }
  }

  /**
   * Publish an invoice (transition from DRAFT to PUBLISHED)
   */
  async publishInvoice(input: PublishInvoiceInput): Promise<InvoiceDTO> {
    try {
      const invoice = await this.invoiceRepository.findOne({
        where: { id: input.invoiceId },
        relations: ["seller"],
      });

      if (!invoice) {
        throw new ServiceError("invoice_not_found", "Invoice not found", 404);
      }

      // Verify ownership
      if (invoice.sellerId !== input.sellerId) {
        throw new ServiceError(
          "unauthorized_invoice_access",
          "You can only publish your own invoices",
          403
        );
      }

      // Check KYC status
      const seller = invoice.seller as unknown as User;
      if (!seller || seller.kycStatus !== KYCStatus.APPROVED) {
        throw new ServiceError(
          "kyc_approval_required",
          "KYC approval is required to publish invoices",
          403
        );
      }

      // Graph, ownership and pre-publish validation are all enforced by the
      // state machine.
      const updated = await this.applyTransition(invoice, InvoiceStatus.PUBLISHED, {
        actor: { role: "seller", id: input.sellerId, wallet: seller.stellarAddress },
        trigger: "seller_published",
      });

      return this.toDTO(updated);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      logger.error('Failed to process', { error });
      throw new AppError(500, 'Processing failed', 'PROCESSING_FAILED', { error });
    }
  }

  /**
   * Reject a draft or pending invoice (admin operation). The seller is
   * notified by the state machine's side effects.
   */
  async rejectInvoice(input: RejectInvoiceInput): Promise<InvoiceDTO> {
    const invoiceId = input.invoiceId?.trim();
    const rejectionReason = input.rejectionReason?.trim();

    if (!invoiceId) {
      throw new ServiceError("invalid_invoice_id", "Invoice id is required", 400);
    }
    if (!rejectionReason) {
      throw new ServiceError("invalid_rejection_reason", "Rejection reason is required", 400);
    }

    const invoice = await this.findInvoiceWithSeller(invoiceId);

    if (invoice.status === InvoiceStatus.REJECTED) {
      throw new ServiceError("invoice_already_rejected", "Invoice has already been rejected", 409);
    }

    try {
      const updated = await this.applyTransition(invoice, InvoiceStatus.REJECTED, {
        actor: { role: "admin", id: input.actorId ?? null },
        trigger: "admin_rejected",
        context: { reason: rejectionReason },
      });

      return this.toDTO(updated);
    } catch (err) {
      if (err instanceof ServiceError && err.code === "invalid_status_transition") {
        throw new ServiceError(err.code, err.message, 409, err.details);
      }
      throw err;
    }
  }

  /**
   * Seller submits a draft for admin review (draft → pending).
   */
  async submitInvoiceForReview(input: SubmitInvoiceForReviewInput): Promise<InvoiceDTO> {
    const invoice = await this.findInvoiceWithSeller(input.invoiceId);

    if (invoice.sellerId !== input.sellerId) {
      throw new ServiceError("invoice_not_found", "Invoice not found", 404);
    }

    const seller = invoice.seller as unknown as User | undefined;
    const updated = await this.applyTransition(invoice, InvoiceStatus.PENDING, {
      actor: { role: "seller", id: input.sellerId, wallet: seller?.stellarAddress ?? null },
      trigger: "seller_submitted",
    });

    return this.toDTO(updated);
  }

  /**
   * Admin approves an invoice under review, making it live (pending → published).
   */
  async approveInvoice(input: ApproveInvoiceInput): Promise<InvoiceDTO> {
    const invoice = await this.findInvoiceWithSeller(input.invoiceId);

    const updated = await this.applyTransition(invoice, InvoiceStatus.PUBLISHED, {
      actor: { role: "admin", id: input.actorId ?? null },
      trigger: "admin_approved",
    });

    return this.toDTO(updated);
  }

  /**
   * Status transition history for one of the seller's invoices, oldest first.
   */
  async getInvoiceStatusHistory(
    invoiceId: string,
    sellerId: string
  ): Promise<InvoiceStatusHistoryDTO[]> {
    const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId } });
    if (!invoice || invoice.sellerId !== sellerId) {
      throw new ServiceError("invoice_not_found", "Invoice not found", 404);
    }

    if (!this.dataSource) {
      return [];
    }

    const rows = await this.dataSource.getRepository(InvoiceStatusHistory).find({
      where: { invoiceId },
      order: { createdAt: "ASC" },
    });

    return rows.map((row) => ({
      id: row.id,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      actorRole: row.actorRole,
      actorId: row.actorId,
      trigger: row.trigger,
      reason: row.reason,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Publish several draft invoices in one atomic step.
   *
   * Sellers with large receivable books were publishing twenty invoices with
   * twenty round trips, and a failure halfway through left them with a
   * half-published book and no clear way to tell which half. This is all or
   * nothing: every invoice is validated first, and if any one of them fails
   * the whole batch is rejected and nothing is written.
   *
   * The rejection list names every invoice that failed and why, so the seller
   * can fix all of them in one pass rather than rediscovering the next problem
   * on each retry.
   */
  async publishInvoicesBatch(
    input: BatchPublishInvoicesInput
  ): Promise<BatchPublishInvoicesResult> {
    const { invoiceIds, sellerId } = input;

    if (invoiceIds.length === 0) {
      throw new ServiceError("empty_batch", "At least one invoice id is required", 400);
    }

    const uniqueIds = [...new Set(invoiceIds)];

    if (!this.dataSource) {
      throw new ServiceError(
        "batch_publish_unavailable",
        "Batch publishing requires a database connection",
        503
      );
    }

    // The seller's wallet is captured alongside each invoice because the
    // lifecycle log needs it after the write, once the relation may no longer
    // be loaded on the saved entity.
    const publishable: Array<{ invoice: Invoice; sellerWallet: string }> = [];
    const rejections: BatchPublishRejection[] = [];

    // Batch fetch: single query with In(uniqueIds) avoids N round-trips
    let fetched: Array<{ invoiceId: string; invoice: Invoice | null }>;
    try {
      const invoices = await this.invoiceRepository.find({
        where: { id: In(uniqueIds) },
        relations: ["seller"],
      });
      const byId = new Map(invoices.map((inv) => [inv.id, inv]));
      fetched = uniqueIds.map((invoiceId) => ({
        invoiceId,
        invoice: byId.get(invoiceId) ?? null,
      }));
    } catch (error) {
      logger.error("Failed to fetch batch invoices", { error, sellerId });
      throw new ServiceError(
        "batch_fetch_failed",
        "Failed to fetch invoices for batch publish",
        500
      );
    }

    for (const { invoiceId, invoice } of fetched) {
      if (!invoice) {
        rejections.push({
          invoiceId,
          code: "invoice_not_found",
          message: "Invoice not found",
        });
        continue;
      }

      if (invoice.sellerId !== sellerId) {
        rejections.push({
          invoiceId,
          code: "unauthorized_invoice_access",
          message: "Invoice not found",
        });
        continue;
      }

      const seller = invoice.seller as unknown as User;
      if (!seller || seller.kycStatus !== KYCStatus.APPROVED) {
        throw new ServiceError(
          "kyc_approval_required",
          "KYC approval is required to publish invoices",
          403
        );
      }

      if (invoice.status !== InvoiceStatus.DRAFT) {
        rejections.push({
          invoiceId,
          code: "invalid_status_transition",
          message: `Cannot publish an invoice in status ${invoice.status}; only drafts can be published`,
        });
        continue;
      }

      const validationErrors = validateInvoiceForPublish(invoice);
      if (validationErrors.length > 0) {
        rejections.push({
          invoiceId,
          code: "invoice_not_publishable",
          message: `Invoice failed pre-publish validation: ${validationErrors.map((e) => e.message).join(" ")}`,
        });
        continue;
      }

      publishable.push({ invoice, sellerWallet: seller.stellarAddress });
    }

    if (rejections.length > 0) {
      throw new ServiceError(
        "batch_publish_rejected",
        `${rejections.length} of ${uniqueIds.length} invoices cannot be published; no invoices were changed`,
        400,
        { rejections }
      );
    }

    // Nothing is written until every invoice has passed, so a failure inside
    // the transaction rolls the whole batch back rather than leaving a partial
    // publish behind.
    const transitions = await this.dataSource.transaction(async (manager) => {
      const store = entityManagerTransitionStore(manager);
      const results: InvoiceTransition[] = [];
      for (const { invoice, sellerWallet } of publishable) {
        results.push(
          await this.stateMachine.transition(store, invoice, InvoiceStatus.PUBLISHED, {
            actor: { role: "seller", id: sellerId, wallet: sellerWallet },
            trigger: "seller_batch_published",
          })
        );
      }
      return results;
    });

    for (const transition of transitions) {
      await this.stateMachine.dispatch(transition);
    }
    const saved = transitions.map((transition) => transition.invoice);

    return {
      published: saved.map((invoice) => this.toDTO(invoice)),
      count: saved.length,
    };
  }

  /**
   * Upload document (IPFS) - hardened with size/type pre-check, graceful IPFS failure handling
   */
  async uploadDocument(input: UploadDocumentInput): Promise<UploadDocumentResult> {
    try {
      const invoiceId = input.invoiceId?.trim();
      const sellerId = input.sellerId?.trim();
      if (!invoiceId || !sellerId) {
        throw new ServiceError("invalid_input", "Invoice id and seller id are required", 400);
      }
      if (!input.fileBuffer || input.fileBuffer.length === 0) {
        throw new ServiceError("empty_file", "File buffer is empty", 400);
      }

      const invoice = await this.invoiceRepository.findOne({
        where: { id: invoiceId },
      });
      if (!invoice) {
        throw new ServiceError("invoice_not_found", "Invoice not found", 404);
      }

      if (invoice.sellerId !== sellerId) {
        throw new ServiceError(
          "unauthorized_invoice_access",
          "You can only upload documents to your own invoices",
          403
        );
      }

      let uploadResult: IPFSUploadResult;
      try {
        uploadResult = await this.ipfsService.uploadFile(
          input.fileBuffer,
          input.filename.trim(),
          input.mimeType.trim(),
          invoiceId
        );
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        logger.error("IPFS upload failed", { error, invoiceId });
        throw new ServiceError("ipfs_upload_failed", "Failed to upload document to IPFS", 502);
      }

      invoice.ipfsHash = uploadResult.hash;
      await this.invoiceRepository.save(invoice);

      return {
        invoiceId,
        ipfsHash: uploadResult.hash,
        fileSize: uploadResult.size,
        uploadedAt: uploadResult.timestamp,
      };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      logger.error("Failed to process document upload", { error, invoiceId: input.invoiceId });
      throw new ServiceError("document_upload_failed", "Failed to process document upload", 500);
    }
  }

  /**
   * Get all token holders for a published invoice with their token balances and percentage shares
   */
  async getInvoiceTokenHolders(invoiceId: string, sellerId: string): Promise<
    Array<{
      wallet: string;
      amount: string;
      share_percent: string;
      committed_at: Date;
    }>
  > {
    const invoice = await this.invoiceRepository.findOne({
      where: { id: invoiceId },
    });

    if (!invoice) {
      throw new ServiceError("invoice_not_found", "Invoice not found", 404);
    }

    if (invoice.sellerId !== sellerId) {
      throw new ServiceError("unauthorized_invoice_access", "You can only view investors for your own invoices", 403);
    }

    if (invoice.status === InvoiceStatus.DRAFT) {
      throw new ServiceError(
        "invalid_invoice_status",
        "Token holders can only be queried for published invoices",
        400
      );
    }

    if (!this.dataSource) {
      throw new ServiceError("internal_error", "Database connection unavailable", 500);
    }

    const investmentRepository = this.dataSource.getRepository(Investment);

    const investments = await investmentRepository
      .createQueryBuilder("investment")
      .leftJoinAndSelect("investment.investor", "investor")
      .where("investment.invoiceId = :invoiceId", { invoiceId })
      .andWhere("investment.deletedAt IS NULL")
      .getMany();

    if (investments.length === 0) {
      return [];
    }

    const totalInvested = investments.reduce(
      (sum, inv) => sum.plus(new Decimal(inv.investmentAmount)),
      new Decimal(0)
    );

    return investments.map((investment) => {
      const investor = investment.investor as unknown as User;
      const percentage = totalInvested.isZero()
        ? new Decimal(0)
        : new Decimal(investment.investmentAmount)
            .dividedBy(totalInvested)
            .times(100)
            .toDecimalPlaces(2);

      const address = investor.stellarAddress || "";
      const truncatedWallet = address.length > 8 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;

      return {
        wallet: truncatedWallet,
        amount: investment.investmentAmount,
        share_percent: percentage.toFixed(2),
        committed_at: investment.createdAt,
      };
    });
  }

  /**
   * Get on-chain escrow status for an invoice
   */
  async getInvoiceEscrowStatus(invoiceId: string): Promise<{
    invoiceId: string;
    hasEscrow: boolean;
    contractId: string | null;
    status: string | null;
  }> {
    const invoice = await this.invoiceRepository.findOne({
      where: { id: invoiceId },
    });

    if (!invoice) {
      throw new ServiceError("invoice_not_found", "Invoice not found", 404);
    }

    if (!invoice.smartContractId) {
      throw new ServiceError(
        "no_escrow_contract",
        "This invoice does not have a deployed escrow contract",
        404
      );
    }

    return {
      invoiceId: invoice.id,
      hasEscrow: true,
      contractId: invoice.smartContractId,
      status: invoice.status,
    };
  }

  /**
   * Convert Invoice model to DTO
   */
  private toDTO(invoice: Invoice): InvoiceDTO {
    return {
      id: invoice.id,
      sellerId: invoice.sellerId,
      invoiceNumber: invoice.invoiceNumber,
      customerName: invoice.customerName,
      amount: invoice.amount,
      discountRate: invoice.discountRate,
      netAmount: invoice.netAmount,
      dueDate: invoice.dueDate,
      status: invoice.status,
      ipfsHash: invoice.ipfsHash,
      riskScore: invoice.riskScore,
      smartContractId: invoice.smartContractId,
      rejectionReason: invoice.rejectionReason ?? null,
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt,
    };
  }
}

export function createInvoiceService(
  dataSource: DataSource,
  ipfsService: IPFSService,
  notificationSink?: NotificationSink
): InvoiceService {
  const invoiceRepository = dataSource.getRepository(Invoice);

  return new InvoiceService({
    invoiceRepository,
    ipfsService,
    dataSource,
    notificationSink,
  });
}
