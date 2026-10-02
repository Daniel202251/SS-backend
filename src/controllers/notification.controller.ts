import type { Request, Response } from "express";
import type { NotificationService } from "../services/notification.service";
import type { Notification } from "../models/Notification.model";
import { NotificationType } from "../types/enums";

export function createNotificationController(notificationService: NotificationService) {
  return {
    list: async (req: Request, res: Response): Promise<void> => {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const userId = user.id;
      const walletAddress = user.stellarAddress || user.id;

      const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10) || 1);
      const limit = Math.min(
        100,
        Math.max(1, parseInt((req.query.limit as string) ?? "20", 10) || 20)
      );

      const readParam = req.query.read as string | undefined;
      let read: boolean | undefined;
      if (readParam === "true") read = true;
      else if (readParam === "false") read = false;

      const typeParam = req.query.type as string | undefined;
      const type =
        typeParam && Object.values(NotificationType).includes(typeParam as NotificationType)
          ? (typeParam as NotificationType)
          : (typeParam as unknown as NotificationType);

      const sortOrder = (req.query.sort as string) === "asc" ? ("asc" as const) : ("desc" as const);
      const cursor = req.query.cursor as string | undefined;

      const result = await notificationService.listNotifications({
        userId,
        walletAddress,
        page,
        limit,
        read,
        type,
        sortOrder,
        cursor,
      });

      // Ensure every item has createdAt and read boolean
      const data = result.data.map((item: Notification) => {
        if (!item.createdAt && item.timestamp) {
          item.createdAt = item.timestamp;
        }
        if (!item.timestamp && item.createdAt) {
          item.timestamp = item.createdAt;
        }
        return item;
      });

      res.status(200).json({
        ...result,
        data,
        notifications: data,
      });
    },

    readAll: async (req: Request, res: Response): Promise<void> => {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const userId = user.id;
      const walletAddress = user.stellarAddress || user.id;

      const svc = notificationService as unknown as {
        markAllNotificationsRead?: (userId: string, walletAddress?: string) => Promise<unknown>;
        markAllRead?: (userId: string, walletAddress?: string) => Promise<unknown>;
      };
      if (typeof svc.markAllNotificationsRead === "function") {
        await svc.markAllNotificationsRead(userId, walletAddress);
      } else if (typeof svc.markAllRead === "function") {
        await svc.markAllRead(userId, walletAddress);
      }

      res.status(204).send();
    },

    markRead: async (req: Request, res: Response): Promise<void> => {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const userId = user.id;
      const id = req.params.id as string;

      const notification = await notificationService.markNotificationRead(id, userId);

      res.status(200).json({ data: notification });
    },

    markAllRead: async (req: Request, res: Response): Promise<void> => {
      const result = await notificationService.markAllNotificationsRead(req.user!.id);

      res.status(200).json({ data: result });
    },

    unreadCount: async (req: Request, res: Response): Promise<void> => {
      const result = await notificationService.getUnreadCount(req.user!.id);

      res.status(200).json({ data: result });
    },
  };
}
