import crypto from "crypto";
import { DataSource } from "typeorm";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { User } from "../../src/models/User.model";
import { InvoiceStatus, InvestmentStatus, UserType, KYCStatus } from "../../src/types/enums";
import { InvestmentService } from "../../src/services/investment.service";
import { ServiceError } from "../../src/utils/service-error";
import { createInvestmentService } from "../../src/services/investment.service";
import Decimal from "decimal.js";

describe("Investment optimistic locking concurrency (issue #143)", () => {
  let mockDataSource: Partial<DataSource>;
  let mockEntityManager: any;
  let mockInvoiceRepository: any;
  let mockInvestmentRepository: any;
  let investmentService: InvestmentService;

  const sellerId = "seller-123";
  const invoiceId = "invoice-456";
  const netAmount = "10000.0000";
  const faceAmount = "10000.0000";

  const createMockInvoice = (version = 1): Invoice => ({
    id: invoiceId,
    sellerId,
    invoiceNumber: "INV-001",
    customerName: "Test Customer",
    amount: faceAmount,
    discountRate: "0.00",
    netAmount,
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    ipfsHash: "QmTest",
    riskScore: null,
    status: InvoiceStatus.PUBLISHED,
    smartContractId: null,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    version,
    seller: {} as User,
    investments: [],
    transactions: [],
  } as Invoice);

  const createMockInvestment = (overrides: Partial<Investment> = {}): Investment => ({
    id: `inv-${crypto.randomUUID()}`,
    invoiceId,
    investorId: `investor-${crypto.randomUUID()}`,
    investmentAmount: "1000.0000",
    expectedReturn: "1000.0000",
    actualReturn: null,
    status: InvestmentStatus.PENDING,
    transactionHash: null,
    stellarOperationIndex: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    version: 1,
    invoice: {} as Invoice,
    investor: {} as User,
    transactions: [],
    ...overrides,
  } as Investment);

  beforeEach(() => {
    const invoices = new Map<string, Invoice>();
    const investments = new Map<string, Investment>();

    mockInvoiceRepository = {
      findOne: jest.fn().mockResolvedValue(createMockInvoice()),
      save: jest.fn().mockImplementation(async (invoice: Invoice) => {
        invoices.set(invoice.id, { ...invoice, version: invoice.version + 1 });
        return invoices.get(invoice.id)!;
      }),
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(createMockInvoice()),
      }),
    };

    mockInvestmentRepository = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation(async (investment: Investment) => {
        investments.set(investment.id, { ...investment, version: investment.version + 1 });
        return investments.get(investment.id)!;
      }),
      create: jest.fn().mockImplementation((data: Partial<Investment>) => data as Investment),
      createQueryBuilder: jest.fn().mockReturnValue({
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      }),
    };

    mockEntityManager = {
      getRepository: jest.fn((entity: any) => {
        if (entity === Invoice) return mockInvoiceRepository;
        if (entity === Investment) return mockInvestmentRepository;
        return {};
      }),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation(async (entity: any) => {
        if (entity instanceof Investment) {
          return mockInvestmentRepository.save(entity);
        }
        if (entity instanceof Invoice) {
          return mockInvoiceRepository.save(entity);
        }
        return entity;
      }),
      create: jest.fn().mockImplementation((entity: any, data: any) => {
        if (entity === Investment) return mockInvestmentRepository.create(data);
        return data;
      }),
      transaction: jest.fn().mockImplementation(async (callback: any) => {
        return await callback(mockEntityManager);
      }),
    };

    mockDataSource = {
      getRepository: jest.fn((entity: any) => {
        if (entity === Invoice) return mockInvoiceRepository;
        if (entity === Investment) return mockInvestmentRepository;
        return {};
      }),
      transaction: mockEntityManager.transaction,
    };

    investmentService = createInvestmentService(mockDataSource as DataSource);
  });

  it("handles 10 concurrent investment requests without over-subscription", async () => {
    const investorCount = 10;
    const investmentAmount = "1000.0000";
    const expectedTotal = new Decimal(investmentAmount).times(investorCount).toFixed(4);

    const results: Array<{ success: boolean; error?: string }> = [];

    // Simulate 10 concurrent investment attempts
    const promises = Array.from({ length: investorCount }, (_, i) =>
      investmentService
        .createInvestment({
          invoiceId,
          investorId: `investor-${i}`,
          investmentAmount,
          investorWallet: `GINVESTOR${i.toString().padStart(2, "0")}`,
        })
        .then(() => ({ success: true }))
        .catch((err: Error) => ({ success: false, error: err.message }))
    );

    const outcomes = await Promise.all(promises);
    results.push(...outcomes);

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    // All 10 should succeed since total (10,000) equals netAmount (10,000)
    expect(successful).toBe(investorCount);
    expect(failed).toBe(0);

    // Verify invoice was saved with FUNDED status after last investment
    expect(mockInvoiceRepository.save).toHaveBeenCalled();
  });

  it("rejects investments that exceed capacity under concurrent load", async () => {
    const investorCount = 11; // 11 * 1000 = 11,000 > 10,000 netAmount
    const investmentAmount = "1000.0000";

    const promises = Array.from({ length: investorCount }, (_, i) =>
      investmentService
        .createInvestment({
          invoiceId,
          investorId: `investor-${i}`,
          investmentAmount,
          investorWallet: `GINVESTOR${i.toString().padStart(2, "0")}`,
        })
        .then(() => ({ success: true }))
        .catch((err: Error) => ({ success: false, error: err.message, code: (err as any).code }))
    );

    const outcomes = await Promise.all(promises);
    const successful = outcomes.filter((r) => r.success).length;
    const failed = outcomes.filter((r) => !r.success).length;

    // Only 10 should succeed (10,000 capacity), 1 should fail with INSUFFICIENT_CAPACITY
    expect(successful).toBe(10);
    expect(failed).toBe(1);
    expect(outcomes.find((r) => !r.success)?.code).toBe("INSUFFICIENT_CAPACITY");
  });

  it("retries on optimistic lock version mismatch and eventually succeeds", async () => {
    let callCount = 0;
    const maxCalls = 3;

    // Mock transaction to fail with OptimisticLockVersionMismatchError twice, then succeed
    mockEntityManager.transaction.mockImplementation(async (callback: any) => {
      callCount++;
      if (callCount < maxCalls) {
        const { OptimisticLockVersionMismatchError } = await import("typeorm");
        throw new OptimisticLockVersionMismatchError("Version mismatch");
      }
      return await callback(mockEntityManager);
    });

    const result = await investmentService.createInvestment({
      invoiceId,
      investorId: "investor-1",
      investmentAmount: "1000.0000",
      investorWallet: "GINVESTOR01",
    });

    expect(result).toBeDefined();
    expect(callCount).toBe(maxCalls);
  });

  it("throws CONCURRENT_INVESTMENT_CONFLICT after max retries exhausted", async () => {
    // Mock transaction to always fail with OptimisticLockVersionMismatchError
    mockEntityManager.transaction.mockImplementation(async () => {
      const { OptimisticLockVersionMismatchError } = await import("typeorm");
      throw new OptimisticLockVersionMismatchError("Version mismatch");
    });

    await expect(
      investmentService.createInvestment({
        invoiceId,
        investorId: "investor-1",
        investmentAmount: "1000.0000",
        investorWallet: "GINVESTOR01",
      })
    ).rejects.toMatchObject({
      code: "CONCURRENT_INVESTMENT_CONFLICT",
      statusCode: 409,
    });
  });
});