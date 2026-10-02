export class HorizonValidationError extends Error {
  readonly code = "invalid_horizon_response";

  constructor(message: string) {
    super(message);
    this.name = "HorizonValidationError";
  }
}

export interface NormalizedHorizonTransaction {
  successful: boolean;
  hash: string | null;
  memo: string | null;
  memoType: string | null;
}

export interface NormalizedHorizonPayment {
  id: string | null;
  type: string;
  amount: string | null;
  destination: string | null;
  assetCode: string | null;
  assetIssuer: string | null;
  memo: string | null;
  memoType: string | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function normalizeHorizonTransaction(value: unknown): NormalizedHorizonTransaction {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { successful?: unknown }).successful !== "boolean"
  ) {
    throw new HorizonValidationError("Horizon transaction is missing required successful field");
  }
  const transaction = value as Record<string, unknown>;
  return {
    successful: transaction.successful as boolean,
    hash: optionalString(transaction.hash),
    memo: optionalString(transaction.memo),
    memoType: optionalString(transaction.memo_type ?? transaction.memoType),
  };
}

export function normalizeHorizonPayment(value: unknown): NormalizedHorizonPayment {
  if (typeof value !== "object" || value === null) {
    throw new HorizonValidationError("Horizon payment must be an object");
  }
  const payment = value as Record<string, unknown>;
  if (
    typeof payment.type !== "string" ||
    typeof payment.amount !== "string" ||
    typeof payment.to !== "string"
  ) {
    throw new HorizonValidationError(
      "Horizon payment is missing required type, amount, or destination"
    );
  }
  return {
    id: optionalString(payment.id),
    type: payment.type,
    amount: payment.amount,
    destination: payment.to,
    assetCode: optionalString(payment.asset_code ?? payment.assetCode),
    assetIssuer: optionalString(payment.asset_issuer ?? payment.assetIssuer),
    memo: optionalString(payment.memo),
    memoType: optionalString(payment.memo_type ?? payment.memoType),
  };
}
