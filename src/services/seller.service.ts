import { DataSource, Repository } from "typeorm";
import Decimal from "decimal.js";
import { Invoice } from "../models/Invoice.model";
import { InvoiceStatus } from "../types/enums";

export interface SellerDashboardSummary {
  totalInvoices: number;
  totalFunded: number;
  totalSettled: number;
  totalRaised: string;
  totalRepaid: string;
}

export interface SellerDashboardInvoice {
  id: string;
  invoiceId: string;
  title: string;
  invoiceNumber: string;
  customerName: string;
  status: InvoiceStatus;
  amountRaised: string;
  fundedAmount: string;
  fundingTarget: string;
  fundingPercentage: number;
  fundingDeadline: Date;
  dueDate: Date;
  createdAt: Date;
}

export interface SellerDashboardData {
  totalInvoices: number;
  totalFunded: number;
  totalSettled: number;
  totalRaised: string;
  totalRepaid: string;
  summary: SellerDashboardSummary;
  invoices: SellerDashboardInvoice[];
}

export class SellerService {
  constructor(private readonly invoiceRepository: Repository<Invoice>) {}

  async getDashboard(sellerId: string): Promise<SellerDashboardData> {
    const invoices = await this.invoiceRepository.find({
      where: { sellerId },
      order: { createdAt: "DESC" },
    });

    let totalFunded = 0;
    let totalSettled = 0;
    let totalRaisedDec = new Decimal(0);
    let totalRepaidDec = new Decimal(0);

    const formattedInvoices: SellerDashboardInvoice[] = invoices.map((inv) => {
      if (inv.status === InvoiceStatus.FUNDED) {
        totalFunded++;
      } else if (inv.status === InvoiceStatus.SETTLED) {
        totalSettled++;
        totalRepaidDec = totalRepaidDec.plus(new Decimal(inv.netAmount || inv.amount || "0"));
      }

      const raised = new Decimal(inv.fundedAmount || "0");
      totalRaisedDec = totalRaisedDec.plus(raised);

      const targetDec = new Decimal(inv.netAmount || inv.amount || "0");
      const percentage = targetDec.gt(0)
        ? Math.min(100, Math.round(raised.dividedBy(targetDec).toNumber() * 10000) / 100)
        : 0;

      return {
        id: inv.id,
        invoiceId: inv.id,
        title: `${inv.invoiceNumber} - ${inv.customerName}`,
        invoiceNumber: inv.invoiceNumber,
        customerName: inv.customerName,
        status: inv.status,
        amountRaised: inv.fundedAmount || "0",
        fundedAmount: inv.fundedAmount || "0",
        fundingTarget: inv.netAmount || inv.amount,
        fundingPercentage: percentage,
        fundingDeadline: inv.dueDate,
        dueDate: inv.dueDate,
        createdAt: inv.createdAt,
      };
    });

    const summary: SellerDashboardSummary = {
      totalInvoices: invoices.length,
      totalFunded,
      totalSettled,
      totalRaised: totalRaisedDec.toFixed(4),
      totalRepaid: totalRepaidDec.toFixed(4),
    };

    return {
      ...summary,
      summary,
      invoices: formattedInvoices,
    };
  }
}

export function createSellerService(dataSource: DataSource): SellerService {
  return new SellerService(dataSource.getRepository(Invoice));
}
