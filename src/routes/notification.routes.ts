import { Router } from "express";
import { createNotificationController } from "../controllers/notification.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { NotificationService } from "../services/notification.service";

export function createNotificationRouter(
  notificationService: NotificationService,
  authService: AuthService
): Router {
  const router = Router();
  const controller = createNotificationController(notificationService);
  const authMiddleware = createAuthMiddleware(authService);

  router.use((req, _res, next) => {
    req.routeBasePath = req.baseUrl;
    next();
  });

  // All notification routes require authentication
  router.use(authMiddleware);

  // GET /api/v1/notifications
  // Query params: page, limit, read (true|false), type (NotificationType), sort (asc|desc)
  router.get("/", controller.list);

  // GET /api/v1/notifications/unread-count
  router.get("/unread-count", controller.unreadCount);

  // PATCH /api/v1/notifications/read-all
  router.patch("/read-all", controller.markAllRead);

  // PATCH /api/v1/notifications/:id/read
  router.patch("/:id/read", controller.markRead);

  return router;
}
