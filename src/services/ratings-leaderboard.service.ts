import Redis from "ioredis";
import { DataSource, Repository } from "typeorm";
import { CreatorKey } from "../models/CreatorKey.model";
import { logger } from "../observability/logger";

const LEADERBOARD_CACHE_KEY = "keys:ratings:leaderboard";
const LEADERBOARD_CACHE_TTL_SECONDS = 5 * 60; // 5 minutes

export interface LeaderboardEntry {
  rank: number;
  keyId: string;
  keyAddress: string;
  creatorWallet: string;
  name: string | null;
  description: string | null;
  imageUrl: string | null;
  averageRating: string;
  ratingCount: number;
  createdAt: Date;
}

export interface LeaderboardResult {
  data: LeaderboardEntry[];
  meta: {
    totalQualified: number;
    limit: number;
    minRatingCount: number;
    cachedAt: string;
  };
}

export interface RatingsLeaderboardServiceOptions {
  redisUrl?: string;
  redisClient?: Redis;
  /** Default: value of LEADERBOARD_MIN_RATING_COUNT env var, fallback 5 */
  minRatingCount?: number;
}

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

export class RatingsLeaderboardService {
  private readonly repo: Repository<CreatorKey>;
  private readonly redis: Redis | null;
  private readonly memoryFallback = new Map<string, MemoryEntry>();

  constructor(dataSource: DataSource, options: RatingsLeaderboardServiceOptions = {}) {
    this.repo = dataSource.getRepository(CreatorKey);

    if (options.redisClient) {
      this.redis = options.redisClient;
    } else if (options.redisUrl) {
      try {
        this.redis = new Redis(options.redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 2000,
          retryStrategy: () => null,
        });
        this.redis.on("error", (err: unknown) => {
          logger.warn("RatingsLeaderboard: Redis error, using memory fallback", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } catch {
        this.redis = null;
      }
    } else {
      this.redis = null;
    }
  }

  /**
   * Returns the minimum rating count threshold.
   * Reads from LEADERBOARD_MIN_RATING_COUNT env var (default 5).
   */
  private getMinRatingCount(override?: number): number {
    if (override !== undefined) return override;
    const envVal = parseInt(process.env.LEADERBOARD_MIN_RATING_COUNT ?? "5", 10);
    return Number.isFinite(envVal) && envVal > 0 ? envVal : 5;
  }

  /**
   * Returns top N creator keys by average rating.
   * Keys below minRatingCount threshold are excluded.
   * Result is cached with a 5-minute TTL.
   */
  async getLeaderboard(
    limit = 50,
    minRatingCountOverride?: number
  ): Promise<LeaderboardResult> {
    const minRatingCount = this.getMinRatingCount(minRatingCountOverride);
    const cacheKey = `${LEADERBOARD_CACHE_KEY}:${limit}:${minRatingCount}`;

    // Attempt cache read
    const cached = await this.cacheGet(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as LeaderboardResult;
      } catch {
        // Ignore invalid cache entry and re-query
      }
    }

    // Query DB
    const [rows, totalQualified] = await this.repo
      .createQueryBuilder("k")
      .where("k.rating_count >= :minCount", { minCount: minRatingCount })
      .orderBy("k.average_rating", "DESC")
      .addOrderBy("k.rating_count", "DESC")
      .addOrderBy("k.created_at", "ASC")
      .limit(limit)
      .getManyAndCount();

    const data: LeaderboardEntry[] = rows.map((key, idx) => ({
      rank: idx + 1,
      keyId: key.id,
      keyAddress: key.keyAddress,
      creatorWallet: key.creatorWallet,
      name: key.name,
      description: key.description,
      imageUrl: key.imageUrl,
      averageRating: key.averageRating,
      ratingCount: key.ratingCount,
      createdAt: key.createdAt,
    }));

    const result: LeaderboardResult = {
      data,
      meta: {
        totalQualified,
        limit,
        minRatingCount,
        cachedAt: new Date().toISOString(),
      },
    };

    // Store in cache
    await this.cacheSet(cacheKey, JSON.stringify(result), LEADERBOARD_CACHE_TTL_SECONDS);

    return result;
  }

  // --- Cache helpers ---

  private async cacheGet(key: string): Promise<string | null> {
    if (this.redis) {
      try {
        const val = await this.redis.get(key);
        if (val !== null) return val;
      } catch (err) {
        logger.warn("RatingsLeaderboard: Redis get failed", {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const entry = this.memoryFallback.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.memoryFallback.delete(key);
      return null;
    }
    return entry.value;
  }

  private async cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.setex(key, ttlSeconds, value);
      } catch (err) {
        logger.warn("RatingsLeaderboard: Redis set failed, storing in memory", {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.memoryFallback.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }
}

export function createRatingsLeaderboardService(
  dataSource: DataSource,
  options: RatingsLeaderboardServiceOptions = {}
): RatingsLeaderboardService {
  return new RatingsLeaderboardService(dataSource, options);
}
