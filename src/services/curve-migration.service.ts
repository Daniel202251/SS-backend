import { HttpError } from "../utils/http-error";
import type { DecodedSorobanEvent } from "../types/soroban.types";
import type { CurveMigration, CurveMigrationStatus } from "../models/CurveMigration.model";
import { adminNotificationQueue } from "./admin-notification-queue.service";
import {
  readEventNumber,
  readEventString,
  type ContractEventHandler,
} from "./contract-event-bus.service";

export const CURVE_MIGRATION_EVENTS = {
  proposed: "curve_migration_proposed",
  executed: "curve_migration_executed",
} as const;

export interface CurveMigrationProposalInput {
  keyId: string;
  proposalId: string;
  contractAddress: string;
  proposedParams: Record<string, unknown>;
  timelockExpiry: Date | null;
  proposedAt: Date;
  proposalTxHash: string | null;
  ledgerSequence: string | null;
}

export interface CurveMigrationExecutionInput {
  appliedParams: Record<string, unknown> | null;
  executedAt: Date;
  executionTxHash: string | null;
  ledgerSequence: string | null;
}

export interface CurveMigrationRepositoryContract {
  findByKeyId(keyId: string): Promise<CurveMigration[]>;
  recordProposal(input: CurveMigrationProposalInput): Promise<CurveMigration | null>;
  recordExecution(
    proposalId: string,
    input: CurveMigrationExecutionInput
  ): Promise<CurveMigration | null>;
}

export interface CurveMigrationView {
  id: string;
  migrationId: string;
  keyId: string;
  proposalId: string;
  contractAddress: string;
  status: CurveMigrationStatus;
  proposedParams: Record<string, unknown>;
  appliedParams: Record<string, unknown> | null;
  timelockExpiry: string | null;
  timelockExpired: boolean;
  executable: boolean;
  proposedAt: string;
  executedAt: string | null;
  proposalTxHash: string | null;
  executionTxHash: string | null;
}

export interface CurveMigrationListResponse {
  pending: CurveMigrationView[];
  executed: CurveMigrationView[];
  total: number;
}

export interface AdminNotifier {
  notifyMigrationExecuted(payload: {
    migrationId: string;
    keyId: string;
    contractAddress: string;
    status: CurveMigrationStatus;
    timelockExpiry: string | null;
    appliedParams: Record<string, unknown> | null;
    executedAt: string | null;
  }): Promise<void>;
}

export interface CurveMigrationServiceDependencies {
  curveMigrationRepository: CurveMigrationRepositoryContract;
  /** Injectable so tests can assert notifications without the global queue. */
  adminNotifier?: AdminNotifier;
  now?: () => Date;
}

const defaultAdminNotifier: AdminNotifier = {
  async notifyMigrationExecuted(payload) {
    await adminNotificationQueue.emitEvent("curve_migration_executed", payload);
  },
};

/**
 * Tracks bonding-curve migration proposals and their execution, projected from
 * `CurveMigrationProposed` / `CurveMigrationExecuted` contract events.
 */
export class CurveMigrationService implements ContractEventHandler {
  private readonly curveMigrationRepository: CurveMigrationRepositoryContract;
  private readonly adminNotifier: AdminNotifier;
  private readonly now: () => Date;

  constructor({
    curveMigrationRepository,
    adminNotifier = defaultAdminNotifier,
    now = () => new Date(),
  }: CurveMigrationServiceDependencies) {
    this.curveMigrationRepository = curveMigrationRepository;
    this.adminNotifier = adminNotifier;
    this.now = now;
  }

  topics(): string[] {
    return [CURVE_MIGRATION_EVENTS.proposed, CURVE_MIGRATION_EVENTS.executed];
  }

  /** GET /keys/:id/curve-migrations — pending and executed migrations. */
  async listForKey(keyId: string): Promise<CurveMigrationListResponse> {
    const id = this.normalizeKeyId(keyId);
    const rows = await this.curveMigrationRepository.findByKeyId(id);

    const views = rows.map((row) => this.toView(row));
    const pending = views.filter((view) => view.status !== "executed");
    const executed = views.filter((view) => view.status === "executed");

    return { pending, executed, total: views.length };
  }

  /** Records a proposal and returns its stored representation. */
  async handle(event: DecodedSorobanEvent): Promise<void> {
    // Tolerates `CurveMigrationProposed` and `curve_migration_proposed` alike,
    // which the event bus passes through unchanged.
    const topic = event.topic.toLowerCase();
    if (!topic.includes("migration")) return;

    if (topic.includes("proposed")) {
      await this.recordProposal(event);
      return;
    }

    if (topic.includes("executed")) {
      await this.recordExecution(event);
    }
  }

