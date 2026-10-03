import type { DataSource, EntityManager } from "typeorm";
import { User } from "../models/User.model";
import { UserAuditLog, type UserAuditAction } from "../models/UserAuditLog.model";
import { UserType } from "../types/enums";
import { AppError } from "../utils/http-error";
import { decodeCursor, encodeCursor } from "../utils/cursor-pagination.utils";
import { logger as defaultLogger, type AppLogger } from "../observability/logger";

export const ADMIN_USER_LIST_DEFAULT_LIMIT = 20;
export const ADMIN_USER_LIST_MAX_LIMIT = 100;

export type AdminUserStatusFilter = "active" | "suspended";

export interface ListUsersInput {
  role?: UserType;
  status?: AdminUserStatusFilter;
  cursor?: string;
  limit?: number;
}

export interface AdminUserView {
  id: string;
  stellarAddress: string;
  email: string | null;
  role: UserType;
  kycStatus: User["kycStatus"];
  isKycVerified: boolean;
  status: AdminUserStatusFilter;
  suspendedAt: Date | null;
  suspensionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListUsersResult {
  items: AdminUserView[];
  limit: number;
  nextCursor: string | null;
}

export interface AdminActor {
  id: string;
  stellarAddress: string;
}

export function toAdminUserView(user: User): AdminUserView {
  return {
    id: user.id,
    stellarAddress: user.stellarAddress,
    email: user.email,
    role: user.userType,
    kycStatus: user.kycStatus,
    isKycVerified: user.isKycVerified,
    status: user.isSuspended ? "suspended" : "active",
    suspendedAt: user.suspendedAt,
    suspensionReason: user.suspensionReason,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export class AdminUserService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly log: AppLogger = defaultLogger
  ) {}

  async getUser(id: string): Promise<AdminUserView> {
    const user = await this.dataSource.getRepository(User).findOneBy({ id });
    if (!user) {
      throw new AppError(404, "User not found.", "USER_NOT_FOUND");
    }
    return toAdminUserView(user);
  }

  /** Keyset pagination on (created_at DESC, id DESC). */
  async listUsers({ role, status, cursor, limit }: ListUsersInput): Promise<ListUsersResult> {
    const pageSize = Math.min(
      Math.max(limit ?? ADMIN_USER_LIST_DEFAULT_LIMIT, 1),
      ADMIN_USER_LIST_MAX_LIMIT
    );

    const query = this.dataSource
      .getRepository(User)
      .createQueryBuilder("user")
      .orderBy("user.createdAt", "DESC")
      .addOrderBy("user.id", "DESC")
      .take(pageSize + 1);

    if (role) {
      query.andWhere("user.userType = :role", { role });
    }
    if (status) {
      query.andWhere("user.isSuspended = :suspended", { suspended: status === "suspended" });
    }
    if (cursor) {
      let decoded: { createdAt: Date; id: string };
      try {
        decoded = decodeCursor(cursor);
      } catch {
        throw new AppError(400, "Invalid pagination cursor.", "INVALID_CURSOR");
      }
      query.andWhere(
        "(user.createdAt < :createdAt OR (user.createdAt = :createdAt AND user.id < :id))",
        decoded
      );
    }

    const rows = await query.getMany();
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];

    return {
      items: page.map(toAdminUserView),
      limit: pageSize,
      nextCursor: rows.length > pageSize && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async updateRole(
    actor: AdminActor,
    userId: string,
    role: UserType,
    reason?: string | null
  ): Promise<AdminUserView> {
    if (!Object.values(UserType).includes(role)) {
      throw new AppError(400, "Invalid role.", "INVALID_ROLE", {
        allowedRoles: Object.values(UserType),
      });
    }
    if (actor.id === userId && role !== UserType.ADMIN) {
      throw new AppError(409, "Admins cannot remove their own admin role.", "CANNOT_DEMOTE_SELF");
    }

    return this.mutate(actor, userId, "role_updated", reason, (user) => {
      const previous = user.userType;
      if (previous === role) return null;
      user.userType = role;
      return [previous, role];
    });
  }

  async suspend(actor: AdminActor, userId: string, reason?: string | null): Promise<AdminUserView> {
    if (actor.id === userId) {
      throw new AppError(409, "Admins cannot suspend themselves.", "CANNOT_SUSPEND_SELF");
    }

    return this.mutate(actor, userId, "suspended", reason, (user) => {
      if (user.isSuspended) {
        throw new AppError(409, "User is already suspended.", "USER_ALREADY_SUSPENDED");
      }
      user.isSuspended = true;
      user.suspendedAt = new Date();
      user.suspensionReason = reason?.trim() || null;
      return ["active", "suspended"];
    });
  }

  async unsuspend(
    actor: AdminActor,
    userId: string,
    reason?: string | null
  ): Promise<AdminUserView> {
    return this.mutate(actor, userId, "unsuspended", reason, (user) => {
      if (!user.isSuspended) {
        throw new AppError(409, "User is not suspended.", "USER_NOT_SUSPENDED");
      }
      user.isSuspended = false;
      user.suspendedAt = null;
      user.suspensionReason = null;
      return ["suspended", "active"];
    });
  }

  /**
   * Applies `change` to the user and writes the audit row in one transaction.
   * `change` returns [previous, next], or null when nothing changed (no audit row).
   */
  private async mutate(
    actor: AdminActor,
    userId: string,
    action: UserAuditAction,
    reason: string | null | undefined,
    change: (user: User) => [string, string] | null
  ): Promise<AdminUserView> {
    const { user, values } = await this.dataSource.transaction(async (manager: EntityManager) => {
      const user = await manager.findOneBy(User, { id: userId });
      if (!user) {
        throw new AppError(404, "User not found.", "USER_NOT_FOUND");
      }

      const values = change(user);
      if (!values) {
        return { user, values };
      }

      await manager.save(User, user);
      await manager.save(
        UserAuditLog,
        manager.create(UserAuditLog, {
          targetUserId: user.id,
          actorUserId: actor.id,
          action,
          previousValue: values[0],
          newValue: values[1],
          reason: reason?.trim() || null,
        })
      );
      return { user, values };
    });

    if (values) {
      this.log.info("Admin user account change.", {
        event: `user_${action}`,
        target_user_id: user.id,
        target_wallet: user.stellarAddress,
        actor_user_id: actor.id,
        actor_wallet: actor.stellarAddress,
        previous_value: values[0],
        new_value: values[1],
        reason: reason?.trim() || null,
      });
    }

    return toAdminUserView(user);
  }
}

export function createAdminUserService(dataSource: DataSource, log?: AppLogger): AdminUserService {
  return new AdminUserService(dataSource, log);
}
