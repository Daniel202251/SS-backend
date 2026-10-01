import { HttpError } from "../utils/http-error";
import { decodeCursor, encodeCursor } from "../utils/cursor-pagination.utils";
import type { DecodedSorobanEvent } from "../types/soroban.types";
import type { AtomicSwap } from "../models/AtomicSwap.model";
import {
  readEventNumber,
  readEventString,
  type ContractEventHandler,
} from "./contract-event-bus.service";

export const ATOMIC_SWAP_EVENTS = {
  executed: "atomic_swap_executed",
} as const;

export const SWAP_PAGE_MAX_LIMIT = 100;
export const SWAP_PAGE_DEFAULT_LIMIT = 25;

export interface SwapCursor {
  createdAt: Date;
  id: string;
}

export interface AtomicSwapInput {
  swapId: string;
  buyerAddress: string;
  sellerAddress: string;
  buyerInvoiceId: string | null;
  sellerInvoiceId: string | null;
  buyerAmount: string;
  sellerAmount: string;
  feeAmount: string;
  feeRecipient: string | null;
  txHash: string | null;
  ledgerSequence: string | null;
  executedAt: Date;
}

export interface SwapRepositoryContract {
  /**
   * Returns the wallet's swaps where it is buyer or seller, ordered by
   * (executed_at DESC, id DESC). Implementations receive `limit + 1` rows'
   * worth of work internally and report `hasMore`.
   */
  findByWallet(
    walletAddress: string,
    options: { limit: number; cursor: SwapCursor | null }
  ): Promise<{ items: AtomicSwap[]; hasMore: boolean }>;
  findById(id: string): Promise<AtomicSwap | null>;
  recordSwap(input: AtomicSwapInput): Promise<AtomicSwap | null>;
}

export interface SwapView {
  id: string;
  swapId: string;
  buyer: { address: string; invoiceId: string | null; amount: string };
  seller: { address: string; invoiceId: string | null; amount: string };
  fee: { amount: string; recipient: string | null };
  buyerAmount: string;
  sellerAmount: string;
  feeAmount: string;
  txHash: string | null;
  ledgerSequence: string | null;
  executedAt: string;
  timestamp: string;
}

