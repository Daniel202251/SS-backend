import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
  VersionColumn,
} from "typeorm";
import { SecondaryMarketListingStatus } from "../types/secondary-market";
import type { Invoice } from "./Invoice.model";
import type { User } from "./User.model";
import type { SecondaryMarketPurchase } from "./SecondaryMarketPurchase.model";

@Entity("secondary_market_listings")
@Index("idx_secondary_market_listing_invoice_status", ["invoiceId", "status", "createdAt"])
@Index("idx_secondary_market_listing_seller_status", ["sellerId", "status", "createdAt"])
export class SecondaryMarketListing {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  @Index("idx_secondary_market_listing_invoice_id")
  invoiceId!: string;

  @Column({ name: "seller_id", type: "uuid" })
  @Index("idx_secondary_market_listing_seller_id")
  sellerId!: string;

  @Column({ name: "price", type: "decimal", precision: 18, scale: 4 })
  price!: string;

  @Column({ name: "quantity", type: "decimal", precision: 18, scale: 4 })
  quantity!: string;

  @Column({
    type: "enum",
    enum: SecondaryMarketListingStatus,
    default: SecondaryMarketListingStatus.ACTIVE,
  })
  @Index("idx_secondary_market_listing_status")
  status!: SecondaryMarketListingStatus;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at" })
  deletedAt!: Date | null;

  @VersionColumn()
  version!: number;

  @ManyToOne("Invoice", "secondaryMarketListings", { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoice_id" })
  invoice!: Invoice;

  @ManyToOne("User", "secondaryMarketListings", { onDelete: "CASCADE" })
  @JoinColumn({ name: "seller_id" })
  seller!: User;

  @OneToMany("SecondaryMarketPurchase", "listing")
  purchases!: SecondaryMarketPurchase[];
}
