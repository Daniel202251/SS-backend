import { Router, Request, Response, NextFunction } from "express";
import { createNotificationController } from "../controllers/notification.controller";
import { createAuthMiddleware, authenticateJWT } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { NotificationService } from "../services/notification.service";

export function createNotificationRouter(
  notificationService: NotificationService,
  authService?: AuthService
): Router {
  const router = Router();
  const controller = createNotificationController(notificationService);
  const authMiddleware = authService ? createAuthMiddleware(authService) : authenticateJWT;

  router.use((req, _res, next) => {
    req.routeBasePath = req.baseUrl;
    next();
  });

  // All notification routes require authentication
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.user) {
      return next();
    }
    return (authMiddleware as unknown as (req: Request, res: Response, next: NextFunction) => void)(req, res, next);
  });

  // GET /api/v1/notifications and GET /notifications
  router.get("/", controller.list);

  // GET /api/v1/notifications/unread-count
  router.get("/unread-count", controller.unreadCount);

  // POST /notifications/read-all and POST /api/v1/notifications/read-all (Issue #458 returns 204)
  router.post("/read-all", controller.readAll);

  // PATCH /api/v1/notifications/read-all
  router.patch("/read-all", controller.markAllRead ?? controller.readAll);

  // PATCH /api/v1/notifications/:id/read
  router.patch("/:id/read", controller.markRead);

  return router;
}
