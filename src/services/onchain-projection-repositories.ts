import type { DataSource, Repository } from "typeorm";

import { AtomicSwap } from "../models/AtomicSwap.model";
import { ContractAcl, type AclStatus } from "../models/ContractAcl.model";
import { ContractAclLog } from "../models/ContractAclLog.model";
import { CreatorKey } from "../models/CreatorKey.model";
import { CurveMigration } from "../models/CurveMigration.model";
import { DividendAllocation } from "../models/DividendAllocation.model";
import { DividendClaim } from "../models/DividendClaim.model";
import { DividendDistribution } from "../models/DividendDistribution.model";
import { RoyaltyClaim } from "../models/RoyaltyClaim.model";
import { RoyaltyEvent } from "../models/RoyaltyEvent.model";
import type { AclRepositoryContract, AclUpdateInput } from "./acl.service";
import type { AtomicSwapInput, SwapRepositoryContract } from "./atomic-swap.service";
import type { CreatorKeyRepositoryContract } from "./creator-key.service";
import type { DividendRepositoryContract } from "./dividend-distribution.service";
import type { RoyaltyEarningsRepositoryContract } from "./royalty-earnings.service";
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

export function createRoyaltyEarningsRepository(
  dataSource: DataSource
): RoyaltyEarningsRepositoryContract {
  const events = (): Repository<RoyaltyEvent> => dataSource.getRepository(RoyaltyEvent);
  const claims = (): Repository<RoyaltyClaim> => dataSource.getRepository(RoyaltyClaim);

  return {
    async totalsByCreator(creatorWallet) {
      const row = await events()
        .createQueryBuilder("r")
        .select("COALESCE(SUM(CAST(r.amount AS DECIMAL)), 0)", "totalEarned")
        .addSelect("COUNT(r.id)", "transferCount")
        .where("r.creator_wallet = :creatorWallet", { creatorWallet })
        .getRawOne<{ totalEarned: string | number | null; transferCount: string | number }>();

      return {
        totalEarned: row?.totalEarned === null || row?.totalEarned === undefined ? "0" : String(row.totalEarned),
        transferCount: Number(row?.transferCount ?? 0),
      };
    },
    async listTransfers(creatorWallet, { limit, offset }) {
      return events().find({
        where: { creatorWallet },
        order: { paidAt: "DESC", id: "DESC" },
        take: limit,
        skip: offset ?? 0,
      });
    },
    async claimTotalsByCreator(creatorWallet) {
      const row = await claims()
        .createQueryBuilder("c")
        .select("COALESCE(SUM(CAST(c.amount AS DECIMAL)), 0)", "totalClaimed")
        .addSelect("COUNT(c.id)", "claimCount")
        .where("c.creator_wallet = :creatorWallet", { creatorWallet })
        .getRawOne<{ totalClaimed: string | number | null; claimCount: string | number }>();

      return {
        totalClaimed: row?.totalClaimed === null || row?.totalClaimed === undefined ? "0" : String(row.totalClaimed),
        claimCount: Number(row?.claimCount ?? 0),
      };
    },
    async listClaims(creatorWallet, { limit, cursor }) {
      const qb = claims()
        .createQueryBuilder("claim")
        .where("claim.creator_wallet = :creatorWallet", { creatorWallet })
        .orderBy("claim.claimed_at", "DESC")
        .addOrderBy("claim.id", "DESC")
        .take(limit);

      if (cursor) {
        qb.andWhere(
          "(claim.claimed_at < :claimedAt OR (claim.claimed_at = :claimedAt AND claim.id < :id))",
          { claimedAt: cursor.claimedAt, id: cursor.id }
        );
      }

      return qb.getMany();
    },
    async recordRoyaltyPaid(input) {
      // Replaying the same ledger event must not double-count earnings, so the
      // on-chain identity (tx hash plus ledger) is the idempotency key.
      const existing = await events().findOne({
        where: { txHash: input.txHash ?? "", ledgerSequence: input.ledgerSequence ?? "" },
      });
      if (existing) return;

      await events().save(
        events().create({
          keyAddress: input.keyAddress,
          creatorWallet: input.creatorWallet,
          buyerWallet: input.buyerWallet,
          amount: input.amount,
          txHash: input.txHash,
          ledgerSequence: input.ledgerSequence,
          paidAt: input.paidAt,
        })
      );
    },
    async recordRoyaltyClaim(input) {
      const existing = await claims().findOne({ where: { claimId: input.claimId } });
      if (existing) return;

      await claims().save(claims().create({ ...input }));
    },
  };
}

export function createDividendRepository(dataSource: DataSource): DividendRepositoryContract {
  const distributions = (): Repository<DividendDistribution> =>
    dataSource.getRepository(DividendDistribution);
  const allocations = (): Repository<DividendAllocation> =>
    dataSource.getRepository(DividendAllocation);
  const claims = (): Repository<DividendClaim> => dataSource.getRepository(DividendClaim);

  return {
    async recordDistribution(input) {
      // `dividend_distributions` has no ledger column, so the cycle is keyed on
      // the transaction that created it plus the issuer, which is enough to stop
      // a replayed `DividendDistributed` event opening a second cycle.
      const existing = await distributions().findOne({
        where: {
          txHash: input.txHash ?? "",
          issuerWallet: input.issuerWallet,
          distributedAt: input.distributedAt,
        },
      });
      if (existing) return;

      await distributions().save(
        distributions().create({
          issuerWallet: input.issuerWallet,
          totalAmount: input.totalAmount,
          recipientCount: input.recipientCount,
          cycleFrequency: input.cycleFrequency,
          txHash: input.txHash,
          distributedAt: input.distributedAt,
        })
      );
    },
    async recordAllocations(inputs) {
      const repo = allocations();
      for (const input of inputs) {
        const existing = await repo.findOne({ where: { allocationId: input.allocationId } });
        if (existing) continue;
        await repo.save(repo.create({ ...input }));
      }
    },
    async recordClaim(input) {
      const repo = claims();
      const existing = await repo.findOne({ where: { claimId: input.claimId } });
      if (existing) return;
      await repo.save(repo.create({ ...input }));
    },
    async allocationsByWallet(wallet) {
      return allocations().find({
        where: { recipientWallet: wallet },
        order: { distributedAt: "DESC", id: "DESC" },
      });
    },
    async claimsByWallet(wallet) {
      return claims().find({
        where: { recipientWallet: wallet },
        order: { claimedAt: "DESC", id: "DESC" },
      });
    },
  };
}
