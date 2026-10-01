import { InvoiceExtensionService } from "../../src/services/invoice-extension.service";
import { ExtensionRequestStatus, InvoiceStatus } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";

describe("InvoiceExtensionService (issue #477)", () => {
  function makeService(opts: {
    invoice?: Record<string, unknown> | null;
    pending?: Record<string, unknown> | null;
  }) {
    const requestRepo = {
      findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.status === ExtensionRequestStatus.PENDING) return opts.pending ?? null;
        return null;
      }),
      create: jest.fn((data: Record<string, unknown>) => ({
        id: "req-1",
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      })),
      save: jest.fn(async (row: Record<string, unknown>) => row),
    };
    const invoiceRepo = {
      findOne: jest.fn(async () => opts.invoice ?? null),
      save: jest.fn(async (row: Record<string, unknown>) => row),
    };
    const investmentRepo = { find: jest.fn().mockResolvedValue([]) };
    const dataSource = {
      getRepository: jest.fn((entity: { name?: string }) => {
        if (entity?.name === "InvoiceExtensionRequest" || entity === requestRepo) return requestRepo;
        // TypeORM passes the class; match by checking known repos order of construction.
        return null;
      }),
      transaction: jest.fn(),
    };

    // Constructor calls getRepository three times in order: request, invoice, investment.
    let call = 0;
    dataSource.getRepository = jest.fn(() => {
      call += 1;
      if (call === 1) return requestRepo;
      if (call === 2) return invoiceRepo;
      return investmentRepo;
    }) as any;

    return {
      service: new InvoiceExtensionService(dataSource as never),
      requestRepo,
      invoiceRepo,
    };
  }

  it("rejects extension on funded invoices with 422", async () => {
    const { service } = makeService({
      invoice: {
        id: "inv-1",
        sellerId: "seller-1",
        status: InvoiceStatus.FUNDED,
        fundingDeadline: new Date("2026-05-01T00:00:00.000Z"),
      },
    });
    await expect(
      service.requestExtension({
        invoiceId: "inv-1",
        sellerId: "seller-1",
        proposedDeadline: new Date(Date.now() + 86_400_000),
      })
    ).rejects.toMatchObject({ code: "EXTENSION_NOT_ALLOWED", statusCode: 422 });
  });

  it("rejects a second pending extension request", async () => {
    const { service } = makeService({
      invoice: {
        id: "inv-1",
        sellerId: "seller-1",
        status: InvoiceStatus.PUBLISHED,
        fundingDeadline: new Date("2026-05-01T00:00:00.000Z"),
      },
      pending: { id: "existing", status: ExtensionRequestStatus.PENDING },
    });
    await expect(
      service.requestExtension({
        invoiceId: "inv-1",
        sellerId: "seller-1",
        proposedDeadline: new Date(Date.now() + 86_400_000),
      })
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(
      service.requestExtension({
        invoiceId: "inv-1",
        sellerId: "seller-1",
        proposedDeadline: new Date(Date.now() + 86_400_000),
      })
    ).rejects.toMatchObject({ code: "EXTENSION_PENDING", statusCode: 409 });
  });
});
