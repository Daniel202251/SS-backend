import crypto from "crypto";
import express from "express";
import request from "supertest";
import type { DataSource } from "typeorm";

import {
  buildInvestmentCreatedNotifications,
  createInvestmentNotifier,
  createInvestorDirectory,
  createInvestorNotificationEffect,
  type InvestorDirectory,
  type NotificationInput,
} from "../../src/lib/invoice-notifications";
import {
  createInvoiceStateMachine,
  type InvoiceTransitionStore,
} from "../../src/lib/invoice-state-machine";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { Investment } from "../../src/models/Investment.model";
import type { Invoice } from "../../src/models/Invoice.model";
import type { Notification } from "../../src/models/Notification.model";
import type { AppLogger } from "../../src/observability/logger";
import { createNotificationRouter } from "../../src/routes/notification.routes";
import type { AuthService } from "../../src/services/auth.service";
import { InvestmentService } from "../../src/services/investment.service";
import {
  createNotificationService,
  NotificationService,
  type NotificationRepositoryContract,
} from "../../src/services/notification.service";
import {
  InvestmentStatus,
  InvoiceStatus,
  KYCStatus,
  NotificationType,
  UserType,
} from "../../src/types/enums";

const SELLER_ID = "seller-1";

function createMockLogger(): jest.Mocked<AppLogger> {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  } as unknown as jest.Mocked<AppLogger>;
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: crypto.randomUUID(),
    sellerId: SELLER_ID,
    invoiceNumber: "INV-467",
    customerName: "Acme Ltd",
    amount: "1000.0000",
    discountRate: "5.00",
    netAmount: "950.0000",
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ipfsHash: "QmDoc",
    riskScore: null,
    status: InvoiceStatus.PUBLISHED,
    smartContractId: null,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    version: 1,
    ...overrides,
  } as Invoice;
}

/** In-memory repository implementing the full NotificationRepositoryContract. */
function createInMemoryRepository() {
  const store: Notification[] = [];
  const repo: NotificationRepositoryContract = {
    async create(userId, type, title, message) {
      const row = {
        id: crypto.randomUUID(),
        userId,
        type,
        title,
        message,
        read: false,
        timestamp: new Date(),
      } as Notification;
      store.push(row);
      return row;
    },
    async createMany(entries) {
      for (const entry of entries)
        await repo.create(entry.userId, entry.type, entry.title, entry.message);
    },
    async findByIdAndUserId(id, userId) {
      return store.find((n) => n.id === id && n.userId === userId) ?? null;
    },
    async markRead(id, userId) {
      const row = store.find((n) => n.id === id && n.userId === userId)!;
      row.read = true;
      return row;
    },
    async markAllRead(userId) {
      const unread = store.filter((n) => n.userId === userId && !n.read);
      unread.forEach((n) => (n.read = true));
      return unread.length;
    },
    async countUnread(userId) {
      return store.filter((n) => n.userId === userId && !n.read).length;
    },
    async list({ userId }) {
      const data = store.filter((n) => n.userId === userId);
      return { data, meta: { total: data.length, page: 1, limit: 20, totalPages: 1 } };
    },
  };
  return { repo, store };
}

function fakeStore(): InvoiceTransitionStore {
  return { saveInvoice: async (invoice) => invoice, recordHistory: async (e) => e as never };
}

