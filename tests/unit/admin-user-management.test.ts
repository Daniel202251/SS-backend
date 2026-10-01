import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

import { createSuspendedWalletGuard } from "../../src/middleware/suspended-wallet.middleware";
import { createAdminUsersRouter } from "../../src/routes/admin/users.routes";
import { createAuthMiddleware } from "../../src/middleware/auth.middleware";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { AdminUserService } from "../../src/services/admin-user.service";
import { User } from "../../src/models/User.model";
import { UserAuditLog } from "../../src/models/UserAuditLog.model";
import { KYCStatus, UserType } from "../../src/types/enums";
import type { AuthService } from "../../src/services/auth.service";
import type { AppLogger } from "../../src/observability/logger";
import type { DataSource } from "typeorm";

const silentLogger: AppLogger = {
  debug: () => undefined,
  info: jest.fn(),
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const ADMIN_WALLET = "GADMIN".padEnd(56, "A");
const USER_WALLET = "GUSER".padEnd(56, "B");

function makeUser(overrides: Partial<User>): User {
  return Object.assign(new User(), {
    email: null,
    userType: UserType.INVESTOR,
    kycStatus: KYCStatus.APPROVED,
    isKycVerified: true,
    isSuspended: false,
    suspendedAt: null,
    suspensionReason: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });
}

/** In-memory stand-in for the parts of DataSource the service and guard use. */
function createFakeStore() {
  const users = new Map<string, User>([
    ["admin-1", makeUser({ id: "admin-1", stellarAddress: ADMIN_WALLET, userType: UserType.ADMIN })],
    ["user-1", makeUser({ id: "user-1", stellarAddress: USER_WALLET })],
  ]);
  const audit: UserAuditLog[] = [];

  const manager = {
    findOneBy: async (_entity: unknown, where: { id: string }) => users.get(where.id) ?? null,
    save: async (entity: unknown, value: User | UserAuditLog) => {
      if (entity === UserAuditLog) audit.push(value as UserAuditLog);
      else users.set((value as User).id, value as User);
      return value;
    },
    create: (_entity: unknown, value: Partial<UserAuditLog>) => value,
  };

  const dataSource = {
    transaction: async (work: (m: typeof manager) => Promise<unknown>) => work(manager),
    getRepository: () => ({ findOneBy: async ({ id }: { id: string }) => users.get(id) ?? null }),
  } as unknown as DataSource;

  const byWallet = (wallet: string) => [...users.values()].find((u) => u.stellarAddress === wallet);

  // Mirrors AuthService.getCurrentUser: the user is re-read on every request.
  const authService = {
    getCurrentUser: async (token: string) => {
      const { sub } = jwt.decode(token) as { sub: string };
      const user = byWallet(sub);
      if (!user) throw new Error("unknown user");
      return { ...user };
    },
  } as unknown as AuthService;

  return { users, audit, dataSource, authService, byWallet };
}

function buildApp(store: ReturnType<typeof createFakeStore>) {
  const service = new AdminUserService(store.dataSource, silentLogger);
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1",
    createSuspendedWalletGuard(
      async (wallet) => store.byWallet(wallet)?.isSuspended === true,
      silentLogger
    )
  );
  app.use("/api/v1/admin/users", createAdminUsersRouter(service, store.authService));
  app.get("/api/v1/me", createAuthMiddleware(store.authService), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(createErrorMiddleware(silentLogger));
  return { app, service };
}

const tokenFor = (wallet: string) => `Bearer ${jwt.sign({ sub: wallet }, "test-secret")}`;

describe("admin user management", () => {
  it("rejects non-admin callers with 403", async () => {
    const store = createFakeStore();
    const { app } = buildApp(store);

    const res = await request(app).get("/api/v1/admin/users").set("Authorization", tokenFor(USER_WALLET));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ADMIN_REQUIRED");
  });

  it("applies a role change to the user's next request and writes an audit row", async () => {
    const store = createFakeStore();
    const { app } = buildApp(store);

    const update = await request(app)
      .patch("/api/v1/admin/users/user-1/role")
      .set("Authorization", tokenFor(ADMIN_WALLET))
      .send({ role: "admin", reason: "ops lead" });

    expect(update.status).toBe(200);
    expect(update.body.data.role).toBe("admin");
    expect(store.audit).toEqual([
      expect.objectContaining({
        targetUserId: "user-1",
        actorUserId: "admin-1",
        action: "role_updated",
        previousValue: "investor",
        newValue: "admin",
        reason: "ops lead",
      }),
    ]);

    // Same token as before the change, now allowed through requireAdmin.
    const list = await request(app).get("/api/v1/admin/users").set("Authorization", tokenFor(USER_WALLET));
    expect(list.status).not.toBe(403);
  });

  it("rejects an unknown role with 400", async () => {
    const store = createFakeStore();
    const { app } = buildApp(store);

    const res = await request(app)
      .patch("/api/v1/admin/users/user-1/role")
      .set("Authorization", tokenFor(ADMIN_WALLET))
      .send({ role: "superuser" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_ROLE");
  });

  it("blocks a suspended wallet everywhere and restores it on unsuspend with the same token", async () => {
    const store = createFakeStore();
    const { app } = buildApp(store);
    const userToken = tokenFor(USER_WALLET);

    expect((await request(app).get("/api/v1/me").set("Authorization", userToken)).status).toBe(200);

    const suspend = await request(app)
      .patch("/api/v1/admin/users/user-1/suspend")
      .set("Authorization", tokenFor(ADMIN_WALLET))
      .send({ reason: "fraud review" });
    expect(suspend.status).toBe(200);
    expect(suspend.body.data.status).toBe("suspended");

    const blocked = await request(app).get("/api/v1/me").set("Authorization", userToken);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("ACCOUNT_SUSPENDED");

    const unsuspend = await request(app)
      .patch("/api/v1/admin/users/user-1/unsuspend")
      .set("Authorization", tokenFor(ADMIN_WALLET));
    expect(unsuspend.status).toBe(200);

    expect((await request(app).get("/api/v1/me").set("Authorization", userToken)).status).toBe(200);
    expect(store.audit.map((a) => a.action)).toEqual(["suspended", "unsuspended"]);
  });

  it("does not let an admin suspend or demote themselves", async () => {
    const store = createFakeStore();
    const { app } = buildApp(store);
    const adminToken = tokenFor(ADMIN_WALLET);

    const suspend = await request(app).patch("/api/v1/admin/users/admin-1/suspend").set("Authorization", adminToken);
    const demote = await request(app)
      .patch("/api/v1/admin/users/admin-1/role")
      .set("Authorization", adminToken)
      .send({ role: "investor" });

    expect(suspend.body.error.code).toBe("CANNOT_SUSPEND_SELF");
    expect(demote.body.error.code).toBe("CANNOT_DEMOTE_SELF");
    expect(store.audit).toHaveLength(0);
  });

  it("returns 409 when suspending an already suspended user", async () => {
    const store = createFakeStore();
    store.users.get("user-1")!.isSuspended = true;
    const { service } = buildApp(store);

    await expect(service.suspend({ id: "admin-1", stellarAddress: ADMIN_WALLET }, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      code: "USER_ALREADY_SUSPENDED",
    });
  });
});

describe("suspended wallet guard", () => {
  const run = async (lookup: (w: string) => Promise<boolean>, authorization?: string) => {
    const next = jest.fn();
    const req = { headers: { authorization }, method: "GET", path: "/x" };
    await createSuspendedWalletGuard(lookup, silentLogger)(req as never, {} as never, next);
    return next;
  };

  it("passes unauthenticated requests through without a lookup", async () => {
    const lookup = jest.fn();
    const next = await run(lookup);
    expect(lookup).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("fails closed with 503 when the lookup errors", async () => {
    const next = await run(() => Promise.reject(new Error("db down")), tokenFor(USER_WALLET));
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 503 });
  });
});

describe("admin user list", () => {
  function listStore(rows: User[]) {
    const calls: Array<[string, unknown]> = [];
    const builder: Record<string, unknown> = {};
    for (const method of ["orderBy", "addOrderBy", "take"]) builder[method] = () => builder;
    builder.andWhere = (clause: string, params: unknown) => {
      calls.push([clause, params]);
      return builder;
    };
    builder.getMany = async () => rows;
    const dataSource = {
      getRepository: () => ({ createQueryBuilder: () => builder }),
    } as unknown as DataSource;
    return { service: new AdminUserService(dataSource, silentLogger), calls };
  }

  const rows = [1, 2, 3].map((n) =>
    makeUser({ id: `u-${n}`, stellarAddress: `G${n}`, createdAt: new Date(`2026-01-0${n}T00:00:00Z`) })
  );

  it("filters by role and returns a cursor when more rows exist", async () => {
    const { service, calls } = listStore(rows);

    const page = await service.listUsers({ role: UserType.SELLER, limit: 2 });

    expect(calls[0]).toEqual(["user.userType = :role", { role: UserType.SELLER }]);
    expect(page.items.map((u) => u.id)).toEqual(["u-1", "u-2"]);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it("continues from a cursor and rejects a malformed one", async () => {
    const { service, calls } = listStore(rows.slice(0, 1));
    const first = await listStore(rows).service.listUsers({ limit: 2 });

    const page = await service.listUsers({ cursor: first.nextCursor!, limit: 2 });

    expect(calls[0][1]).toMatchObject({ id: "u-2" });
    expect(page.nextCursor).toBeNull();
    await expect(service.listUsers({ cursor: "!!" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});
