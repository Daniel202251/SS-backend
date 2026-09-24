import crypto from "crypto";
import {
  NotificationService,
  NotificationRepositoryContract,
  NotificationPage,
} from "../../src/services/notification.service";
import { NotificationType } from "../../src/types/enums";

interface StoredNotification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  timestamp: Date;
}

/**
 * In-memory notification repository for integration testing.
 */
function createFakeNotificationRepository(): NotificationRepositoryContract & {
  store: StoredNotification[];
} {
  const store: StoredNotification[] = [];

  return {
    store,

    async create(userId, type, title, message) {
      const notif: StoredNotification = {
        id: crypto.randomUUID(),
        userId,
        type,
        title,
        message,
        read: false,
        timestamp: new Date(),
      };
      store.push(notif);
      return notif as import("../../src/models/Notification.model").Notification;
    },

    async createMany(entries) {
      for (const entry of entries) {
        store.push({ id: crypto.randomUUID(), read: false, timestamp: new Date(), ...entry });
      }
    },

    async markAllRead(userId) {
      const unread = store.filter((n) => n.userId === userId && !n.read);
      unread.forEach((n) => (n.read = true));
      return unread.length;
    },

    async countUnread(userId) {
      return store.filter((n) => n.userId === userId && !n.read).length;
    },

    async findByIdAndUserId(id, userId) {
      return (store.find((n) => n.id === id && n.userId === userId) ?? null) as
        | import("../../src/models/Notification.model").Notification
        | null;
    },

    async markRead(id, userId) {
      const notif = store.find((n) => n.id === id && n.userId === userId);
      if (!notif) throw new Error("Not found");
      notif.read = true;
      return notif as import("../../src/models/Notification.model").Notification;
    },

    async list(options) {
      let filtered = store.filter((n) => n.userId === options.userId);
      if (options.read !== undefined) {
        filtered = filtered.filter((n) => n.read === options.read);
      }
      const page = options.page ?? 1;
      const limit = options.limit ?? 20;
      return {
        data: filtered.slice(
          (page - 1) * limit,
          page * limit
        ) as import("../../src/models/Notification.model").Notification[],
        meta: {
          total: filtered.length,
          page,
          limit,
          totalPages: Math.ceil(filtered.length / limit),
        },
      };
    },
  };
}

describe("Notification mark-as-read integration", () => {
  let repo: ReturnType<typeof createFakeNotificationRepository>;
  let service: NotificationService;

  beforeEach(() => {
    repo = createFakeNotificationRepository();
    service = new NotificationService(repo);
  });

  it("marks a notification as read and persists the status", async () => {
    const notif = await service.createNotification(
      "wallet-1",
      NotificationType.INVOICE,
      "Invoice published",
      "Your invoice has been published."
    );

    expect(notif.read).toBe(false);

    const marked = await service.markNotificationRead(notif.id, "wallet-1");
    expect(marked.read).toBe(true);

    // Verify persistence via the store
    const stored = repo.store.find((n) => n.id === notif.id);
    expect(stored?.read).toBe(true);
  });

  it("unread count decrements after marking as read", async () => {
    await service.createNotification("wallet-1", NotificationType.INVOICE, "A", "a");
    await service.createNotification("wallet-1", NotificationType.INVESTMENT, "B", "b");

    const before = await service.listNotifications({ userId: "wallet-1", read: false });
    expect(before.meta.total).toBe(2);

    await service.markNotificationRead(repo.store[0].id, "wallet-1");

    const after = await service.listNotifications({ userId: "wallet-1", read: false });
    expect(after.meta.total).toBe(1);
  });

  it("marking an already-read notification is idempotent", async () => {
    const notif = await service.createNotification(
      "wallet-1",
      NotificationType.PAYMENT,
      "Settlement",
      "Settlement complete."
    );

    await service.markNotificationRead(notif.id, "wallet-1");
    const second = await service.markNotificationRead(notif.id, "wallet-1");

    expect(second.read).toBe(true);
  });

  it("cannot mark a notification belonging to another wallet", async () => {
    const notif = await service.createNotification(
      "wallet-1",
      NotificationType.INVOICE,
      "Invoice",
      "desc"
    );

    await expect(service.markNotificationRead(notif.id, "wallet-2")).rejects.toThrow(
      "Notification not found"
    );
  });
});
