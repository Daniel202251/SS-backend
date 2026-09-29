import { DataSource, Repository } from "typeorm";
import { InvestorAcknowledgement } from "../models/InvestorAcknowledgement.model";
import { ServiceError } from "../utils/service-error";

export function getCurrentTermsVersion(): string {
  const raw = process.env.TERMS_VERSION?.trim();
  return raw && raw.length > 0 ? raw : "1";
}

export interface AcknowledgementStatus {
  acknowledged: boolean;
  currentVersion: string;
  acknowledgedVersion: string | null;
  acknowledgedAt: string | null;
}

export class InvestorAcknowledgementService {
  private readonly repo: Repository<InvestorAcknowledgement>;

  constructor(private readonly dataSource: DataSource) {
    this.repo = dataSource.getRepository(InvestorAcknowledgement);
  }

  async acknowledge(input: {
    walletAddress: string;
    userId?: string | null;
    termsVersion?: string;
  }): Promise<InvestorAcknowledgement> {
    const walletAddress = input.walletAddress?.trim();
    if (!walletAddress) {
      throw new ServiceError("WALLET_REQUIRED", "walletAddress is required", 400);
    }

    const termsVersion = (input.termsVersion?.trim() || getCurrentTermsVersion()).trim();
    const current = getCurrentTermsVersion();
    if (termsVersion !== current) {
      throw new ServiceError(
        "TERMS_VERSION_MISMATCH",
        `Must acknowledge the current terms version (${current})`,
        400
      );
    }

    const row = this.repo.create({
      walletAddress,
      userId: input.userId ?? null,
      termsVersion,
      acknowledgedAt: new Date(),
    });
    return this.repo.save(row);
  }

  async getStatus(walletAddress: string): Promise<AcknowledgementStatus> {
    const currentVersion = getCurrentTermsVersion();
    if (!walletAddress?.trim()) {
      return {
        acknowledged: false,
        currentVersion,
        acknowledgedVersion: null,
        acknowledgedAt: null,
      };
    }

    const latestForCurrent = await this.repo.findOne({
      where: { walletAddress: walletAddress.trim(), termsVersion: currentVersion },
      order: { acknowledgedAt: "DESC" },
    });

    if (latestForCurrent) {
      return {
        acknowledged: true,
        currentVersion,
        acknowledgedVersion: latestForCurrent.termsVersion,
        acknowledgedAt: latestForCurrent.acknowledgedAt.toISOString(),
      };
    }

    const anyLatest = await this.repo.findOne({
      where: { walletAddress: walletAddress.trim() },
      order: { acknowledgedAt: "DESC" },
    });

    return {
      acknowledged: false,
      currentVersion,
      acknowledgedVersion: anyLatest?.termsVersion ?? null,
      acknowledgedAt: anyLatest?.acknowledgedAt?.toISOString() ?? null,
    };
  }

  /** True when the wallet has acknowledged the live TERMS_VERSION. */
  async hasCurrentAcknowledgement(walletAddress: string): Promise<boolean> {
    const status = await this.getStatus(walletAddress);
    return status.acknowledged;
  }
}

export function createInvestorAcknowledgementService(
  dataSource: DataSource
): InvestorAcknowledgementService {
  return new InvestorAcknowledgementService(dataSource);
}
