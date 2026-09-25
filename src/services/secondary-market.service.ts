import { DataSource, In, type EntityManager } from "typeorm";
import Decimal from "decimal.js";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { SecondaryMarketListing } from "../models/SecondaryMarketListing.model";
import { SecondaryMarketPurchase } from "../models/SecondaryMarketPurchase.model";
import { InvestmentStatus } from "../types/enums";
import { SecondaryMarketListingStatus, SecondaryMarketPurchaseStatus } from "../types/secondary-market";
import { ServiceError } from "../utils/service-error";

export interface CreateSecondaryMarketListingInput {
  invoiceId: string;
  sellerId: string;
  quantity: string;
  price: string;
}

export interface BuySecondaryMarketListingInput {
  listingId: string;
  buyerId: string;
  buyerWallet?: string | null;
  quantity: string;
  paymentAmount?: string;
}

export interface SecondaryMarketListingSummary {
  id: string;
  invoiceId: string;
  sellerId: string;
  price: string;
  quantity: string;
  status: SecondaryMarketListingStatus;
  createdAt: Date;
  updatedAt: Date;
}

function parsePositiveDecimal(value: string, field: string): Decimal {
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite() || parsed.lte(0)) {
      throw new Error();
    }
    if (parsed.decimalPlaces() > 4) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new ServiceError("INVALID_AMOUNT", `${field} must be a positive decimal value with up to 4 decimal places`, 400);
  }
}

export class SecondaryMarketService {
  constructor(private readonly dataSource: DataSource) {}

  async createListing(input: CreateSecondaryMarketListingInput): Promise<SecondaryMarketListingSummary> {
    const quantity = parsePositiveDecimal(input.quantity, "quantity");
    const price = parsePositiveDecimal(input.price, "price");

    return this.dataSource.transaction(async (manager: EntityManager) => {
      const invoice = await manager.findOne(Invoice, { where: { id: input.invoiceId } });
      if (!invoice) {
        throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
      }

      if (invoice.dueDate && new Date(invoice.dueDate) < new Date()) {
        throw new ServiceError(
          "LISTING_MATURED_INVOICE",
          "Listings cannot be created for invoices that have passed maturity",
          422
        );
      }

      const owned = await this.getOwnedShareAmount(manager, input.invoiceId, input.sellerId);
      if (owned.lt(quantity)) {
        throw new ServiceError(
          "LISTING_INSUFFICIENT_SHARES",
          "Seller does not own enough fractional shares to create this listing",
          409,
          { sellerId: input.sellerId, invoiceId: input.invoiceId, owned: owned.toFixed(4), requested: quantity.toFixed(4) }
        );
      }

      const listing = manager.create(SecondaryMarketListing, {
        invoiceId: input.invoiceId,
        sellerId: input.sellerId,
        quantity: quantity.toFixed(4),
        price: price.toFixed(4),
        status: SecondaryMarketListingStatus.ACTIVE,
      });

      const saved = await manager.save(listing);
      return {
        id: saved.id,
        invoiceId: saved.invoiceId,
        sellerId: saved.sellerId,
        price: saved.price,
        quantity: saved.quantity,
        status: saved.status,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      };
    });
  }

  async getListings(invoiceId?: string): Promise<SecondaryMarketListingSummary[]> {
    const query = this.dataSource.getRepository(SecondaryMarketListing).createQueryBuilder("listing");
    query.where("listing.status = :status", { status: SecondaryMarketListingStatus.ACTIVE });
    if (invoiceId) {
      query.andWhere("listing.invoice_id = :invoiceId", { invoiceId });
    }
    query.orderBy("listing.created_at", "DESC");

    const listings = await query.getMany();
    return listings.map((listing) => ({
      id: listing.id,
      invoiceId: listing.invoiceId,
      sellerId: listing.sellerId,
      price: listing.price,
      quantity: listing.quantity,
      status: listing.status,
      createdAt: listing.createdAt,
      updatedAt: listing.updatedAt,
    }));
  }

