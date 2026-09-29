import Redis, { type RedisOptions } from "ioredis";
import { logger } from "../observability/logger";

let defaultRedisClient: Redis | null = null;

export function createRedisClient(options?: RedisOptions): Redis {
  if (process.env.NODE_ENV === "test" && !process.env.REDIS_URL) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const RedisMock = require("ioredis-mock");
      return new RedisMock(options) as unknown as Redis;
    } catch {
      // fallback to standard client
    }
  }
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    retryStrategy: (times: number) => {
      if (times > 3) {
        return null;
      }
      return Math.min(times * 100, 1000);
    },
    ...options,
  });

  client.on("error", (err) => {
    logger.warn("Redis client connection error:", { error: err.message });
  });

  return client;
}

export function getRedisClient(): Redis {
  if (!defaultRedisClient) {
    defaultRedisClient = createRedisClient();
  }
  return defaultRedisClient;
}

export function setRedisClient(client: Redis | null): void {
  defaultRedisClient = client;
}

export async function closeRedisClient(): Promise<void> {
  if (defaultRedisClient) {
    try {
      if (defaultRedisClient.status === "ready" || defaultRedisClient.status === "connecting") {
        await defaultRedisClient.quit();
      } else {
        defaultRedisClient.disconnect();
      }
    } catch {
      defaultRedisClient.disconnect();
    }
    defaultRedisClient = null;
  }
}
