import request from "supertest";
import express from "express";
import { createNotificationController } from "../src/controllers/notification.controller";
import { NotificationService } from "../src/services/notification.service";
import { NotificationType, UserType, KYCStatus } from "../src/types/enums";
import { HttpError } from "../src/utils/http-error";
import { createErrorMiddleware } from "../src/middleware/error.middleware";
import { logger } from "../src/observability/logger";
import type { AuthenticatedRequestUser } from "../src/types/auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(id = "user-1"): AuthenticatedRequestUser {
  return {
    id,
    stellarAddress: "GABC123",
    email: null,
    userType: UserType.INVESTOR,
    kycStatus: KYCStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeNotification(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "notif-1",
    userId: "user-1",
    type: NotificationType.INVOICE,
    title: "Invoice published",
    message: "Your invoice INV-001 has been published.",
    read: false,
    timestamp: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock auth middleware — injects req.user without a real JWT
// ---------------------------------------------------------------------------

function mockAuthMiddleware(userId: string) {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = makeUser(userId);
    next();
  };
}

function rejectAuthMiddleware() {
  return (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    next(new HttpError(401, "Authorization token is required."));
  };
}

// ---------------------------------------------------------------------------
// App factory for tests
// Wires the controller directly so we control auth in one place,
// avoiding the double-auth problem with createNotificationRouter.
// ---------------------------------------------------------------------------

function buildApp(notificationService: NotificationService, authUserId?: string) {
  const app = express();
  app.use(express.json());

  const { list, markRead } = createNotificationController(notificationService);

  const router = express.Router();

  if (authUserId) {
    router.use(mockAuthMiddleware(authUserId));
  } else {
    router.use(rejectAuthMiddleware());
  }

  router.get("/", list);
  router.patch("/:id/read", markRead);

  app.use("/api/v1/notifications", router);
  app.use(createErrorMiddleware(logger));

  return app;
}

// ---------------------------------------------------------------------------
// Mocked NotificationService
// ---------------------------------------------------------------------------

function buildMockService(overrides: Partial<NotificationService> = {}): NotificationService {
  const defaults = {
    createNotification: jest.fn(),
    listNotifications: jest.fn().mockResolvedValue({
      data: [],
      meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
    }),
    markNotificationRead: jest.fn(),
  } as unknown as NotificationService;

  return Object.assign(defaults, overrides);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/notifications", () => {
  it("returns paginated notifications for the authenticated user", async () => {
    const notif = makeNotification();
    const service = buildMockService({
      listNotifications: jest.fn().mockResolvedValue({
        data: [notif],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      }),
    } as unknown as Partial<NotificationService>);

    const app = buildApp(service, "user-1");
    const res = await request(app).get("/api/v1/notifications");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(1);
    expect(service.listNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" })
    );
  });

  it("passes read=false filter through", async () => {
    const service = buildMockService();
    const app = buildApp(service, "user-1");

    await request(app).get("/api/v1/notifications?read=false");

    expect(service.listNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ read: false })
    );
  });

  it("passes type filter through", async () => {
    const service = buildMockService();
    const app = buildApp(service, "user-1");

    await request(app).get(`/api/v1/notifications?type=${NotificationType.INVOICE}`);

    expect(service.listNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.INVOICE })
    );
  });

  it("returns 401 when no auth token is provided", async () => {
    const service = buildMockService();
    const app = buildApp(service, undefined);

    const res = await request(app).get("/api/v1/notifications");

    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/v1/notifications/:id/read", () => {
  it("marks a notification as read and returns it", async () => {
    const notif = makeNotification({ read: true });
    const service = buildMockService({
      markNotificationRead: jest.fn().mockResolvedValue(notif),
    } as unknown as Partial<NotificationService>);

    const app = buildApp(service, "user-1");
    const res = await request(app).patch("/api/v1/notifications/notif-1/read");

    expect(res.status).toBe(200);
    expect(res.body.data.read).toBe(true);
    expect(service.markNotificationRead).toHaveBeenCalledWith("notif-1", "user-1");
  });

  it("returns 404 when notification does not belong to user (authz)", async () => {
    const service = buildMockService({
      markNotificationRead: jest
        .fn()
        .mockRejectedValue(new HttpError(404, "Notification not found.")),
    } as unknown as Partial<NotificationService>);

    const app = buildApp(service, "user-2");
    const res = await request(app).patch("/api/v1/notifications/notif-1/read");

    expect(res.status).toBe(404);
  });

  it("is idempotent — marking an already-read notification returns 200", async () => {
    const notif = makeNotification({ read: true });
    const service = buildMockService({
      markNotificationRead: jest.fn().mockResolvedValue(notif),
    } as unknown as Partial<NotificationService>);

    const app = buildApp(service, "user-1");

    const res1 = await request(app).patch("/api/v1/notifications/notif-1/read");
    const res2 = await request(app).patch("/api/v1/notifications/notif-1/read");

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  it("returns 401 when no auth token is provided", async () => {
    const service = buildMockService();
    const app = buildApp(service, undefined);

    const res = await request(app).patch("/api/v1/notifications/notif-1/read");

    expect(res.status).toBe(401);
  });
});