  async buyListing(input: BuySecondaryMarketListingInput): Promise<{
    listing: SecondaryMarketListingSummary;
    purchase: {
      id: string;
      invoiceId: string;
      listingId: string;
      sellerId: string;
      buyerId: string;
      quantity: string;
      totalPrice: string;
      status: SecondaryMarketPurchaseStatus;
      createdAt: Date;
    };
    totalPrice: string;
    quantity: string;
  }> {
    const quantity = parsePositiveDecimal(input.quantity, "quantity");

    return this.dataSource.transaction(async (manager: EntityManager) => {
      const listing = await manager.findOne(SecondaryMarketListing, {
        where: { id: input.listingId, status: SecondaryMarketListingStatus.ACTIVE },
      });
      if (!listing) {
        throw new ServiceError("LISTING_NOT_FOUND", "Listing not found or no longer active", 404);
      }
      if (listing.sellerId === input.buyerId) {
        throw new ServiceError("SELF_DEALING", "Buyers cannot purchase their own listing", 400);
      }

      const available = new Decimal(listing.quantity);
      if (quantity.gt(available)) {
        throw new ServiceError(
          "LISTING_OVER_PURCHASED",
          "Purchase quantity exceeds the remaining listing quantity",
          409,
          { available: available.toFixed(4), requested: quantity.toFixed(4) }
        );
      }

      const totalPrice = new Decimal(listing.price).times(quantity);
      const requestedPayment = input.paymentAmount ? parsePositiveDecimal(input.paymentAmount, "paymentAmount") : totalPrice;
      if (requestedPayment.lt(totalPrice)) {
        throw new ServiceError(
          "INSUFFICIENT_PAYMENT",
          "Payment amount is less than the total price for the requested quantity",
          400,
          { required: totalPrice.toFixed(4), provided: requestedPayment.toFixed(4) }
        );
      }

      const remainingQuantity = available.minus(quantity);
      listing.quantity = remainingQuantity.toFixed(4);
      if (remainingQuantity.lte(0)) {
        listing.status = SecondaryMarketListingStatus.SOLD;
      }
      await manager.save(listing);

      const purchase = manager.create(SecondaryMarketPurchase, {
        listingId: listing.id,
        invoiceId: listing.invoiceId,
        sellerId: listing.sellerId,
        buyerId: input.buyerId,
        quantity: quantity.toFixed(4),
        totalPrice: totalPrice.toFixed(4),
        status: SecondaryMarketPurchaseStatus.COMPLETED,
      });
      const savedPurchase = await manager.save(purchase);

      await this.transferOwnership(manager, listing.invoiceId, listing.sellerId, input.buyerId, quantity, input.buyerWallet ?? null);

      return {
        listing: {
          id: listing.id,
          invoiceId: listing.invoiceId,
          sellerId: listing.sellerId,
          price: listing.price,
          quantity: listing.quantity,
          status: listing.status,
          createdAt: listing.createdAt,
          updatedAt: listing.updatedAt,
        },
        purchase: {
          id: savedPurchase.id,
          invoiceId: savedPurchase.invoiceId,
          listingId: savedPurchase.listingId,
          sellerId: savedPurchase.sellerId,
          buyerId: savedPurchase.buyerId,
          quantity: savedPurchase.quantity,
          totalPrice: savedPurchase.totalPrice,
          status: savedPurchase.status,
          createdAt: savedPurchase.createdAt,
        },
        totalPrice: totalPrice.toFixed(4),
        quantity: quantity.toFixed(4),
      };
    });
  }

  async cancelListing(listingId: string, sellerId: string): Promise<SecondaryMarketListingSummary> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const listing = await manager.findOne(SecondaryMarketListing, { where: { id: listingId } });
      if (!listing) {
        throw new ServiceError("LISTING_NOT_FOUND", "Listing not found", 404);
      }
      if (listing.sellerId !== sellerId) {
        throw new ServiceError("LISTING_FORBIDDEN", "Only the listing owner can cancel the listing", 403);
      }
      if (listing.status !== SecondaryMarketListingStatus.ACTIVE) {
        throw new ServiceError("LISTING_ALREADY_INACTIVE", "Only active listings can be cancelled", 409);
      }

