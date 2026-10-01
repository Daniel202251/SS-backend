import { DataSource, Repository } from "typeorm";

import { OnboardingProgress } from "../models/OnboardingProgress.model";

export interface OnboardingStatusView {
  wallet: string;
  tourCompleted: boolean;
  completedAt: string | null;
  updatedAt: string | null;
}

/**
 * Server-side persistence of onboarding tour completion (issue #540).
 *
 * The client calls `GET /onboarding/status` on every app load to decide whether
 * to suppress the tour, so reads are a single indexed row lookup and writes are
 * idempotent: re-completing a tour keeps the original `completedAt`, which is
 * what a returning user expects to see.
 */
export class OnboardingService {
  private readonly repo: Repository<OnboardingProgress>;

  constructor(dataSource: DataSource) {
    this.repo = dataSource.getRepository(OnboardingProgress);
  }

  /** Completion state for one wallet; never throws for a wallet with no row. */
  async getStatus(wallet: string): Promise<OnboardingStatusView> {
    const progress = await this.repo.findOne({ where: { walletAddress: wallet } });

    if (!progress) {
      return { wallet, tourCompleted: false, completedAt: null, updatedAt: null };
    }

    return this.toView(progress);
  }

  /**
   * Marks the tour complete for a wallet, creating the row on first
   * completion. The original timestamp is preserved on repeat calls.
   */
  async markTourCompleted(wallet: string, completedAt: Date = new Date()): Promise<OnboardingStatusView> {
    const existing = await this.repo.findOne({ where: { walletAddress: wallet } });

    if (existing) {
      if (!existing.tourCompleted) {
        existing.tourCompleted = true;
        existing.completedAt = completedAt;
        await this.repo.save(existing);
      }
      return this.toView(existing);
    }

    const created = await this.repo.save(
      this.repo.create({
        walletAddress: wallet,
        tourCompleted: true,
        completedAt,
      })
    );
    return this.toView(created);
  }

  private toView(progress: OnboardingProgress): OnboardingStatusView {
    return {
      wallet: progress.walletAddress,
      tourCompleted: progress.tourCompleted,
      completedAt: progress.completedAt ? new Date(progress.completedAt).toISOString() : null,
      updatedAt: progress.updatedAt ? new Date(progress.updatedAt).toISOString() : null,
    };
  }
}

export function createOnboardingService(dataSource: DataSource): OnboardingService {
  return new OnboardingService(dataSource);
}
