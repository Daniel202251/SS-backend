import "dotenv/config";
import "reflect-metadata";
import { DataSource } from "typeorm";
import { logger } from "../observability/logger";

const isProduction = process.env.NODE_ENV === "production";
const isDevelopment = process.env.NODE_ENV === "development";
const migrationsPath = isProduction ? "dist/migrations/*.js" : "src/migrations/*.ts";
const entitiesPath = isProduction ? "dist/models/**/*.js" : "src/models/**/*.ts";

const POOL_MAX = 20;
const POOL_WARN_THRESHOLD = 0.8; // 80%
const POOL_LOG_COOLDOWN_MS = 30_000; // 30 seconds

let lastPoolWarnLog = 0;
let lastPoolErrorLog = 0;

/**
 * Start monitoring the database connection pool for exhaustion warnings.
 * Logs a warn when utilisation exceeds 80% and error at 100%.
 * Each log is emitted at most once per 30 seconds.
 */
export function startPoolMonitor(
  getPool: () => { totalCount: number; idleCount: number; waitingCount: number } | null
): void {
  setInterval(() => {
    const pool = getPool();
    if (!pool) return;

    const active = pool.totalCount - pool.idleCount;
    const utilisation = active / POOL_MAX;
    const now = Date.now();

    if (utilisation >= 1.0) {
      if (now - lastPoolErrorLog >= POOL_LOG_COOLDOWN_MS) {
        lastPoolErrorLog = now;
        logger.error("Database connection pool exhausted", {
          active_connections: active,
          pool_max: POOL_MAX,
          utilisation_percent: Math.round(utilisation * 100),
          detected_at: new Date().toISOString(),
        });
      }
    } else if (utilisation >= POOL_WARN_THRESHOLD) {
      if (now - lastPoolWarnLog >= POOL_LOG_COOLDOWN_MS) {
        lastPoolWarnLog = now;
        logger.warn("Database connection pool near capacity", {
          active_connections: active,
          pool_max: POOL_MAX,
          utilisation_percent: Math.round(utilisation * 100),
          detected_at: new Date().toISOString(),
        });
      }
    }
  }, 5_000).unref();
}

const baseConfig = {
  synchronize: isDevelopment,
  logging: process.env.NODE_ENV === "development",
  logger: "advanced-console" as const,
  entities: [entitiesPath],
  migrations: [migrationsPath],
  migrationsTableName: "migrations",
  migrationsRun: !isDevelopment,
};

export const dataSource = isDevelopment
  ? new DataSource({
      ...baseConfig,
      type: "sqlite",
      database: "dev.db",
    })
  : new DataSource({
      ...baseConfig,
      type: "postgres",
      url: process.env.DATABASE_URL,
      extra: {
        max: POOL_MAX,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      },
    });

// Start pool monitor for production (postgres) connections
if (!isDevelopment) {
  startPoolMonitor(() => {
    try {
      // TypeORM exposes the underlying pg pool via driver.master/slave
      const pool = (
        dataSource.driver as unknown as {
          master?: { totalCount: number; idleCount: number; waitingCount: number };
        }
      )?.master;
      if (pool && typeof pool.totalCount === "number") {
        return {
          totalCount: pool.totalCount,
          idleCount: pool.idleCount,
          waitingCount: pool.waitingCount,
        };
      }
    } catch {
      // Ignore — pool not yet initialised
    }
    return null;
  });
}

export default dataSource;