      listing.status = SecondaryMarketListingStatus.CANCELLED;
      const saved = await manager.save(listing);
      return {
        id: saved.id,
        invoiceId: saved.invoiceId,
        sellerId: saved.sellerId,
        price: saved.price,
        quantity: saved.quantity,
        status: saved.status,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      };
    });
  }

  private async getOwnedShareAmount(
    manager: EntityManager,
    invoiceId: string,
    sellerId: string
  ): Promise<Decimal> {
    const result = await manager
      .createQueryBuilder(Investment, "investment")
      .select("COALESCE(SUM(CAST(investment.investmentAmount AS DECIMAL)), '0')", "total")
      .where("investment.invoiceId = :invoiceId", { invoiceId })
      .andWhere("investment.investorId = :sellerId", { sellerId })
      .andWhere("investment.status IN (:...statuses)", {
        statuses: [InvestmentStatus.PENDING, InvestmentStatus.CONFIRMED],
      })
      .getRawOne();

    const total = new Decimal(result?.total ?? "0");
    return total.isFinite() ? total : new Decimal(0);
  }

  private async transferOwnership(
    manager: EntityManager,
    invoiceId: string,
    sellerId: string,
    buyerId: string,
    quantity: Decimal,
    buyerWallet: string | null
  ): Promise<void> {
    let remainingToTransfer = quantity;
    const sourceRows = await manager.find(Investment, {
      where: {
        invoiceId,
        investorId: sellerId,
        status: In([InvestmentStatus.PENDING, InvestmentStatus.CONFIRMED]),
      },
      order: { createdAt: "ASC" },
    });

    for (const row of sourceRows) {
      if (remainingToTransfer.lte(0)) break;
      const rowAmount = new Decimal(row.investmentAmount || "0");
      if (rowAmount.lte(0)) continue;

      const transferAmount = Decimal.min(rowAmount, remainingToTransfer);
      if (transferAmount.lte(0)) continue;

      const existingBuyerInvestment = await manager.findOne(Investment, {
        where: {
          invoiceId,
          investorId: buyerId,
          investorWallet: buyerWallet,
        },
      });

      if (existingBuyerInvestment) {
        existingBuyerInvestment.investmentAmount = new Decimal(existingBuyerInvestment.investmentAmount)
          .plus(transferAmount)
          .toFixed(4);
        await manager.save(existingBuyerInvestment);
      } else {
        const expectedReturnShare = new Decimal(row.expectedReturn || "0").times(
          transferAmount.dividedBy(rowAmount).isFinite() ? transferAmount.dividedBy(rowAmount) : 1
        );

        await manager.save(
          manager.create(Investment, {
            invoiceId,
            investorId: buyerId,
            investorWallet: buyerWallet,
            fundingBlock: row.fundingBlock,
            investmentAmount: transferAmount.toFixed(4),
            expectedReturn: expectedReturnShare.toFixed(4),
            status: row.status,
          })
        );
      }

      const updatedSellerAmount = rowAmount.minus(transferAmount);
      row.investmentAmount = updatedSellerAmount.toFixed(4);
      if (updatedSellerAmount.lte(0)) {
        row.status = InvestmentStatus.CANCELLED;
      }
      await manager.save(row);

      remainingToTransfer = remainingToTransfer.minus(transferAmount);
    }

    if (remainingToTransfer.gt(0)) {
      throw new ServiceError(
        "LISTING_TRANSFER_FAILED",
        "Unable to transfer the requested share quantity to the buyer",
        409,
        { remaining: remainingToTransfer.toFixed(4) }
      );
    }
  }
}

export function createSecondaryMarketService(dataSource: DataSource): SecondaryMarketService {
  return new SecondaryMarketService(dataSource);
}
