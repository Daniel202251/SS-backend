import { DataSource, Repository } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { InvoiceStatus } from "../types/enums";
import { paginateQuery } from "../utils/query-pagination.utils";

export interface MarketplaceFilters {
  status?: InvoiceStatus[];
  dueBefore?: Date;
  minAmount?: number;
  maxAmount?: number;
  sort?: "due_date" | "discount_rate" | "amount" | "created_at";
  sortOrder?: "ASC" | "DESC";
  search?: string;
}

export interface PaginationOptions {
  page: number;
  limit: number;
}

export interface PublicInvoice {
  id: string;
  invoiceId?: string;
  invoiceNumber: string;
  customerName: string;
  sellerName?: string;
  amount: string;
  faceValue?: string;
  fundingTarget?: string;
  amountRaised?: string;
  fundedAmount?: string;
  discountRate: string;
  yieldBps?: number;
  fundingPercentage?: number;
  netAmount: string;
  dueDate: Date;
  fundingDeadline?: Date;
  status: InvoiceStatus;
  createdAt: Date;
  // Excluded: sellerId, ipfsHash, riskScore, smartContractId, updatedAt, deletedAt
}

export interface MarketplaceResponse {
  data: PublicInvoice[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface CursorPaginationOptions {
  /** Column to sort/page by. Must be one of the marketplace's supported sort
   *  fields so the cursor and `ORDER BY` stay consistent. */
  sortField: "due_date" | "discount_rate" | "amount" | "created_at";
  order?: "ASC" | "DESC";
  limit: number;
  cursor?: string | null;
}

export interface MarketplaceCursorPage {
  data: PublicInvoice[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface MarketplaceRepositoryContract {
  findPublishedInvoices(
    filters: MarketplaceFilters,
    pagination: PaginationOptions
  ): Promise<{ invoices: Invoice[]; total: number }>;
  /**
   * Optional so that existing fake repositories implementing this contract
   * (in tests predating this method) continue to satisfy the interface
   * without modification. Only `getPublishedInvoicesByCursor` requires it,
   * and it throws a clear error if a given repository doesn't implement it.
   */
  findPublishedInvoicesByCursor?(
    filters: MarketplaceFilters,
    pagination: CursorPaginationOptions
  ): Promise<{ invoices: Invoice[]; nextCursor: string | null; hasMore: boolean }>;
}

export interface MarketplaceServiceDependencies {
  marketplaceRepository: MarketplaceRepositoryContract;
}

export class MarketplaceService {
  private readonly marketplaceRepository: MarketplaceRepositoryContract;

  constructor(dependencies: MarketplaceServiceDependencies) {
    this.marketplaceRepository = dependencies.marketplaceRepository;
  }

  async getPublishedInvoices(
    filters: MarketplaceFilters = {},
    pagination: PaginationOptions = { page: 1, limit: 20 }
  ): Promise<MarketplaceResponse> {
    // Set default filters
    const normalizedFilters: MarketplaceFilters = {
      status: filters.status || [InvoiceStatus.PUBLISHED],
      dueBefore: filters.dueBefore,
      minAmount: filters.minAmount,
      maxAmount: filters.maxAmount,
      sort: filters.sort || "amount",
      sortOrder: filters.sortOrder || "DESC",
      search: filters.search,
    };

    // Validate pagination
    const normalizedPagination: PaginationOptions = {
      page: Math.max(1, pagination.page),
      limit: Math.min(100, Math.max(1, pagination.limit)), // Max 100 items per page
    };

    const { invoices, total } = await this.marketplaceRepository.findPublishedInvoices(
      normalizedFilters,
      normalizedPagination
    );

    const publicInvoices: PublicInvoice[] = invoices.map(this.toPublicInvoice);

    return {
      data: publicInvoices,
      meta: {
        total,
        page: normalizedPagination.page,
        limit: normalizedPagination.limit,
        totalPages: Math.ceil(total / normalizedPagination.limit),
      },
    };
  }

  /**
   * Cursor-paginated variant of `getPublishedInvoices`, for consumers that
   * need stable keyset pagination (e.g. infinite-scroll clients) instead of
   * offset/page-based pagination. Additive: does not replace or change the
   * behaviour of the existing offset-based `getPublishedInvoices` method or
   * its route, so existing callers/tests are unaffected.
   */
  async getPublishedInvoicesByCursor(
    filters: MarketplaceFilters = {},
    pagination: CursorPaginationOptions
  ): Promise<MarketplaceCursorPage> {
    const normalizedFilters: MarketplaceFilters = {
      status: filters.status || [InvoiceStatus.PUBLISHED],
      dueBefore: filters.dueBefore,
      minAmount: filters.minAmount,
      maxAmount: filters.maxAmount,
      search: filters.search,
    };

    const limit = Math.min(100, Math.max(1, pagination.limit));

    if (!this.marketplaceRepository.findPublishedInvoicesByCursor) {
      throw new Error(
        "getPublishedInvoicesByCursor: the configured MarketplaceRepositoryContract does not implement findPublishedInvoicesByCursor"
      );
    }

    const { invoices, nextCursor, hasMore } =
      await this.marketplaceRepository.findPublishedInvoicesByCursor(normalizedFilters, {
        sortField: pagination.sortField,
        order: pagination.order ?? "DESC",
        limit,
        cursor: pagination.cursor ?? null,
      });

    return {
      data: invoices.map(this.toPublicInvoice),
      nextCursor,
      hasMore,
    };
  }

  private toPublicInvoice(invoice: Invoice): PublicInvoice {
    const target = parseFloat(invoice.netAmount || invoice.amount || "0");
    const raised = parseFloat(invoice.fundedAmount || "0");
    const fundingPercentage = target > 0 ? Math.min(100, Math.round((raised / target) * 10000) / 100) : 0;
    const yieldBps = Math.round(parseFloat(invoice.discountRate || "0") * 100);

    return {
      id: invoice.id,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerName: invoice.customerName,
      sellerName:
        (invoice.seller as { businessName?: string; name?: string } | undefined)?.businessName ||
        (invoice.seller as { businessName?: string; name?: string } | undefined)?.name ||
        invoice.customerName,
      amount: invoice.amount,
      faceValue: invoice.amount,
      fundingTarget: invoice.netAmount || invoice.amount,
      amountRaised: invoice.fundedAmount || "0",
      fundedAmount: invoice.fundedAmount || "0",
      discountRate: invoice.discountRate,
      yieldBps,
      fundingPercentage,
      netAmount: invoice.netAmount,
      dueDate: invoice.dueDate,
      fundingDeadline: invoice.dueDate,
      status: invoice.status,
      createdAt: invoice.createdAt,
    };
  }
}

class TypeORMMarketplaceRepository implements MarketplaceRepositoryContract {
  private readonly repository: Repository<Invoice>;

  constructor(repository: Repository<Invoice>) {
    this.repository = repository;
  }

  async findPublishedInvoices(
    filters: MarketplaceFilters,
    pagination: PaginationOptions
  ): Promise<{ invoices: Invoice[]; total: number }> {
    const queryBuilder = this.repository
      .createQueryBuilder("invoice")
      .where("invoice.deleted_at IS NULL");

    // Apply status filter
    if (filters.status && filters.status.length > 0) {
      queryBuilder.andWhere("invoice.status IN (:...statuses)", {
        statuses: filters.status,
      });
    }

    // Apply date filter
    if (filters.dueBefore) {
      queryBuilder.andWhere("invoice.due_date <= :dueBefore", {
        dueBefore: filters.dueBefore,
      });
    }

    // Apply amount filters
    if (filters.minAmount !== undefined) {
      queryBuilder.andWhere("CAST(invoice.amount AS DECIMAL) >= :minAmount", {
        minAmount: filters.minAmount,
      });
    }

    if (filters.maxAmount !== undefined) {
      queryBuilder.andWhere("CAST(invoice.amount AS DECIMAL) <= :maxAmount", {
        maxAmount: filters.maxAmount,
      });
    }

    // Apply search filter (case-insensitive match on customer_name)
    if (filters.search) {
      queryBuilder.andWhere("LOWER(invoice.customer_name) LIKE :search", {
        search: `%${filters.search.toLowerCase()}%`,
      });
    }

    // Apply sorting with stable ordering
    const sortColumn = this.getSortColumn(filters.sort || "due_date");
    queryBuilder.orderBy(sortColumn, filters.sortOrder || "ASC");
    queryBuilder.addOrderBy("invoice.id", "ASC"); // Stable sort

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const offset = (pagination.page - 1) * pagination.limit;
    queryBuilder.skip(offset).take(pagination.limit);

    const invoices = await queryBuilder.getMany();

    return { invoices, total };
  }

  private getSortColumn(sort: string): string {
    const sortMap: Record<string, string> = {
      due_date: "invoice.due_date",
      discount_rate: "invoice.discount_rate",
      amount: "invoice.amount",
      created_at: "invoice.created_at",
    };

    return sortMap[sort] || "invoice.due_date";
  }

  /**
   * Same sort-field mapping as `getSortColumn`, but using the Invoice
   * entity's camelCase property names (e.g. "invoice.dueDate") rather than
   * raw snake_case DB column names. `paginateQuery` needs the entity
   * property name because it reads the cursor value back off the returned
   * entity object (`row[column]`), which is keyed by TypeORM property name,
   * not the underlying SQL column.
   */
  private getCursorSortField(sort: string): string {
    const sortMap: Record<string, string> = {
      due_date: "invoice.dueDate",
      discount_rate: "invoice.discountRate",
      amount: "invoice.amount",
      created_at: "invoice.createdAt",
    };

    return sortMap[sort] || "invoice.dueDate";
  }

  async findPublishedInvoicesByCursor(
    filters: MarketplaceFilters,
    pagination: CursorPaginationOptions
  ): Promise<{ invoices: Invoice[]; nextCursor: string | null; hasMore: boolean }> {
    const queryBuilder = this.repository
      .createQueryBuilder("invoice")
      .where("invoice.deleted_at IS NULL");

    if (filters.status && filters.status.length > 0) {
      queryBuilder.andWhere("invoice.status IN (:...statuses)", {
        statuses: filters.status,
      });
    }

    if (filters.dueBefore) {
      queryBuilder.andWhere("invoice.due_date <= :dueBefore", {
        dueBefore: filters.dueBefore,
      });
    }

    if (filters.minAmount !== undefined) {
      queryBuilder.andWhere("CAST(invoice.amount AS DECIMAL) >= :minAmount", {
        minAmount: filters.minAmount,
      });
    }

    if (filters.maxAmount !== undefined) {
      queryBuilder.andWhere("CAST(invoice.amount AS DECIMAL) <= :maxAmount", {
        maxAmount: filters.maxAmount,
      });
    }

    if (filters.search) {
      queryBuilder.andWhere("LOWER(invoice.customer_name) LIKE :search", {
        search: `%${filters.search.toLowerCase()}%`,
      });
    }

    const cursorField = this.getCursorSortField(pagination.sortField);

    const { items, nextCursor, hasMore } = await paginateQuery<Invoice>({
      queryBuilder,
      cursorField,
      order: pagination.order ?? "DESC",
      limit: pagination.limit,
      cursor: pagination.cursor ?? null,
    });

    return { invoices: items, nextCursor, hasMore };
  }
}

export function createMarketplaceService(dataSource: DataSource): MarketplaceService {
  const invoiceRepository = dataSource.getRepository(Invoice);
  const marketplaceRepository = new TypeORMMarketplaceRepository(invoiceRepository);

  return new MarketplaceService({
    marketplaceRepository,
  });
}
