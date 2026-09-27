import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Stores daily platform-wide metric snapshots for historical trend analysis.
 * One row per date (keyed by date string "YYYY-MM-DD").
 * Captured by the midnight UTC cron job.
 */
@Entity("analytics_snapshots")
export class AnalyticsSnapshot {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Date key in "YYYY-MM-DD" format (UTC). Unique per day. */
  @Column({ name: "snapshot_date", type: "varchar", length: 10, unique: true })
  @Index("idx_analytics_snapshots_date", { unique: true })
  snapshotDate!: string;

  // ---- Invoice counts by status ----

  @Column({ name: "total_invoices_draft", type: "integer", default: 0 })
  totalInvoicesDraft!: number;

  @Column({ name: "total_invoices_pending", type: "integer", default: 0 })
  totalInvoicesPending!: number;

  @Column({ name: "total_invoices_published", type: "integer", default: 0 })
  totalInvoicesPublished!: number;

  @Column({ name: "total_invoices_funded", type: "integer", default: 0 })
  totalInvoicesFunded!: number;

  @Column({ name: "total_invoices_settled", type: "integer", default: 0 })
  totalInvoicesSettled!: number;

  @Column({ name: "total_invoices_cancelled", type: "integer", default: 0 })
  totalInvoicesCancelled!: number;

  @Column({ name: "total_invoices_rejected", type: "integer", default: 0 })
  totalInvoicesRejected!: number;

  /** Grand total of all invoices */
  @Column({ name: "total_invoices", type: "integer", default: 0 })
  totalInvoices!: number;

  // ---- Funding volume ----

  /** Total investment amount confirmed on this specific day */
  @Column({
    name: "daily_funding_volume",
    type: "decimal",
    precision: 18,
    scale: 4,
    default: 0,
  })
  dailyFundingVolume!: string;

  /** Cumulative total investment amount across all time (up to snapshot date) */
  @Column({
    name: "cumulative_funding_volume",
    type: "decimal",
    precision: 18,
    scale: 4,
    default: 0,
  })
  cumulativeFundingVolume!: string;

  // ---- Active investors ----

  /** Number of distinct investors who have made at least one confirmed investment */
  @Column({ name: "active_investor_count", type: "integer", default: 0 })
  activeInvestorCount!: number;

  // ---- Settlement rate ----

  /** Ratio of settled invoices to total funded invoices, as a percentage (0-100) */
  @Column({
    name: "settlement_rate",
    type: "decimal",
    precision: 5,
    scale: 2,
    default: 0,
  })
  settlementRate!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
