export interface PaymentVerificationConfig {
  horizonUrl: string;
  usdcAssetCode: string;
  usdcAssetIssuer: string;
  escrowPublicKey: string;
  allowedAmountDelta: string;
  retryAttempts: number;
  retryBaseDelayMs: number;
}

const DEFAULT_ALLOWED_AMOUNT_DELTA = "0.0001";
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

export interface SorobanConfig {
  rpcUrl: string;
  networkPassphrase: string;
  escrowContractId: string;
  tokenContractId?: string;
  paymentDistributorContractId?: string;
  /** Issue #539 — gated-content contract backing subscription status reads. */
  subscriptionContractId?: string;
  platformSecretKey?: string;
  platformFeeRecipient?: string;
  platformFeeBps: number;
}

export function getSorobanConfig(): SorobanConfig {
  const rpcUrl =
    process.env.STELLAR_RPC_URL ??
    process.env.SOROBAN_RPC_URL ??
    "https://soroban-testnet.stellar.org";

  const networkPassphrase =
    process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

  const escrowContractId =
    process.env.SOROBAN_ESCROW_CONTRACT_ID ??
    process.env.ESCROW_CONTRACT_ID ??
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

  const tokenContractId = process.env.SOROBAN_TOKEN_CONTRACT_ID ?? process.env.TOKEN_CONTRACT_ID;

  const paymentDistributorContractId =
    process.env.SOROBAN_PAYMENT_DISTRIBUTOR_CONTRACT_ID ??
    process.env.PAYMENT_DISTRIBUTOR_CONTRACT_ID;

  const subscriptionContractId =
    process.env.SOROBAN_SUBSCRIPTION_CONTRACT_ID ?? process.env.SUBSCRIPTION_CONTRACT_ID;

  const platformSecretKey =
    process.env.STELLAR_PLATFORM_SECRET_KEY ?? process.env.PLATFORM_SECRET_KEY;
  const platformFeeRecipient = process.env.PLATFORM_FEE_RECIPIENT;
  const platformFeeBps = Number(process.env.PLATFORM_FEE_BPS ?? "0");
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 10_000) {
    throw new Error("PLATFORM_FEE_BPS must be an integer between 0 and 10000.");
  }

  return {
    rpcUrl,
    networkPassphrase,
    escrowContractId,
    tokenContractId,
    paymentDistributorContractId,
    subscriptionContractId,
    platformSecretKey,
    platformFeeRecipient,
    platformFeeBps,
  };
}

export function getPaymentVerificationConfig(): PaymentVerificationConfig {
  return {
    horizonUrl: requireEnv(process.env.STELLAR_HORIZON_URL, "STELLAR_HORIZON_URL"),
    usdcAssetCode: requireEnv(process.env.STELLAR_USDC_ASSET_CODE, "STELLAR_USDC_ASSET_CODE"),
    usdcAssetIssuer: requireEnv(process.env.STELLAR_USDC_ASSET_ISSUER, "STELLAR_USDC_ASSET_ISSUER"),
    escrowPublicKey: requireEnv(process.env.STELLAR_ESCROW_PUBLIC_KEY, "STELLAR_ESCROW_PUBLIC_KEY"),
    allowedAmountDelta:
      process.env.STELLAR_VERIFY_ALLOWED_AMOUNT_DELTA ?? DEFAULT_ALLOWED_AMOUNT_DELTA,
    retryAttempts: parsePositiveInteger(
      process.env.STELLAR_VERIFY_RETRY_ATTEMPTS,
      DEFAULT_RETRY_ATTEMPTS,
      "STELLAR_VERIFY_RETRY_ATTEMPTS"
    ),
    retryBaseDelayMs: parsePositiveInteger(
      process.env.STELLAR_VERIFY_RETRY_BASE_DELAY_MS,
      DEFAULT_RETRY_BASE_DELAY_MS,
      "STELLAR_VERIFY_RETRY_BASE_DELAY_MS"
    ),
  };
}
