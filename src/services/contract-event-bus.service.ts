import type { DecodedSorobanEvent } from "../types/soroban.types";
import type { AppLogger } from "../observability/logger";
import { logger as globalLogger } from "../observability/logger";

/**
 * Fan-out registry for the read-model projections that are derived from
 * on-chain events (creator key config, contract ACL, curve migrations, atomic
 * swaps).
 *
 * Handlers declare the event topics they care about; the registry is mounted
 * on `EventIndexerService` so every polled event reaches the right projection
 * without the indexer knowing about any specific contract.
 */
export interface ContractEventHandler {
  /** Lower-case event topic names this handler consumes, e.g. `acl_updated`. */
  topics(): string[];
  handle(event: DecodedSorobanEvent): Promise<void>;
}

/** Normalises `ACLUpdated`, `acl_updated`, `acl-updated` to `acl_updated`. */
export function normalizeTopic(topic: string): string {
  return topic
    .trim()
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

export interface ContractEventBusDependencies {
  handlers?: ContractEventHandler[];
  logger?: AppLogger;
}

export class ContractEventBus {
  private readonly handlersByTopic = new Map<string, ContractEventHandler[]>();
  private readonly logger: AppLogger;

  constructor({ handlers = [], logger = globalLogger }: ContractEventBusDependencies = {}) {
    this.logger = logger;
    for (const handler of handlers) {
      this.register(handler);
    }
  }

  register(handler: ContractEventHandler): void {
    for (const topic of handler.topics()) {
      const key = normalizeTopic(topic);
      const existing = this.handlersByTopic.get(key) ?? [];
      existing.push(handler);
      this.handlersByTopic.set(key, existing);
    }
  }

  handlersFor(topic: string): ContractEventHandler[] {
    return this.handlersByTopic.get(normalizeTopic(topic)) ?? [];
  }

  /**
   * Dispatches one event to every handler subscribed to its topic. A failing
   * handler is logged and skipped so one bad projection cannot block the rest
   * of the pipeline.
   *
   * @returns number of handlers that completed successfully
   */
  async dispatch(event: DecodedSorobanEvent): Promise<number> {
    const handlers = this.handlersFor(event.topic);
    if (handlers.length === 0) return 0;

    let handled = 0;
    for (const handler of handlers) {
      try {
        await handler.handle(event);
        handled++;
      } catch (err) {
        this.logger.error("Contract event handler failed", {
          err,
          topic: event.topic,
          txHash: event.txHash,
          handler: handler.constructor?.name ?? "anonymous",
        });
      }
    }
    return handled;
  }
}

export function createContractEventBus(deps: ContractEventBusDependencies = {}): ContractEventBus {
  return new ContractEventBus(deps);
}

/**
 * Reads a string field from the decoded event data, falling back to the
 * positional topic list. Contract events carry their arguments either in the
 * data `ScVal` map or as indexed topics, depending on the contract version.
 */
export function readEventString(
  event: DecodedSorobanEvent,
  keys: string[],
  topicIndex?: number
): string | null {
  const data = event.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" || typeof value === "bigint") return String(value);
    }
  }

  if (Array.isArray(data)) {
    for (const key of keys) {
      const index = Number(key.replace(/\D/g, ""));
      if (Number.isInteger(index) && index < data.length) {
        const value = data[index];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  }

  if (topicIndex !== undefined) {
    const value = event.topics[topicIndex];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  return null;
}

/** Reads a decimal-ish numeric field (stroops, amounts, bps) from event data. */
export function readEventNumber(event: DecodedSorobanEvent, keys: string[]): number | null {
  const data = event.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "bigint") return Number(value);
      if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
        return Number(value);
      }
    }
  }
  return null;
}

/** Reads a list of function names from event data (ACL permitted functions). */
export function readEventStringList(event: DecodedSorobanEvent, keys: string[]): string[] {
  const data = event.data;
  if (Array.isArray(data)) {
    const strings = data.filter((v): v is string => typeof v === "string");
    if (strings.length > 0) return strings;
  }

  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean);
      }
      if (value instanceof Set) {
        return [...value].filter((v): v is string => typeof v === "string");
      }
    }
  }
  return [];
}