export interface SwapHistoryResponse {
  data: SwapView[];
  meta: {
    total: number;
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export interface AtomicSwapServiceDependencies {
  swapRepository: SwapRepositoryContract;
  now?: () => Date;
}

/**
 * Read model for direct invoice-for-invoice exchanges, projected from
 * `AtomicSwapExecuted` contract events.
 */
export class AtomicSwapService implements ContractEventHandler {
  private readonly swapRepository: SwapRepositoryContract;
  private readonly now: () => Date;

  constructor({ swapRepository, now = () => new Date() }: AtomicSwapServiceDependencies) {
    this.swapRepository = swapRepository;
    this.now = now;
  }

  topics(): string[] {
    return [ATOMIC_SWAP_EVENTS.executed];
  }

  /**
   * GET /swaps/history — every swap where the authenticated wallet is either
   * the buyer or the seller, keyset-paginated on (executed_at, id).
   */
  async listForWallet(
    walletAddress: string,
    options: { limit?: number; cursor?: string | null } = {}
  ): Promise<SwapHistoryResponse> {
    const wallet = this.normalizeWallet(walletAddress);
    const limit = this.normalizeLimit(options.limit);

    let cursor: SwapCursor | null = null;
    if (options.cursor) {
      try {
        cursor = decodeCursor(options.cursor);
      } catch {
        throw new HttpError(400, "Invalid cursor.");
      }
    }

    const { items, hasMore } = await this.swapRepository.findByWallet(wallet, { limit, cursor });
    const data = items.map((item) => this.toView(item));
    const last = items[items.length - 1];

    return {
      data,
      meta: {
        total: data.length,
        limit,
        hasMore,
        // The cursor keys on executed_at to match the pagination index.
        nextCursor: hasMore && last ? encodeCursor(last.executedAt, last.id) : null,
      },
    };
  }

  /** GET /swaps/:id — public single swap lookup. */
  async getSwap(id: string): Promise<SwapView> {
    const swapId = this.normalizeId(id);
    const swap = await this.swapRepository.findById(swapId);
    if (!swap) {
      throw new HttpError(404, "Swap not found.");
    }
    return this.toView(swap);
  }

  /** Records a swap from an `AtomicSwapExecuted` event (idempotent on swapId). */
  async handle(event: DecodedSorobanEvent): Promise<void> {
    const topic = event.topic.toLowerCase();
    if (!topic.includes("swap")) return;

    const buyer = readEventString(event, ["buyer", "buyer_address", "from", "0"], 1);
    const seller = readEventString(event, ["seller", "seller_address", "to", "1"], 2);
    if (!buyer || !seller) return;

    const buyerAmount = readEventNumber(event, ["buyer_amount", "amount_from", "from_amount"]);
    const sellerAmount = readEventNumber(event, ["seller_amount", "amount_to", "to_amount"]);
    const fee = readEventNumber(event, ["fee", "fee_amount", "platform_fee"]);

    await this.swapRepository.recordSwap({
      swapId:
        readEventString(event, ["swap_id", "swapId", "id"], 3) ??
        event.txHash ??
        `${event.ledger}:${buyer}:${seller}`,
      buyerAddress: buyer,
      sellerAddress: seller,
      buyerInvoiceId: readEventString(event, ["buyer_invoice_id", "from_invoice_id"]),
      sellerInvoiceId: readEventString(event, ["seller_invoice_id", "to_invoice_id"]),
      buyerAmount: buyerAmount === null ? "0" : String(buyerAmount),
      sellerAmount: sellerAmount === null ? "0" : String(sellerAmount),
      feeAmount: fee === null ? "0" : String(fee),
      feeRecipient: readEventString(event, ["fee_recipient", "recipient"]),
      txHash: event.txHash ?? null,
      ledgerSequence: Number.isFinite(event.ledger) ? String(event.ledger) : null,
      executedAt: this.eventTime(event),
    });
  }

  private eventTime(event: DecodedSorobanEvent): Date {
    if (event.ledgerClosedAt) {
      const parsed = new Date(event.ledgerClosedAt);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return this.now();
  }

  private normalizeWallet(walletAddress: string): string {
    if (typeof walletAddress !== "string" || !walletAddress.trim()) {
      throw new HttpError(401, "A wallet address is required.");
    }
    return walletAddress.trim();
  }

  private normalizeId(id: string): string {
    if (typeof id !== "string" || !id.trim()) {
      throw new HttpError(400, "A swap id is required.");
    }
    return id.trim();
  }

  private normalizeLimit(limit?: number): number {
    if (!Number.isFinite(limit)) return SWAP_PAGE_DEFAULT_LIMIT;
    return Math.min(SWAP_PAGE_MAX_LIMIT, Math.max(1, Math.trunc(limit as number)));
  }

  private toView(swap: AtomicSwap): SwapView {
    const executedAt = new Date(swap.executedAt).toISOString();
    return {
      id: swap.id,
      swapId: swap.swapId,
      buyer: {
        address: swap.buyerAddress,
        invoiceId: swap.buyerInvoiceId ?? null,
        amount: swap.buyerAmount,
      },
      seller: {
        address: swap.sellerAddress,
        invoiceId: swap.sellerInvoiceId ?? null,
        amount: swap.sellerAmount,
      },
      fee: { amount: swap.feeAmount, recipient: swap.feeRecipient ?? null },
      buyerAmount: swap.buyerAmount,
      sellerAmount: swap.sellerAmount,
      feeAmount: swap.feeAmount,
      txHash: swap.txHash ?? null,
      ledgerSequence: swap.ledgerSequence ?? null,
      executedAt,
      timestamp: executedAt,
    };
  }
}

export function createAtomicSwapService(
  dependencies: AtomicSwapServiceDependencies
): AtomicSwapService {
  return new AtomicSwapService(dependencies);
}
