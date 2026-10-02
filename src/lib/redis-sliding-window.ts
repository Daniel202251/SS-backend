import type { Redis } from "ioredis";
import { getRedisClient } from "../config/redis";
import { logger } from "../observability/logger";

export const SLIDING_WINDOW_LUA_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxRequests = tonumber(ARGV[3])
local member = ARGV[4]

local clearBefore = now - windowMs
-- Prune expired records older than (now - windowMs)
redis.call('ZREMRANGEBYSCORE', key, '-inf', clearBefore)

-- Count remaining requests in current window
local currentCount = redis.call('ZCARD', key)

if currentCount >= maxRequests then
    -- Find oldest entry in the window to calculate Retry-After
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local retryAfterMs = windowMs
    if #oldest >= 2 then
        local oldestScore = tonumber(oldest[2])
        retryAfterMs = windowMs - (now - oldestScore)
        if retryAfterMs < 0 then
            retryAfterMs = 0
        end
    end
    return {0, currentCount, retryAfterMs}
else
    -- Add current request timestamp
    redis.call('ZADD', key, now, member)
    -- Set TTL on key so inactive keys automatically expire
    redis.call('PEXPIRE', key, windowMs + 2000)
    return {1, currentCount + 1, 0}
end
`;

export interface SlidingWindowOptions {
  key: string;
  windowMs: number;
  maxRequests: number;
  now?: number;
  client?: Redis;
}

export interface SlidingWindowResult {
  allowed: boolean;
  currentCount: number;
  remaining: number;
  retryAfterSeconds: number;
  fallback?: boolean;
}

export async function checkSlidingWindow(
  options: SlidingWindowOptions
): Promise<SlidingWindowResult> {
  const { key, windowMs, maxRequests } = options;
  const now = options.now ?? Date.now();
  const client = options.client ?? getRedisClient();
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}:${process.hrtime.bigint()}`;

  try {
    const raw = (await client.eval(
      SLIDING_WINDOW_LUA_SCRIPT,
      1,
      key,
      now,
      windowMs,
      maxRequests,
      member
    )) as [number, number, number];

    const allowed = raw[0] === 1;
    const currentCount = Number(raw[1]);
    const retryAfterMs = Number(raw[2]);
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    const remaining = allowed ? Math.max(0, maxRequests - currentCount) : 0;

    return {
      allowed,
      currentCount,
      remaining,
      retryAfterSeconds: allowed ? 0 : retryAfterSeconds,
      fallback: false,
    };
  } catch (error) {
    logger.warn("Redis sliding window evaluation failed, falling back to allow-all", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      allowed: true,
      currentCount: 0,
      remaining: maxRequests,
      retryAfterSeconds: 0,
      fallback: true,
    };
  }
}
