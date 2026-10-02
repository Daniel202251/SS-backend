import { DataSource } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";
import { Decimal } from "decimal.js";

export interface AdminMetricsQuery {
  from?: Date | null;
  to?: Date | null;
}

export interface AdminMetricsSummary {
  invoiceStatusCounts: Record<string, number>;
  totalInvoices: number;
  totalFundedVolume: string;
  averageFundingTimeHours: number | null;
  activeUniqueInvestors: number;
  settlementSuccessRatePercent: number;
  window: { from: string | null; to: string | null };
  generatedAt: string;
}

interface CacheEntry {
  value: AdminMetricsSummary;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;

export class AdminMetricsService {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly dataSource: DataSource) {}

  async getMetrics(query: AdminMetricsQuery = {}): Promise<AdminMetricsSummary> {
    const cacheKey = `${query.from?.toISOString() ?? ""}|${query.to?.toISOString() ?? ""}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.value;
    }

    const value = await this.compute(query);
    this.cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  /** Test helper — drop the in-process 60s TTL cache. */
  clearCache(): void {
    this.cache.clear();
  }

  private async compute(query: AdminMetricsQuery): Promise<AdminMetricsSummary> {
    const invoiceRepo = this.dataSource.getRepository(Invoice);
    const investmentRepo = this.dataSource.getRepository(Investment);

    const invoiceQb = invoiceRepo.createQueryBuilder("invoice");
    if (query.from) {
      invoiceQb.andWhere("invoice.createdAt >= :from", { from: query.from });
    }
    if (query.to) {
      invoiceQb.andWhere("invoice.createdAt <= :to", { to: query.to });
    }

    const invoices = await invoiceQb.getMany();

    const invoiceStatusCounts: Record<string, number> = {};
    for (const status of Object.values(InvoiceStatus)) {
      invoiceStatusCounts[status] = 0;
    }
    let totalFundedVolume = new Decimal(0);
    let fundingTimeSumMs = 0;
    let fundingTimeSamples = 0;

    for (const invoice of invoices) {
      invoiceStatusCounts[invoice.status] = (invoiceStatusCounts[invoice.status] ?? 0) + 1;

      if (
        invoice.status === InvoiceStatus.FUNDED ||
        invoice.status === InvoiceStatus.SETTLED
      ) {
        const funded = new Decimal(invoice.fundedAmount ?? "0");
        totalFundedVolume = totalFundedVolume.plus(funded);
        // Prefer updatedAt - createdAt as a proxy for time-to-fund when no
        // dedicated fundedAt column exists.
        const start = invoice.createdAt?.getTime?.() ?? NaN;
        const end = invoice.updatedAt?.getTime?.() ?? NaN;
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          fundingTimeSumMs += end - start;
          fundingTimeSamples += 1;
        }
      }
    }

    const investmentQb = investmentRepo.createQueryBuilder("investment");
    if (query.from) {
      investmentQb.andWhere("investment.createdAt >= :from", { from: query.from });
    }
    if (query.to) {
      investmentQb.andWhere("investment.createdAt <= :to", { to: query.to });
    }
    const investments = await investmentQb.getMany();

    const activeInvestorIds = new Set<string>();
    for (const inv of investments) {
      if (
        inv.status === InvestmentStatus.PENDING ||
        inv.status === InvestmentStatus.CONFIRMED
      ) {
        activeInvestorIds.add(inv.investorId);
      }
    }

    const fundedOrSettled =
      (invoiceStatusCounts[InvoiceStatus.FUNDED] ?? 0) +
      (invoiceStatusCounts[InvoiceStatus.SETTLED] ?? 0);
    const settled = invoiceStatusCounts[InvoiceStatus.SETTLED] ?? 0;
    const settlementSuccessRatePercent =
      fundedOrSettled === 0 ? 0 : Number(((settled / fundedOrSettled) * 100).toFixed(2));

    return {
      invoiceStatusCounts,
      totalInvoices: invoices.length,
      totalFundedVolume: totalFundedVolume.toFixed(4),
      averageFundingTimeHours:
        fundingTimeSamples === 0
          ? null
          : Number((fundingTimeSumMs / fundingTimeSamples / 3_600_000).toFixed(2)),
      activeUniqueInvestors: activeInvestorIds.size,
      settlementSuccessRatePercent,
      window: {
        from: query.from?.toISOString() ?? null,
        to: query.to?.toISOString() ?? null,
      },
      generatedAt: new Date().toISOString(),
    };
  }
}

export function createAdminMetricsService(dataSource: DataSource): AdminMetricsService {
  return new AdminMetricsService(dataSource);
}
