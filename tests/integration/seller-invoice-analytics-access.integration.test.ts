import crypto from "crypto";
import { InvoiceService, InvoiceServiceDependencies } from "../../src/services/invoice.service";
import { InvestmentService } from "../../src/services/investment.service";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { User } from "../../src/models/User.model";
import { InvoiceStatus, InvestmentStatus, UserType, KYCStatus } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";
import type { IPFSService } from "../../src/services/ipfs.service";

/**
 * In-memory repositories for integration testing
 */
type InvoiceRepository = InvoiceServiceDependencies["invoiceRepository"];

class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly invoices = new Map<string, Invoice>();

  async findOne(options: { where: { id: string }; relations?: string[] }) {
    const invoice = this.invoices.get(options.where.id) ?? null;
    if (invoice && options.relations?.includes("seller")) {
      invoice.seller = { id: invoice.sellerId } as unknown as User;
    }
    if (invoice && options.relations?.includes("investments")) {
      invoice.investments = [];
    }
    return invoice;
  }

  async findOneBy(options: { id?: string; invoiceNumber?: string }) {
    for (const invoice of this.invoices.values()) {
      if (options.id && invoice.id === options.id) return invoice;
      if (options.invoiceNumber && invoice.invoiceNumber === options.invoiceNumber) return invoice;
    }
    return null;
  }

  async find(options: {
    where: { sellerId?: string; status?: InvoiceStatus; id?: ReturnType<typeof import("typeorm").In<string>> };
    skip?: number;
    take?: number;
    order?: Record<string, "ASC" | "DESC">;
    relations?: string[];
  }) {
    return [...this.invoices.values()].filter((inv) => {
      if (options.where.sellerId && inv.sellerId !== options.where.sellerId) return false;
      if (options.where.status && inv.status !== options.where.status) return false;
      if (options.where.id && Array.isArray(options.where.id)) {
        if (!options.where.id.includes(inv.id)) return false;
      }
      return true;
    });
  }

  async save(invoice: Invoice) {
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  async count(options: { where: { sellerId: string; status?: InvoiceStatus } }) {
    return (await this.find({ where: options.where })).length;
  }

  create(data: Partial<Invoice>): Invoice {
    return { id: crypto.randomUUID(), ...data } as Invoice;
  }

  seed(invoice: Invoice) {
    this.invoices.set(invoice.id, invoice);
  }
}

class InMemoryInvestmentRepository {
  private readonly investments = new Map<string, Investment>();

  async find(options: { where: { invoiceId: string; status?: InvestmentStatus } }) {
    return [...this.investments.values()].filter((inv) => {
      if (inv.invoiceId !== options.where.invoiceId) return false;
      if (options.where.status && inv.status !== options.where.status) return false;
      return true;
    });
  }

  createQueryBuilder(alias: string) {
    const self = this;
    const queryBuilder: any = {
      leftJoinAndSelect: function() { return queryBuilder; },
      where: function(condition: string, params: { invoiceId: string }) {
        queryBuilder.filtered = [...self.investments.values()].filter((inv) => inv.invoiceId === params.invoiceId);
        return queryBuilder;
      },
      andWhere: function() { return queryBuilder; },
      getMany: async () => queryBuilder.filtered || [],
      filtered: [] as Investment[],
    };
    return queryBuilder;
  }

  seed(investment: Investment) {
    this.investments.set(investment.id, investment);
  }

  getRepository() {
    return this;
  }
}

function noopIpfsService(): IPFSService {
  return {
    uploadFile: async () => ({ hash: "QmTest", size: 0, url: "https://ipfs.test" }),
  } as unknown as IPFSService;
}

function makeSeller(overrides: Partial<User> = {}): User {
  return {
    id: crypto.randomUUID(),
    stellarAddress: `G${crypto.randomBytes(28).toString("hex").toUpperCase().slice(0, 55)}`,
    email: "seller@example.com",
    userType: UserType.SELLER,
    kycStatus: KYCStatus.APPROVED,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    version: 0,
    invoices: [],
    investments: [],
    transactions: [],
    kycVerifications: [],
    notifications: [],
    ...overrides,
  } as User;
}

function makeInvestor(overrides: Partial<User> = {}): User {
  return {
    id: crypto.randomUUID(),
    stellarAddress: `G${crypto.randomBytes(28).toString("hex").toUpperCase().slice(0, 55)}`,
    email: "investor@example.com",
    userType: UserType.INVESTOR,
    kycStatus: KYCStatus.APPROVED,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    version: 0,
    invoices: [],
    investments: [],
    transactions: [],
    kycVerifications: [],
    notifications: [],
    ...overrides,
  } as User;
}

function createInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    sellerId: crypto.randomUUID(),
    invoiceNumber: `INV-${crypto.randomBytes(4).toString("hex")}`,
    customerName: "Test Customer",
    amount: "10000.0000",
    discountRate: "5.00",
    netAmount: "9500.0000",
    dueDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    ipfsHash: "QmValidDocumentHash",
    riskScore: null,
    status: InvoiceStatus.PUBLISHED,
    smartContractId: null,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 0,
    seller: undefined as unknown as Invoice["seller"],
    investments: [],
    transactions: [],
    ...overrides,
  } as Invoice;
}