describe("notification service (#467)", () => {
  describe("lifecycle events", () => {
    const directory = (ids: string[]): InvestorDirectory => ({
      findInvestorIds: jest.fn().mockResolvedValue(ids),
    });

    function machineWith(service: NotificationService, investors: InvestorDirectory) {
      return createInvoiceStateMachine({
        notificationSink: service,
        logger: createMockLogger(),
        effects: [createInvestorNotificationEffect(service, investors)],
      });
    }

    it("notifies the seller and every investor when an invoice is funded", async () => {
      const { repo, store } = createInMemoryRepository();
      const service = new NotificationService(repo);
      const machine = machineWith(service, directory(["investor-a", "investor-b"]));
      const invoice = makeInvoice();

      await machine.transitionAndDispatch(fakeStore(), invoice, InvoiceStatus.FUNDED, {
        actor: { role: "system" },
        trigger: "fully_funded",
        context: { fundedAmount: "950" },
      });

      expect(store.map((n) => [n.userId, n.type])).toEqual([
        [SELLER_ID, NotificationType.INVOICE_FUNDED],
        ["investor-a", NotificationType.INVOICE_FUNDED],
        ["investor-b", NotificationType.INVOICE_FUNDED],
      ]);
      expect(store.every((n) => n.message.includes("INV-467"))).toBe(true);
    });

    it("notifies the seller and every investor when an invoice is settled", async () => {
      const { repo, store } = createInMemoryRepository();
      const service = new NotificationService(repo);
      const machine = machineWith(service, directory(["investor-a"]));

      await machine.transitionAndDispatch(
        fakeStore(),
        makeInvoice({ status: InvoiceStatus.FUNDED }),
        InvoiceStatus.SETTLED,
        { actor: { role: "system" }, trigger: "admin_settled" }
      );

      expect(store.map((n) => [n.userId, n.type, n.title])).toEqual([
        [SELLER_ID, NotificationType.INVOICE_SETTLED, "Invoice Settled"],
        ["investor-a", NotificationType.INVOICE_SETTLED, "Invoice Settled"],
      ]);
    });

    it("notifies only the seller when an invoice is rejected", async () => {
      const { repo, store } = createInMemoryRepository();
      const service = new NotificationService(repo);
      const investors = directory(["investor-a"]);
      const machine = machineWith(service, investors);

      await machine.transitionAndDispatch(
        fakeStore(),
        makeInvoice({ status: InvoiceStatus.PENDING }),
        InvoiceStatus.REJECTED,
        { actor: { role: "admin" }, trigger: "admin_rejected", context: { reason: "Forged PO" } }
      );

      expect(store).toHaveLength(1);
      expect(store[0]).toMatchObject({
        userId: SELLER_ID,
        type: NotificationType.INVOICE_REJECTED,
        title: "Invoice Rejected",
      });
      expect(store[0].message).toContain("Forged PO");
      expect(investors.findInvestorIds).not.toHaveBeenCalled();
    });

    it("sends each lifecycle notification once even if the transition is dispatched again", async () => {
      const { repo, store } = createInMemoryRepository();
      const service = new NotificationService(repo);
      const machine = machineWith(service, directory(["investor-a"]));

      const transition = await machine.transition(
        fakeStore(),
        makeInvoice(),
        InvoiceStatus.FUNDED,
        {
          actor: { role: "system" },
          trigger: "fully_funded",
          context: { fundedAmount: "950" },
        }
      );
      await machine.dispatch(transition);
      await machine.dispatch(transition);

      expect(store).toHaveLength(2);
    });

    describe("new investment", () => {
      function createFakeDataSource(invoice: Invoice, failCommit = false) {
        const manager = {
          createQueryBuilder: () => {
            const builder = {
              setLock: () => builder,
              where: () => builder,
              getOne: async () => invoice,
            };
            return builder;
          },
          find: async () => [],
          create: (_entity: unknown, data: object) => ({ id: "investment-1", ...data }),
          save: async (_entity: unknown, value: unknown) => value,
        };
        return {
          transaction: async (work: (m: typeof manager) => Promise<unknown>) => {
            const result = await work(manager);
            if (failCommit) throw new Error("commit failed");
            return result;
          },
        } as unknown as DataSource;
      }

      const input = (invoice: Invoice, amount = "100") => ({
        invoiceId: invoice.id,
        investorId: "investor-a",
        investmentAmount: amount,
        investorWallet: "GINVESTOR0000000000000000000000000000000000000000000000",
      });

      it("notifies both the investor and the seller", async () => {
        const { repo, store } = createInMemoryRepository();
        const invoice = makeInvoice();
        const service = new InvestmentService(
          createFakeDataSource(invoice),
          createInvoiceStateMachine({ logger: createMockLogger() }),
          createInvestmentNotifier(new NotificationService(repo))
        );

        await service.createInvestment(input(invoice));

        expect(store.map((n) => [n.userId, n.type, n.title])).toEqual([
          ["investor-a", NotificationType.INVESTMENT_CREATED, "Investment Recorded"],
          [SELLER_ID, NotificationType.INVESTMENT_CREATED, "New Investment"],
        ]);
        expect(store[0].message).toContain("100.0000");
        expect(store[1].message).toContain("INV-467");
      });

      it("sends the investment and funded notifications when the last share is bought", async () => {
        const { repo, store } = createInMemoryRepository();
        const notifications = new NotificationService(repo);
        const invoice = makeInvoice();
        const service = new InvestmentService(
          createFakeDataSource(invoice),
          machineWith(notifications, directory(["investor-a"])),
          createInvestmentNotifier(notifications)
        );

        await service.createInvestment(input(invoice, "950"));

        expect(store.map((n) => [n.userId, n.type])).toEqual([
          ["investor-a", NotificationType.INVESTMENT_CREATED],
          [SELLER_ID, NotificationType.INVESTMENT_CREATED],
          [SELLER_ID, NotificationType.INVOICE_FUNDED],
          ["investor-a", NotificationType.INVOICE_FUNDED],
        ]);
      });

      it("sends nothing when the investment does not commit", async () => {
        const { repo, store } = createInMemoryRepository();
        const invoice = makeInvoice();
        const service = new InvestmentService(
          createFakeDataSource(invoice, true),
          createInvoiceStateMachine({ logger: createMockLogger() }),
          createInvestmentNotifier(new NotificationService(repo))
        );

        await expect(service.createInvestment(input(invoice))).rejects.toThrow("commit failed");
        expect(store).toHaveLength(0);
      });

      it("does not fail the investment when notifications cannot be stored", async () => {
        const log = createMockLogger();
        const notifier = createInvestmentNotifier(
          { createNotifications: jest.fn().mockRejectedValue(new Error("db down")) },
          log
        );

        await expect(
          notifier.investmentCreated({
            invoice: makeInvoice(),
            investment: { id: "i-1", investorId: "investor-a", investmentAmount: "10" },
          })
        ).resolves.toBeUndefined();
        expect(log.warn).toHaveBeenCalledWith(
          "Failed to send new-investment notifications.",
          expect.objectContaining({ error: "db down" })
        );
      });

      it("builds one notification per party", () => {
        const entries: NotificationInput[] = buildInvestmentCreatedNotifications({
          invoice: makeInvoice(),
          investment: { id: "i-1", investorId: "investor-a", investmentAmount: "12.5" },
        });
        expect(entries.map((e) => e.userId)).toEqual(["investor-a", SELLER_ID]);
      });
    });
  });

  describe("investor directory", () => {
    it("returns each staked investor once", async () => {
      const find = jest
        .fn()
        .mockResolvedValue([{ investorId: "a" }, { investorId: "b" }, { investorId: "a" }]);
      const dataSource = { getRepository: jest.fn(() => ({ find })) } as unknown as DataSource;

      const ids = await createInvestorDirectory(dataSource).findInvestorIds("invoice-1");

      expect(ids).toEqual(["a", "b"]);
      expect(dataSource.getRepository).toHaveBeenCalledWith(Investment);
      const where = find.mock.calls[0][0].where;
      expect(where.invoiceId).toBe("invoice-1");
      expect(where.status.value).toEqual([
        InvestmentStatus.PENDING,
        InvestmentStatus.CONFIRMED,
        InvestmentStatus.SETTLED,
      ]);
    });
  });

  describe("TypeORM repository", () => {
    function createServiceWithRepository() {
      const repository = {
        insert: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue({ affected: 3 }),
        count: jest.fn().mockResolvedValue(7),
      };
      const dataSource = { getRepository: () => repository } as unknown as DataSource;
      return { service: createNotificationService(dataSource), repository };
    }

    it("marks all unread notifications read with a single UPDATE scoped to the user", async () => {
      const { service, repository } = createServiceWithRepository();

      await expect(service.markAllNotificationsRead("user-1")).resolves.toEqual({ updated: 3 });

      expect(repository.update).toHaveBeenCalledTimes(1);
      expect(repository.update).toHaveBeenCalledWith(
        { userId: "user-1", read: false },
        { read: true }
      );
    });

    it("counts only the user's unread notifications", async () => {
      const { service, repository } = createServiceWithRepository();

      await expect(service.getUnreadCount("user-1")).resolves.toEqual({ unread: 7 });
      expect(repository.count).toHaveBeenCalledWith({ where: { userId: "user-1", read: false } });
    });

    it("inserts bulk notifications in one statement and skips empty batches", async () => {
      const { service, repository } = createServiceWithRepository();
      const entries = [
        { userId: "a", type: NotificationType.INVOICE_SETTLED, title: "t", message: "m" },
        { userId: "b", type: NotificationType.INVOICE_SETTLED, title: "t", message: "m" },
      ];

      await service.createNotifications(entries);
      await service.createNotifications([]);

      expect(repository.insert).toHaveBeenCalledTimes(1);
      expect(repository.insert).toHaveBeenCalledWith(entries);
    });
  });

  describe("HTTP endpoints", () => {
    function buildApp() {
      const { repo, store } = createInMemoryRepository();
      const service = new NotificationService(repo);
      const authService = {
        getCurrentUser: async (token: string) => ({
          id: token,
          stellarAddress: `G${token}`,
          email: null,
          userType: UserType.INVESTOR,
          kycStatus: KYCStatus.APPROVED,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      } as unknown as AuthService;

      const app = express();
      app.use(express.json());
      app.use("/api/v1/notifications", createNotificationRouter(service, authService));
      app.use(createErrorMiddleware(createMockLogger()));
      return { app, service, store };
    }

    async function seed(service: NotificationService) {
      await service.createNotification("alice", NotificationType.INVESTMENT_CREATED, "A1", "a1");
      await service.createNotification("alice", NotificationType.INVOICE_FUNDED, "A2", "a2");
      await service.createNotification("bob", NotificationType.INVOICE_FUNDED, "B1", "b1");
    }

    it("requires authentication", async () => {
      const { app } = buildApp();
      await request(app).get("/api/v1/notifications").expect(401);
      await request(app).get("/api/v1/notifications/unread-count").expect(401);
      await request(app).patch("/api/v1/notifications/read-all").expect(401);
    });

    it("GET / returns only the authenticated user's notifications", async () => {
      const { app, service } = buildApp();
      await seed(service);

      const response = await request(app)
        .get("/api/v1/notifications")
        .set("Authorization", "Bearer alice")
        .expect(200);

      expect(response.body.data.map((n: Notification) => n.title)).toEqual(["A1", "A2"]);
    });

    it("PATCH /:id/read marks one notification read", async () => {
      const { app, service, store } = buildApp();
      await seed(service);

      const response = await request(app)
        .patch(`/api/v1/notifications/${store[0].id}/read`)
        .set("Authorization", "Bearer alice")
        .expect(200);

      expect(response.body.data.read).toBe(true);
      expect(store.map((n) => n.read)).toEqual([true, false, false]);
    });

    it("PATCH /read-all marks every unread notification of the user and nobody else's", async () => {
      const { app, service, store } = buildApp();
      await seed(service);

      const response = await request(app)
        .patch("/api/v1/notifications/read-all")
        .set("Authorization", "Bearer alice")
        .expect(200);

      expect(response.body.data).toEqual({ updated: 2 });
      expect(store.map((n) => [n.userId, n.read])).toEqual([
        ["alice", true],
        ["alice", true],
        ["bob", false],
      ]);
    });

    it("GET /unread-count returns the user's unread count", async () => {
      const { app, service } = buildApp();
      await seed(service);

      const before = await request(app)
        .get("/api/v1/notifications/unread-count")
        .set("Authorization", "Bearer alice")
        .expect(200);
      expect(before.body.data).toEqual({ unread: 2 });

      await request(app)
        .patch("/api/v1/notifications/read-all")
        .set("Authorization", "Bearer alice")
        .expect(200);

      const after = await request(app)
        .get("/api/v1/notifications/unread-count")
        .set("Authorization", "Bearer alice")
        .expect(200);
      expect(after.body.data).toEqual({ unread: 0 });

      const bob = await request(app)
        .get("/api/v1/notifications/unread-count")
        .set("Authorization", "Bearer bob")
        .expect(200);
      expect(bob.body.data).toEqual({ unread: 1 });
    });
  });
});
