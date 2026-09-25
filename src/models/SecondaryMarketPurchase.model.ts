import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { SecondaryMarketPurchaseStatus } from "../types/secondary-market";
import type { SecondaryMarketListing } from "./SecondaryMarketListing.model";

@Entity("secondary_market_purchases")
@Index("idx_secondary_market_purchase_listing_id", ["listingId", "createdAt"])
@Index("idx_secondary_market_purchase_buyer_id", ["buyerId", "createdAt"])
export class SecondaryMarketPurchase {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "listing_id", type: "uuid" })
  listingId!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  invoiceId!: string;

  @Column({ name: "seller_id", type: "uuid" })
  sellerId!: string;

  @Column({ name: "buyer_id", type: "uuid" })
  buyerId!: string;

  @Column({ name: "quantity", type: "decimal", precision: 18, scale: 4 })
  quantity!: string;

  @Column({ name: "total_price", type: "decimal", precision: 18, scale: 4 })
  totalPrice!: string;

  @Column({
    type: "enum",
    enum: SecondaryMarketPurchaseStatus,
    default: SecondaryMarketPurchaseStatus.COMPLETED,
  })
  status!: SecondaryMarketPurchaseStatus;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @ManyToOne("SecondaryMarketListing", "purchases", { onDelete: "CASCADE" })
  @JoinColumn({ name: "listing_id" })
  listing!: SecondaryMarketListing;
}