function createInvestment(invoiceId: string, investor: User, amount: string): Investment {
  return {
    id: crypto.randomUUID(),
    invoiceId,
    investorId: investor.id,
    investmentAmount: amount,
    expectedReturn: amount,
    actualReturn: null,
    status: InvestmentStatus.CONFIRMED,
    transactionHash: null,
    stellarOperationIndex: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    version: 0,
    invoice: undefined as unknown as Investment["invoice"],
    investor,
    transactions: [],
  } as Investment;
}

describe("Invoice analytics access control (issue #186)", () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let investmentRepo: InMemoryInvestmentRepository;
  let invoiceService: InvoiceService;
  let dataSourceMock: any;

  beforeEach(() => {
    invoiceRepo = new InMemoryInvoiceRepository();
    investmentRepo = new InMemoryInvestmentRepository();

    dataSourceMock = {
      getRepository: () => investmentRepo.getRepository(),
    };

    invoiceService = new InvoiceService({
      invoiceRepository: invoiceRepo,
      ipfsService: noopIpfsService(),
      dataSource: dataSourceMock,
    });
  });

  it("returns 403 with error code 'forbidden' when seller B accesses seller A's invoice analytics", async () => {
    // Seed seller A (owner)
    const sellerA = makeSeller();
    // Seed seller B (different seller)
    const sellerB = makeSeller();
    // Seed investor
    const investor = makeInvestor();

    // Create invoice owned by seller A
    const invoice = createInvoice({
      sellerId: sellerA.id,
      status: InvoiceStatus.PUBLISHED,
      seller: sellerA,
    });
    invoiceRepo.seed(invoice);

    // Add investment (analytics data)
    const investment = createInvestment(invoice.id, investor, "5000.0000");
    investmentRepo.seed(investment);

    // Seller B tries to access seller A's invoice analytics
    await expect(
      invoiceService.getInvoiceTokenHolders(invoice.id, sellerB.id)
    ).rejects.toMatchObject({
      code: "forbidden",
      statusCode: 403,
    });
  });

  it("returns analytics data (200 equivalent) when seller A accesses their own invoice analytics", async () => {
    const sellerA = makeSeller();
    const investor = makeInvestor();

    const invoice = createInvoice({
      sellerId: sellerA.id,
      status: InvoiceStatus.PUBLISHED,
      seller: sellerA,
    });
    invoiceRepo.seed(invoice);

    const investment = createInvestment(invoice.id, investor, "5000.0000");
    investmentRepo.seed(investment);

    // Seller A accesses their own invoice analytics
    const result = await invoiceService.getInvoiceTokenHolders(invoice.id, sellerA.id);

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0]).toHaveProperty("wallet");
    expect(result[0]).toHaveProperty("amount");
    expect(result[0]).toHaveProperty("share_percent");
    expect(result[0]).toHaveProperty("committed_at");
    expect(result[0].amount).toBe("5000.0000");
    expect(result[0].share_percent).toBe("100.00");
  });

  it("returns 404 when invoice does not exist", async () => {
    const sellerA = makeSeller();
    const nonExistentInvoiceId = crypto.randomUUID();

    await expect(
      invoiceService.getInvoiceTokenHolders(nonExistentInvoiceId, sellerA.id)
    ).rejects.toMatchObject({
      code: "invoice_not_found",
      statusCode: 404,
    });
  });

  it("returns 400 when invoice is in DRAFT status", async () => {
    const sellerA = makeSeller();

    const invoice = createInvoice({
      sellerId: sellerA.id,
      status: InvoiceStatus.DRAFT,
      seller: sellerA,
    });
    invoiceRepo.seed(invoice);

    await expect(
      invoiceService.getInvoiceTokenHolders(invoice.id, sellerA.id)
    ).rejects.toMatchObject({
      code: "invalid_invoice_status",
      statusCode: 400,
    });
  });

  it("returns empty array when invoice has no investments", async () => {
    const sellerA = makeSeller();

    const invoice = createInvoice({
      sellerId: sellerA.id,
      status: InvoiceStatus.PUBLISHED,
      seller: sellerA,
    });
    invoiceRepo.seed(invoice);

    const result = await invoiceService.getInvoiceTokenHolders(invoice.id, sellerA.id);

    expect(result).toEqual([]);
  });

  it("correctly calculates share percentages for multiple investors", async () => {
    const sellerA = makeSeller();
    const investor1 = makeInvestor();
    const investor2 = makeInvestor();
    const investor3 = makeInvestor();

    const invoice = createInvoice({
      sellerId: sellerA.id,
      status: InvoiceStatus.PUBLISHED,
      seller: sellerA,
    });
    invoiceRepo.seed(invoice);

    // Three investors: 5000, 3000, 2000 = total 10000
    investmentRepo.seed(createInvestment(invoice.id, investor1, "5000.0000"));
    investmentRepo.seed(createInvestment(invoice.id, investor2, "3000.0000"));
    investmentRepo.seed(createInvestment(invoice.id, investor3, "2000.0000"));

    const result = await invoiceService.getInvoiceTokenHolders(invoice.id, sellerA.id);

    expect(result).toHaveLength(3);
    const shares = result.map((r) => parseFloat(r.share_percent)).sort((a, b) => b - a);
    expect(shares).toEqual([50.0, 30.0, 20.0]);
    const sum = shares.reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });
});