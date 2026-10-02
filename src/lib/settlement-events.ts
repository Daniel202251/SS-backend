import { EventEmitter } from "events";

export interface InvestorReturnRecord {
  investmentId: string;
  investorId: string;
  investorWallet?: string | null;
  returnAmount: string;
}

export interface SettlementEventPayload {
  invoiceId: string;
  sellerId: string;
  totalSettlementAmount: string;
  totalDistributedAmount: string;
  remainderAmount: string;
  settledAt: Date;
  distributionTransactionHash?: string | null;
  returns: InvestorReturnRecord[];
}

export type SettlementEventListener = (event: SettlementEventPayload) => void | Promise<void>;

export class SettlementEventEmitter extends EventEmitter {
  emitSettlement(event: SettlementEventPayload): boolean {
    this.emit("invoice.settled", event);
    return this.emit("settlement", event);
  }
}

export const settlementEventEmitter = new SettlementEventEmitter();
