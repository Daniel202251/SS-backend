import type { DataSource, Repository } from "typeorm";

import { AtomicSwap } from "../models/AtomicSwap.model";
import { ContractAcl, type AclStatus } from "../models/ContractAcl.model";
import { ContractAclLog } from "../models/ContractAclLog.model";
import { CreatorKey } from "../models/CreatorKey.model";
import { CurveMigration } from "../models/CurveMigration.model";
import type { AclRepositoryContract, AclUpdateInput } from "./acl.service";
import type { AtomicSwapInput, SwapRepositoryContract } from "./atomic-swap.service";
import type { CreatorKeyRepositoryContract } from "./creator-key.service";
import type {
  CurveMigrationExecutionInput,
  CurveMigrationProposalInput,
  CurveMigrationRepositoryContract,
} from "./curve-migration.service";

/**
 * TypeORM-backed adapters for the on-chain projection repositories. Each
 * projection is idempotent on its on-chain identifier, so replaying the same
 * event twice cannot create duplicate rows.
 */

export function createCreatorKeyRepository(dataSource: DataSource): CreatorKeyRepositoryContract {
  const repo = (): Repository<CreatorKey> => dataSource.getRepository(CreatorKey);

  return {
    async findById(id) {
      return repo().findOne({ where: { id } });
    },
    async findByContractAddress(contractAddress) {
      return repo().findOne({ where: { contractAddress } });
    },
    async applyConfigUpdate(keyId, update) {
      const key = await repo().findOne({ where: { id: keyId } });
      if (!key) return null;

      if (update.maxBuyPerTx !== undefined) key.maxBuyPerTx = update.maxBuyPerTx;
      if (update.maxBuyPerDay !== undefined) key.maxBuyPerDay = update.maxBuyPerDay;
      if (update.currentSupply !== undefined) key.currentSupply = update.currentSupply;
      key.configVersion += 1;

      return repo().save(key);
    },
  };
}

export function createAclRepository(dataSource: DataSource): AclRepositoryContract {
  const current = (): Repository<ContractAcl> => dataSource.getRepository(ContractAcl);
  const log = (): Repository<ContractAclLog> => dataSource.getRepository(ContractAclLog);

  return {
    async findActive() {
      return current().find({ where: { status: "active" }, order: { contractAddress: "ASC" } });
    },
    async findHistory({ limit, offset }) {
      return log().find({
        order: { createdAt: "DESC", id: "DESC" },
        take: limit,
        skip: offset ?? 0,
      });
    },
    async applyUpdate(update: AclUpdateInput) {
      const status: AclStatus = update.action === "remove" ? "removed" : "active";

      await dataSource.transaction(async (manager) => {
        const aclRepo = manager.getRepository(ContractAcl);
        const existing = await aclRepo.findOne({
          where: { contractAddress: update.contractAddress },
        });

        if (existing) {
          existing.permittedFunctions = update.permittedFunctions;
          existing.status = status;
          existing.lastLedger = update.ledgerSequence;
          existing.lastTxHash = update.txHash;
          if (status === "active") {
            // Re-whitelisting restarts the audit window.
            existing.addedAt = update.occurredAt ?? new Date();
            existing.removedAt = null;
          } else {
            existing.removedAt = update.occurredAt ?? new Date();
          }
          await aclRepo.save(existing);
        } else {
          await aclRepo.save(
            aclRepo.create({
              contractAddress: update.contractAddress,
              permittedFunctions: update.permittedFunctions,
              status,
              addedAt: update.occurredAt ?? new Date(),
              removedAt: status === "removed" ? (update.occurredAt ?? new Date()) : null,
              lastLedger: update.ledgerSequence,
              lastTxHash: update.txHash,
            })
          );
        }

        const logRepo = manager.getRepository(ContractAclLog);
        await logRepo.save(
          logRepo.create({
            contractAddress: update.contractAddress,
            action: update.action,
            permittedFunctions: update.permittedFunctions,
            ledgerSequence: update.ledgerSequence,
            txHash: update.txHash,
            actor: update.actor,
          })
        );
      });
    },
  };
}

export function createCurveMigrationRepository(
  dataSource: DataSource
): CurveMigrationRepositoryContract {
  const repo = (): Repository<CurveMigration> => dataSource.getRepository(CurveMigration);

  return {
    async findByKeyId(keyId) {
      return repo().find({ where: { keyId }, order: { proposedAt: "DESC" } });
    },
    async recordProposal(input: CurveMigrationProposalInput) {
      const existing = await repo().findOne({ where: { proposalId: input.proposalId } });
      if (existing) return existing;

      return repo().save(
        repo().create({
          keyId: input.keyId,
          proposalId: input.proposalId,
          contractAddress: input.contractAddress,
          status: "pending",
          proposedParams: input.proposedParams,
          timelockExpiry: input.timelockExpiry,
          proposedAt: input.proposedAt,
          proposalTxHash: input.proposalTxHash,
          ledgerSequence: input.ledgerSequence,
        })
      );
    },
    async recordExecution(proposalId: string, input: CurveMigrationExecutionInput) {
      const migration = await repo().findOne({ where: { proposalId } });
      if (!migration) return null;

      migration.status = "executed";
      migration.appliedParams = input.appliedParams;
      migration.executedAt = input.executedAt;
      migration.executionTxHash = input.executionTxHash;
      migration.ledgerSequence = input.ledgerSequence ?? migration.ledgerSequence;

      return repo().save(migration);
    },
  };
}

export function createSwapRepository(dataSource: DataSource): SwapRepositoryContract {
  const repo = (): Repository<AtomicSwap> => dataSource.getRepository(AtomicSwap);

  return {
    async findByWallet(walletAddress, { limit, cursor }) {
      const qb = repo()
        .createQueryBuilder("swap")
        .where("(swap.buyer_address = :wallet OR swap.seller_address = :wallet)", {
          wallet: walletAddress,
        })
        .orderBy("swap.executed_at", "DESC")
        .addOrderBy("swap.id", "DESC")
        .take(limit + 1);

      if (cursor) {
        qb.andWhere(
          "(swap.executed_at < :executedAt OR (swap.executed_at = :executedAt AND swap.id < :id))",
          { executedAt: cursor.createdAt, id: cursor.id }
        );
      }

      const rows = await qb.getMany();
      const hasMore = rows.length > limit;
      return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
    },
    async findById(id) {
      const found = await repo().findOne({ where: { id } });
      if (found) return found;
      return repo().findOne({ where: { swapId: id } });
    },
    async recordSwap(input: AtomicSwapInput) {
      const existing = await repo().findOne({ where: { swapId: input.swapId } });
      if (existing) return existing;

      return repo().save(repo().create(input));
    },
  };
}
