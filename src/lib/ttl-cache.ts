/**
 * Minimal TTL cache used by the read-only on-chain projection endpoints
 * (creator key buy limits, contract ACL, curve migrations, swap history).
 *
 * Values are cached in-process and optionally mirrored into Redis so that
 * multiple API instances share the same warm cache. Redis is strictly best
 * effort: any connection/command failure degrades to the in-process map rather
 * than failing the request.
 */

export interface TtlCacheOptions {
  /** Entry lifetime in seconds. */
  ttlSeconds: number;
  /** Prefix for Redis keys, so invalidation can be scoped per feature. */
  namespace?: string;
  /** Optional ioredis-compatible client. When omitted the cache is memory-only. */
  redisClient?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
    del(...keys: string[]): Promise<unknown>;
  };
  enabled?: boolean;
  /** Injectable clock, for deterministic TTL assertions in tests. */
  now?: () => number;
}

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

export class TtlCache {
  readonly ttlSeconds: number;
  private readonly namespace: string;
  private readonly redis?: TtlCacheOptions["redisClient"];
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly memory = new Map<string, MemoryEntry>();

  constructor(options: TtlCacheOptions) {
    if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
      throw new Error("TtlCache requires a positive ttlSeconds.");
    }
    this.ttlSeconds = options.ttlSeconds;
    this.namespace = options.namespace ?? "cache";
    this.redis = options.redisClient;
    this.enabled = options.enabled !== false;
    this.now = options.now ?? (() => Date.now());
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getTtlSeconds(): number {
    return this.ttlSeconds;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.enabled) return null;
    const namespaced = this.buildKey(key);

    if (this.redis) {
      try {
        const raw = await this.redis.get(namespaced);
        if (raw !== null) {
          this.remember(namespaced, raw);
          return JSON.parse(raw) as T;
        }
        return null;
      } catch {
        // fall through to the in-process copy
      }
    }

    const entry = this.memory.get(namespaced);
    if (!entry) return null;
    if (this.now() > entry.expiresAt) {
      this.memory.delete(namespaced);
      return null;
    }
    try {
      return JSON.parse(entry.value) as T;
    } catch {
      this.memory.delete(namespaced);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (!this.enabled) return;
    const namespaced = this.buildKey(key);
    const ttl = ttlSeconds ?? this.ttlSeconds;
    const serialized = JSON.stringify(value);

    if (this.redis) {
      try {
        await this.redis.set(namespaced, serialized, "EX", ttl);
      } catch {
        // best effort only
      }
    }

    this.memory.set(namespaced, { value: serialized, expiresAt: this.now() + ttl * 1000 });
  }

  /** Drops a single entry from both the in-process map and Redis. */
  async delete(key: string): Promise<void> {
    if (!this.enabled) return;
    const namespaced = this.buildKey(key);
    this.memory.delete(namespaced);

    if (this.redis) {
      try {
        await this.redis.del(namespaced);
      } catch {
        // best effort only
      }
    }
  }

  /** Drops every entry held in-process (Redis entries expire via their TTL). */
  clear(): void {
    this.memory.clear();
  }

  private remember(key: string, raw: string, ttlSeconds?: number): void {
    const ttl = ttlSeconds ?? this.ttlSeconds;
    this.memory.set(key, { value: raw, expiresAt: this.now() + ttl * 1000 });
  }

  private buildKey(key: string): string {
    return `${this.namespace}:${key}`;
  }
}

export function createTtlCache(options: TtlCacheOptions): TtlCache {
  return new TtlCache(options);
}
