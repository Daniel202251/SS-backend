/**
 * Shared enums for entity status and type fields.
 */

export enum UserType {
  SELLER = "seller",
  INVESTOR = "investor",
  BOTH = "both",
}

export enum KYCStatus {
  PENDING = "pending",
  IN_REVIEW = "in_review",
  APPROVED = "approved",
  REJECTED = "rejected",
}

export enum InvoiceStatus {
  DRAFT = "draft",
  PENDING = "pending",
  PUBLISHED = "published",
  EXPIRED = "expired",
  FUNDED = "funded",
  SETTLED = "settled",
  CANCELLED = "cancelled",
  REJECTED = "rejected",
}

export enum InvestmentStatus {
  PENDING = "pending",
  CONFIRMED = "confirmed",
  SETTLED = "settled",
  CANCELLED = "cancelled",
}

export enum TransactionType {
  INVESTMENT = "investment",
  PAYMENT = "payment",
  WITHDRAWAL = "withdrawal",
  REFUND = "refund",
}

export enum TransactionStatus {
  PENDING = "pending",
  COMPLETED = "completed",
  FAILED = "failed",
}

export enum KYCVerificationType {
  IDENTITY = "identity",
  ADDRESS = "address",
  BUSINESS = "business",
}

export enum NotificationType {
  INVOICE = "invoice",
  INVESTMENT = "investment",
  PAYMENT = "payment",
  KYC = "kyc",
  SYSTEM = "system",
  INVOICE_REJECTED = "invoice_rejected",
  INVOICE_FUNDED = "invoice_funded",
  INVOICE_SETTLED = "invoice_settled",
  INVESTMENT_CREATED = "investment_created",
}
