import { DataSource, Repository } from "typeorm";
import { Notification } from "../models/Notification.model";
import { NotificationType } from "../types/enums";
import { HttpError } from "../utils/http-error";
import type { NotificationInput } from "../lib/invoice-notifications";

export interface NotificationPage {
  data: Notification[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  nextCursor?: string | null;
  hasMore?: boolean;
}

export interface ListNotificationsOptions {
  userId: string;
  page?: number;
  limit?: number;
  read?: boolean;
  type?: NotificationType;
  sortOrder?: "asc" | "desc";
  cursor?: string | null;
}

export type { NotificationInput };

export interface NotificationRepositoryContract {
  create(
    userId: string,
    type: NotificationType,
    title: string,
    message: string
  ): Promise<Notification>;
  /** Inserts all entries in a single statement. */
  createMany(entries: NotificationInput[]): Promise<void>;
  findByIdAndUserId(id: string, userId: string): Promise<Notification | null>;
  markRead(id: string, userId: string): Promise<Notification>;
  /** Marks every unread notification of the user as read in one statement; returns how many changed. */
  markAllRead(userId: string): Promise<number>;
  countUnread(userId: string): Promise<number>;
  list(options: ListNotificationsOptions): Promise<NotificationPage>;
}

export class NotificationService {
  constructor(private readonly notificationRepository: NotificationRepositoryContract) {}

  /**
   * Creates a notification for a user.
   * Intended call sites:
   *   - Invoice publish  → createNotification(sellerId, NotificationType.INVOICE, ...)
   *   - Investment confirmed → createNotification(investorId, NotificationType.INVESTMENT, ...)
   *   - Settlement complete  → createNotification(userId, NotificationType.PAYMENT, ...)
   */
  async createNotification(
    userId: string,
    type: NotificationType,
    title: string,
    message: string
  ): Promise<Notification> {
    return this.notificationRepository.create(userId, type, title, message);
  }

  /**
   * Creates several notifications at once, e.g. one per investor when an
   * invoice they funded settles.
   */
  async createNotifications(entries: NotificationInput[]): Promise<void> {
    if (entries.length === 0) return;
    await this.notificationRepository.createMany(entries);
  }

  async listNotifications(options: ListNotificationsOptions): Promise<NotificationPage> {
    return this.notificationRepository.list(options);
  }

  async markNotificationRead(notificationId: string, userId: string): Promise<Notification> {
    const notification = await this.notificationRepository.findByIdAndUserId(
      notificationId,
      userId
    );

    if (!notification) {
      throw new HttpError(404, "Notification not found.");
    }

    if (notification.read) {
      return notification;
    }

    return this.notificationRepository.markRead(notificationId, userId);
  }

  async markAllNotificationsRead(userId: string): Promise<{ updated: number }> {
    return { updated: await this.notificationRepository.markAllRead(userId) };
  }

  async getUnreadCount(userId: string): Promise<{ unread: number }> {
    return { unread: await this.notificationRepository.countUnread(userId) };
  }
}

class TypeOrmNotificationRepository implements NotificationRepositoryContract {
  constructor(private readonly repository: Repository<Notification>) {}

  async create(
    userId: string,
    type: NotificationType,
    title: string,
    message: string
  ): Promise<Notification> {
    const entity = this.repository.create({ userId, type, title, message });
    return this.repository.save(entity);
  }

  async createMany(entries: NotificationInput[]): Promise<void> {
    await this.repository.insert(entries);
  }

  findByIdAndUserId(id: string, userId: string): Promise<Notification | null> {
    return this.repository.findOne({ where: { id, userId } });
  }

  async markAllRead(userId: string): Promise<number> {
    // A single UPDATE, so concurrent requests can't leave a partially-read
    // set behind and notifications created mid-request are either all
    // included or untouched.
    const result = await this.repository.update({ userId, read: false }, { read: true });
    return result.affected ?? 0;
  }

  countUnread(userId: string): Promise<number> {
    return this.repository.count({ where: { userId, read: false } });
  }

  async markRead(id: string, userId: string): Promise<Notification> {
    await this.repository.update({ id, userId }, { read: true });
    const updated = await this.repository.findOne({ where: { id, userId } });
    if (!updated) {
      throw new HttpError(404, "Notification not found.");
    }
    return updated;
  }

  async list(options: ListNotificationsOptions): Promise<NotificationPage> {
    const { userId, page = 1, limit = 20, read, type, sortOrder = "desc", cursor } = options;

    const qb = this.repository
      .createQueryBuilder("n")
      .where("n.userId = :userId", { userId })
      .orderBy("n.timestamp", sortOrder === "asc" ? "ASC" : "DESC")
      .addOrderBy("n.id", sortOrder === "asc" ? "ASC" : "DESC")
      .take(limit + 1);

    if (cursor) {
      const decoded = Buffer.from(cursor, "base64").toString("utf8").split("::");
      if (
        decoded.length !== 2 ||
        !decoded[0] ||
        !decoded[1] ||
        Number.isNaN(Date.parse(decoded[0]))
      ) {
        throw new HttpError(400, "Invalid notification cursor.");
      }
      const operator = sortOrder === "asc" ? ">" : "<";
      qb.andWhere(
        `(n.timestamp ${operator} :cursorTimestamp OR (n.timestamp = :cursorTimestamp AND n.id ${operator} :cursorId))`,
        {
          cursorTimestamp: new Date(decoded[0]),
          cursorId: decoded[1],
        }
      );
    } else {
      qb.skip((page - 1) * limit);
    }

    if (read !== undefined) {
      qb.andWhere("n.read = :read", { read });
    }

    if (type !== undefined) {
      qb.andWhere("n.type = :type", { type });
    }

    const [rows, total] = await qb.getManyAndCount();
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(`${last.timestamp.toISOString()}::${last.id}`).toString("base64")
        : null;

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      nextCursor,
      hasMore,
    };
  }
}

export function createNotificationService(dataSource: DataSource): NotificationService {
  return new NotificationService(
    new TypeOrmNotificationRepository(dataSource.getRepository(Notification))
  );
}
