import { DataSource, Repository } from "typeorm";
import { RoyaltyEvent } from "../models/RoyaltyEvent.model";
import { logger } from "../observability/logger";

export interface RoyaltyAnalyticsDateFilter {
  from?: Date;
  to?: Date;
}

export interface TopCreator {
  creatorWallet: string;
  totalRoyalties: string;
  eventCount: number;
}

export interface KeyRoyaltyVolume {
  keyAddress: string;
  totalRoyalties: string;
  eventCount: number;
}

export interface RoyaltyAnalyticsResult {
  platformTotalRoyalties: string;
  topCreators: TopCreator[];
  royaltyVolumeByKey: KeyRoyaltyVolume[];
  dateFilter: {
    from: string | null;
    to: string | null;
  };
  computedAt: string;
}

export class RoyaltyAnalyticsService {
  private readonly repo: Repository<RoyaltyEvent>;

  constructor(dataSource: DataSource) {
    this.repo = dataSource.getRepository(RoyaltyEvent);
  }

  /**
   * Computes platform-wide royalty analytics.
   *
   * - Total royalties collected across all events
   * - Top 10 earning creators by royalty amount
   * - Royalty volume per key sorted descending
   * - Optionally filtered by date range (paidAt)
   */
  async getAnalytics(filter: RoyaltyAnalyticsDateFilter = {}): Promise<RoyaltyAnalyticsResult> {
    const { from, to } = filter;

    // Build a shared date-filter clause for all queries
    const applyDateFilter = (
      qb: ReturnType<Repository<RoyaltyEvent>["createQueryBuilder"]>
    ) => {
      if (from) {
        qb.andWhere("r.paid_at >= :from", { from });
      }
      if (to) {
        qb.andWhere("r.paid_at <= :to", { to });
      }
      return qb;
    };

    try {
      // ---- Platform total ----
      const totalResult = await applyDateFilter(
        this.repo
          .createQueryBuilder("r")
          .select("COALESCE(SUM(CAST(r.amount AS DECIMAL)), 0)", "total")
      ).getRawOne<{ total: string }>();

      const platformTotalRoyalties = totalResult?.total ?? "0";

      // ---- Top 10 creators ----
      const topCreatorsRaw = await applyDateFilter(
        this.repo
          .createQueryBuilder("r")
          .select("r.creator_wallet", "creatorWallet")
          .addSelect("COALESCE(SUM(CAST(r.amount AS DECIMAL)), 0)", "totalRoyalties")
          .addSelect("COUNT(r.id)", "eventCount")
          .groupBy("r.creator_wallet")
          .orderBy("SUM(CAST(r.amount AS DECIMAL))", "DESC")
          .limit(10)
      ).getRawMany<{ creatorWallet: string; totalRoyalties: string; eventCount: string }>();

      const topCreators: TopCreator[] = topCreatorsRaw.map((row) => ({
        creatorWallet: row.creatorWallet,
        totalRoyalties: row.totalRoyalties ?? "0",
        eventCount: parseInt(row.eventCount ?? "0", 10),
      }));

      // ---- Royalty volume by key (all keys, sorted descending) ----
      const byKeyRaw = await applyDateFilter(
        this.repo
          .createQueryBuilder("r")
          .select("r.key_address", "keyAddress")
          .addSelect("COALESCE(SUM(CAST(r.amount AS DECIMAL)), 0)", "totalRoyalties")
          .addSelect("COUNT(r.id)", "eventCount")
          .groupBy("r.key_address")
          .orderBy("SUM(CAST(r.amount AS DECIMAL))", "DESC")
      ).getRawMany<{ keyAddress: string; totalRoyalties: string; eventCount: string }>();

      const royaltyVolumeByKey: KeyRoyaltyVolume[] = byKeyRaw.map((row) => ({
        keyAddress: row.keyAddress,
        totalRoyalties: row.totalRoyalties ?? "0",
        eventCount: parseInt(row.eventCount ?? "0", 10),
      }));

      return {
        platformTotalRoyalties,
        topCreators,
        royaltyVolumeByKey,
        dateFilter: {
          from: from ? from.toISOString() : null,
          to: to ? to.toISOString() : null,
        },
        computedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error("RoyaltyAnalytics: Failed to compute analytics", {
        error: error instanceof Error ? error.message : String(error),
        filter: { from: from?.toISOString(), to: to?.toISOString() },
      });
      throw error;
    }
  }
}

export function createRoyaltyAnalyticsService(dataSource: DataSource): RoyaltyAnalyticsService {
  return new RoyaltyAnalyticsService(dataSource);
}