  private async recordProposal(event: DecodedSorobanEvent): Promise<void> {
    const keyId = readEventString(event, ["key_id", "keyId", "creator_key_id"], 1);
    const proposalId = readEventString(event, ["proposal_id", "proposalId", "id"], 2);
    if (!keyId || !proposalId) return;

    const timelockSeconds = readEventNumber(event, ["timelock", "timelock_expiry", "delay"]);
    const timelockExpiry = this.resolveTimelockExpiry(event, timelockSeconds);

    await this.curveMigrationRepository.recordProposal({
      keyId,
      proposalId,
      contractAddress:
        readEventString(event, ["contract_address", "contractAddress"], 3) ?? event.contractId,
      proposedParams: this.readParams(event, ["proposed_params", "proposedParams", "params"]),
      timelockExpiry,
      proposedAt: this.eventTime(event),
      proposalTxHash: event.txHash ?? null,
      ledgerSequence: Number.isFinite(event.ledger) ? String(event.ledger) : null,
    });
  }

  private async recordExecution(event: DecodedSorobanEvent): Promise<void> {
    const proposalId = readEventString(event, ["proposal_id", "proposalId", "id"], 1);
    if (!proposalId) return;

    const migration = await this.curveMigrationRepository.recordExecution(proposalId, {
      appliedParams: this.readParams(event, ["applied_params", "appliedParams", "params"]),
      executedAt: this.eventTime(event),
      executionTxHash: event.txHash ?? null,
      ledgerSequence: Number.isFinite(event.ledger) ? String(event.ledger) : null,
    });

    if (!migration) return;

    const view = this.toView(migration);
    await this.adminNotifier.notifyMigrationExecuted({
      migrationId: view.migrationId,
      keyId: view.keyId,
      contractAddress: view.contractAddress,
      status: view.status,
      timelockExpiry: view.timelockExpiry,
      appliedParams: view.appliedParams,
      executedAt: view.executedAt,
    });
  }

  /**
   * The timelock may be published as an absolute unix timestamp or as a delay
   * in seconds after the proposal; both are supported.
   */
  private resolveTimelockExpiry(
    event: DecodedSorobanEvent,
    timelockSeconds: number | null
  ): Date | null {
    if (timelockSeconds === null) return null;

    const eventTime = this.eventTime(event).getTime();
    const asAbsolute = timelockSeconds > 1_000_000_000 ? timelockSeconds * 1000 : null;
    const millis = asAbsolute ?? eventTime + timelockSeconds * 1000;

    if (!Number.isFinite(millis)) return null;
    return new Date(millis);
  }

  private eventTime(event: DecodedSorobanEvent): Date {
    if (event.ledgerClosedAt) {
      const parsed = new Date(event.ledgerClosedAt);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return this.now();
  }

  private readParams(event: DecodedSorobanEvent, keys: string[]): Record<string, unknown> {
    const data = event.data as Record<string, unknown> | null;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const key of keys) {
        const value = data[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return value as Record<string, unknown>;
        }
      }
    }
    return {};
  }

  private normalizeKeyId(keyId: string): string {
    if (typeof keyId !== "string" || !keyId.trim()) {
      throw new HttpError(400, "A creator key id is required.");
    }
    return keyId.trim();
  }

  private toView(row: CurveMigration): CurveMigrationView {
    const now = this.now().getTime();
    const timelockExpiry = row.timelockExpiry ? new Date(row.timelockExpiry) : null;
    const timelockExpired = timelockExpiry ? timelockExpiry.getTime() <= now : false;
    const executed = row.status === "executed";

    return {
      id: row.id,
      migrationId: row.proposalId,
      keyId: row.keyId,
      proposalId: row.proposalId,
      contractAddress: row.contractAddress,
      status: executed ? "executed" : timelockExpired ? "expired" : "pending",
      proposedParams: row.proposedParams ?? {},
      appliedParams: row.appliedParams ?? null,
      timelockExpiry: timelockExpiry ? timelockExpiry.toISOString() : null,
      timelockExpired,
      executable: !executed && timelockExpiry ? timelockExpired : !executed,
      proposedAt: new Date(row.proposedAt).toISOString(),
      executedAt: row.executedAt ? new Date(row.executedAt).toISOString() : null,
      proposalTxHash: row.proposalTxHash ?? null,
      executionTxHash: row.executionTxHash ?? null,
    };
  }
}

export function createCurveMigrationService(
  dependencies: CurveMigrationServiceDependencies
): CurveMigrationService {
  return new CurveMigrationService(dependencies);
}
