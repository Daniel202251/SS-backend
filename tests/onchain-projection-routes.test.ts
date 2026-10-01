import crypto from "node:crypto";
import request from "supertest";
import express, { type Express } from "express";

import { createKeysRouter } from "../src/routes/keys.routes";
import { createSwapRouter } from "../src/routes/swap.routes";
import { createAdminRouter } from "../src/routes/admin/admin.routes";
import { createCreatorKeyService } from "../src/services/creator-key.service";
import {
  createAtomicSwapService,
  type AtomicSwapInput,
  type SwapRepositoryContract,
} from "../src/services/atomic-swap.service";
import {
  createAclService,
  type AclRepositoryContract,
  type AclUpdateInput,
} from "../src/services/acl.service";
import { createCurveMigrationService } from "../src/services/curve-migration.service";
import { encodeCursor } from "../src/utils/cursor-pagination.utils";
import { AdminRole, KYCStatus, UserType } from "../src/types/enums";
import type { AuthenticatedRequest } from "../src/types/auth";
import type { AtomicSwap } from "../src/models/AtomicSwap.model";
import type { ContractAcl } from "../src/models/ContractAcl.model";
import type { ContractAclLog } from "../src/models/ContractAclLog.model";
import type { CreatorKey } from "../src/models/CreatorKey.model";
import type { CurveMigration } from "../src/models/CurveMigration.model";
import type { DecodedSorobanEvent } from "../src/types/soroban.types";
import type { AuthService } from "../src/services/auth.service";
import type { DataSource } from "typeorm";

const CREATOR_WALLET = "GCREATORWALLET0000000000000000000000000000000000000000AA";
const BUYER = "GBUYER000000000000000000000000000000000000000000000000000000AA";
const SELLER = "GSELLER00000000000000000000000000000000000000000000000000000AA";

function makeKey(overrides: Partial<CreatorKey> = {}): CreatorKey {
  return {
    id: "key-1",
    creatorId: CREATOR_WALLET,
    creatorWallet: CREATOR_WALLET,
    contractAddress: "CKEY",
    maxBuyPerTx: "500.0000000",
    maxBuyPerDay: "2000.0000000",
    currentSupply: "1000.0000000",
    curveType: "constant_product",
    configVersion: 1,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as CreatorKey;
}

function fakeCreatorKeyRepository(keys: CreatorKey[]) {
  return {
    async findById(id: string) {
      return keys.find((key) => key.id === id) ?? null;
    },
    async findByContractAddress(contractAddress: string) {
      return keys.find((key) => key.contractAddress === contractAddress) ?? null;
    },
    async applyConfigUpdate() {
      return null;
    },
  };
}

function fakeAclRepository() {
  const current: ContractAcl[] = [];
  const log: ContractAclLog[] = [];
  const repo: AclRepositoryContract = {
    async findActive() {
      return current.filter((entry) => entry.status === "active");
    },
    async findHistory({ limit, offset }) {
      return log.slice(offset ?? 0, (offset ?? 0) + limit);
    },
    async applyUpdate(update: AclUpdateInput) {
      current.push({
        id: crypto.randomUUID(),
        contractAddress: update.contractAddress,
        permittedFunctions: update.permittedFunctions,
        status: update.action === "remove" ? "removed" : "active",
        addedAt: new Date(),
        removedAt: null,
        lastLedger: update.ledgerSequence,
        lastTxHash: update.txHash,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as ContractAcl);
      log.push({
        id: crypto.randomUUID(),
        contractAddress: update.contractAddress,
        action: update.action,
        permittedFunctions: update.permittedFunctions,
        ledgerSequence: update.ledgerSequence,
        txHash: update.txHash,
        actor: update.actor,
        createdAt: new Date(),
      } as ContractAclLog);
    },
  };
  return { repo, current, log };
}

function makeSwap(overrides: Partial<AtomicSwap> = {}): AtomicSwap {
  return {
    id: "swap-1",
    swapId: "onchain-1",
    buyerAddress: BUYER,
    sellerAddress: SELLER,
    buyerInvoiceId: "inv-buyer",
    sellerInvoiceId: "inv-seller",
    buyerAmount: "100.0000000",
    sellerAmount: "98.0000000",
    feeAmount: "2.0000000",
    feeRecipient: "GFEE0000000000000000000000000000000000000000000000000000000000",
    txHash: "c".repeat(64),
    ledgerSequence: "500",
    executedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as AtomicSwap;
}

function fakeSwapRepository(rows: AtomicSwap[]): SwapRepositoryContract {
  return {
    async findByWallet(wallet, { limit, cursor }) {
      const mine = rows
        .filter((row) => row.buyerAddress === wallet || row.sellerAddress === wallet)
        .sort((a, b) => {
          const byDate = b.executedAt.getTime() - a.executedAt.getTime();
          return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
        })
        .filter((row) => {
          if (!cursor) return true;
          const time = row.executedAt.getTime();
          const cursorTime = cursor.createdAt.getTime();
          return time < cursorTime || (time === cursorTime && row.id < cursor.id);
        });

      return { items: mine.slice(0, limit), hasMore: mine.length > limit };
    },
    async findById(id) {
      return rows.find((row) => row.id === id || row.swapId === id) ?? null;
    },
    async recordSwap(input: AtomicSwapInput) {
      const existing = rows.find((row) => row.swapId === input.swapId);
      if (existing) return existing;
      const created = makeSwap({ id: `swap-${rows.length + 1}`, ...input });
      rows.push(created);
      return created;
    },
  };
}

/** Minimal auth stand-in: resolves the bearer token to a fixed user. */
function fakeAuthService(users: Record<string, AuthenticatedRequest["user"]>): AuthService {
  return {
    async getCurrentUser(token: string) {
      const user = users[token];
      if (!user) {
        const error = new Error("Invalid token") as Error & { statusCode?: number };
        error.statusCode = 401;
        throw error;
      }
      return user;
    },
  } as unknown as AuthService;
}

function user(
  wallet: string,
  // Admins carry an `admin` role, which is deliberately not a UserType.
  userType: UserType | AdminRole = UserType.INVESTOR
): AuthenticatedRequest["user"] {
  return {
    id: wallet,
    stellarAddress: wallet,
    email: null,
    userType: userType as UserType,
    kycStatus: KYCStatus.APPROVED,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function buildApp(overrides: {
  keys?: boolean;
  swaps?: boolean;
  admin?: boolean;
  users?: Record<string, AuthenticatedRequest["user"]>;
  swapRows?: AtomicSwap[];
  migrations?: CurveMigration[];
}): Express {
  const app = express();
  app.use(express.json());

  const users = overrides.users ?? {};
  const authService = fakeAuthService(users);
  const creatorKeyService = createCreatorKeyService({
    creatorKeyRepository: fakeCreatorKeyRepository([makeKey()]),
  });

  if (overrides.keys) {
    const curveMigrationService = createCurveMigrationService({
      curveMigrationRepository: {
        async findByKeyId() {
          return overrides.migrations ?? [];
        },
        async recordProposal() {
          return null;
        },
        async recordExecution() {
          return null;
        },
      },
      now: () => new Date("2026-01-01T12:00:00.000Z"),
      adminNotifier: { async notifyMigrationExecuted() {} },
    });

    app.use(
      "/api/v1/keys",
      createKeysRouter({ creatorKeyService, curveMigrationService, authService })
    );
  }

  if (overrides.swaps) {
    app.use(
      "/api/v1/swaps",
      createSwapRouter({
        swapService: createAtomicSwapService({
          swapRepository: fakeSwapRepository(overrides.swapRows ?? []),
        }),
        authService,
      })
    );
  }

  if (overrides.admin) {
    const { repo } = fakeAclRepository();
    app.use(
      "/api/v1/admin",
      createAdminRouter({
        dataSource: {} as DataSource,
        allowedCidrs: [],
        aclService: createAclService({ aclRepository: repo }),
        authService,
      })
    );
  }

  // Mirrors the production error middleware for the routes under test.
  app.use(
    (
      err: { statusCode?: number; message: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      res.status(err.statusCode ?? 500).json({ success: false, error: { message: err.message } });
    }
  );

  return app;
}

describe("Issue #542: buy limit endpoint requires no auth", () => {
  it("serves the buy limit publicly and includes it in the key detail", async () => {
    const app = buildApp({ keys: true });

    const limit = await request(app).get("/api/v1/keys/key-1/buy-limit");
    expect(limit.status).toBe(200);
    expect(limit.body.data.maxBuyPerTx).toBe("500.0000000");
    expect(limit.body.data.currentSupply).toBe("1000.0000000");

    const detail = await request(app).get("/api/v1/keys/key-1");
    expect(detail.status).toBe(200);
    expect(detail.body.data.maxBuyPerTx).toBe("500.0000000");
  });

  it("returns 404 for an unknown key", async () => {
    const app = buildApp({ keys: true });
    const response = await request(app).get("/api/v1/keys/does-not-exist/buy-limit");
    expect(response.status).toBe(404);
  });
});

describe("Issue #544: creator-only access to pending curve migrations", () => {
  const migrations: CurveMigration[] = [
    {
      id: "mig-1",
      keyId: "key-1",
      proposalId: "proposal-1",
      contractAddress: "CCURVE",
      status: "pending",
      proposedParams: { curveType: "linear" },
      appliedParams: null,
      timelockExpiry: new Date("2026-01-05T00:00:00.000Z"),
      proposedAt: new Date("2026-01-01T00:00:00.000Z"),
      executedAt: null,
      proposalTxHash: "p".repeat(64),
      executionTxHash: null,
      ledgerSequence: "1000",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as CurveMigration,
    {
      id: "mig-2",
      keyId: "key-1",
      proposalId: "proposal-2",
      contractAddress: "CCURVE",
      status: "executed",
      proposedParams: { curveType: "constant_product" },
      appliedParams: { curveType: "constant_product" },
      timelockExpiry: new Date("2025-12-01T00:00:00.000Z"),
      proposedAt: new Date("2025-11-01T00:00:00.000Z"),
      executedAt: new Date("2025-12-02T00:00:00.000Z"),
      proposalTxHash: "p".repeat(63),
      executionTxHash: "e".repeat(64),
      ledgerSequence: "900",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as CurveMigration,
  ];

  it("requires authentication", async () => {
    const app = buildApp({ keys: true, migrations });
    const response = await request(app).get("/api/v1/keys/key-1/curve-migrations");
    expect(response.status).toBe(401);
  });

  it("hides pending migrations from non-creators but still lists executed ones", async () => {
    const app = buildApp({
      keys: true,
      migrations,
      users: { "stranger-token": user(BUYER) },
    });

    const response = await request(app)
      .get("/api/v1/keys/key-1/curve-migrations")
      .set("Authorization", "Bearer stranger-token");

    expect(response.status).toBe(200);
    expect(response.body.data.pending).toHaveLength(0);
    expect(response.body.data.executed).toHaveLength(1);
    expect(response.body.data.executed[0].appliedParams).toEqual({ curveType: "constant_product" });
    expect(response.body.data.executed[0].executedAt).toBe("2025-12-02T00:00:00.000Z");
  });

  it("returns pending migrations to the creator, with timelock expiry", async () => {
    const app = buildApp({
      keys: true,
      migrations,
      users: { "creator-token": user(CREATOR_WALLET, UserType.SELLER) },
    });

    const response = await request(app)
      .get("/api/v1/keys/key-1/curve-migrations?status=pending")
      .set("Authorization", "Bearer creator-token");

    expect(response.status).toBe(200);
    expect(response.body.data.pending).toHaveLength(1);
    expect(response.body.data.pending[0].timelockExpiry).toBe("2026-01-05T00:00:00.000Z");
    expect(response.body.data.pending[0].status).toBe("pending");
  });

  it("rejects a pending request from a non-creator with 403", async () => {
    const app = buildApp({
      keys: true,
      migrations,
      users: { "stranger-token": user(BUYER) },
    });

    const response = await request(app)
      .get("/api/v1/keys/key-1/curve-migrations?status=pending")
      .set("Authorization", "Bearer stranger-token");

    expect(response.status).toBe(403);
  });

  it("rejects an unknown status filter", async () => {
    const app = buildApp({
      keys: true,
      migrations,
      users: { "creator-token": user(CREATOR_WALLET) },
    });

    const response = await request(app)
      .get("/api/v1/keys/key-1/curve-migrations?status=bogus")
      .set("Authorization", "Bearer creator-token");

    expect(response.status).toBe(400);
  });
});

describe("Issue #543: admin-only ACL endpoints", () => {
  it("rejects unauthenticated and non-admin callers", async () => {
    const app = buildApp({
      admin: true,
      users: { "investor-token": user(BUYER), "admin-token": user("GADMIN", AdminRole.ADMIN) },
    });

    expect((await request(app).get("/api/v1/admin/acl")).status).toBe(401);
    expect(
      (await request(app).get("/api/v1/admin/acl").set("Authorization", "Bearer investor-token"))
        .status
    ).toBe(403);
  });

  it("returns the whitelist and log to an admin", async () => {
    const app = buildApp({
      admin: true,
      users: { "admin-token": user("GADMIN", AdminRole.ADMIN) },
    });

    const acl = await request(app)
      .get("/api/v1/admin/acl")
      .set("Authorization", "Bearer admin-token");
    expect(acl.status).toBe(200);
    expect(acl.body.success).toBe(true);
    expect(acl.body.data.contracts).toEqual([]);

    const log = await request(app)
      .get("/api/v1/admin/acl/log?limit=10")
      .set("Authorization", "Bearer admin-token");
    expect(log.status).toBe(200);
    expect(log.body.meta.limit).toBe(10);
  });

  it("rejects a malformed log query", async () => {
    const app = buildApp({
      admin: true,
      users: { "admin-token": user("GADMIN", AdminRole.ADMIN) },
    });

    const response = await request(app)
      .get("/api/v1/admin/acl/log?limit=-3")
      .set("Authorization", "Bearer admin-token");

    expect(response.status).toBe(400);
  });
});

describe("Issue #545: atomic swap history", () => {
  const rows: AtomicSwap[] = [
    makeSwap({
      id: "swap-1",
      swapId: "onchain-1",
      executedAt: new Date("2026-01-03T00:00:00.000Z"),
    }),
    makeSwap({
      id: "swap-2",
      swapId: "onchain-2",
      executedAt: new Date("2026-01-02T00:00:00.000Z"),
      sellerAmount: "50.0000000",
      feeAmount: "1.0000000",
    }),
    makeSwap({
      id: "swap-3",
      swapId: "onchain-3",
      executedAt: new Date("2026-01-01T00:00:00.000Z"),
      buyerAddress: "GBUYEROTHER000000000000000000000000000000000000000000000000AA",
      sellerAddress: "GSELLER00000000000000000000000000000000000000000000000000000AA",
    }),
  ];

  it("requires authentication for history", async () => {
    const app = buildApp({ swaps: true, swapRows: rows });
    expect((await request(app).get("/api/v1/swaps/history")).status).toBe(401);
  });

  it("scopes history to the caller as either buyer or seller", async () => {
    const app = buildApp({
      swaps: true,
      swapRows: rows,
      users: { "buyer-token": user(BUYER), "seller-token": user(SELLER) },
    });

    const asBuyer = await request(app)
      .get("/api/v1/swaps/history")
      .set("Authorization", "Bearer buyer-token");
    const asSeller = await request(app)
      .get("/api/v1/swaps/history")
      .set("Authorization", "Bearer seller-token");

    expect(asBuyer.status).toBe(200);
    // Buyer side: the two swaps where BUYER is the buyer.
    expect(asBuyer.body.data.map((s: { id: string }) => s.id)).toEqual(["swap-1", "swap-2"]);
    // Seller side: everything SELLER sold, including swap-3.
    expect(asSeller.body.data.map((s: { id: string }) => s.id)).toEqual([
      "swap-1",
      "swap-2",
      "swap-3",
    ]);
  });

  it("returns both sides, amounts, fee and timestamp for each swap", async () => {
    const app = buildApp({
      swaps: true,
      swapRows: rows,
      users: { "buyer-token": user(BUYER) },
    });

    const response = await request(app)
      .get("/api/v1/swaps/history")
      .set("Authorization", "Bearer buyer-token");

    expect(response.body.data[0]).toMatchObject({
      id: "swap-1",
      buyer: { address: BUYER, amount: "100.0000000" },
      seller: { address: SELLER, amount: "98.0000000" },
      fee: { amount: "2.0000000" },
      timestamp: "2026-01-03T00:00:00.000Z",
    });
  });

  it("paginates with a cursor", async () => {
    const app = buildApp({
      swaps: true,
      swapRows: rows,
      users: { "buyer-token": user(BUYER) },
    });

    const first = await request(app)
      .get("/api/v1/swaps/history?limit=1")
      .set("Authorization", "Bearer buyer-token");

    expect(first.body.data).toHaveLength(1);
    expect(first.body.meta.hasMore).toBe(true);
    const cursor = first.body.meta.nextCursor;
    expect(typeof cursor).toBe("string");

    const second = await request(app)
      .get(`/api/v1/swaps/history?limit=1&cursor=${encodeURIComponent(cursor)}`)
      .set("Authorization", "Bearer buyer-token");

    expect(second.body.data.map((s: { id: string }) => s.id)).toEqual(["swap-2"]);
    expect(second.body.meta.hasMore).toBe(false);
    expect(second.body.meta.nextCursor).toBeNull();
  });

  it("rejects an invalid cursor", async () => {
    const app = buildApp({
      swaps: true,
      swapRows: rows,
      users: { "buyer-token": user(BUYER) },
    });

    const response = await request(app)
      .get("/api/v1/swaps/history?cursor=not-a-cursor")
      .set("Authorization", "Bearer buyer-token");

    expect(response.status).toBe(400);
  });

  it("serves a public single-swap lookup by id", async () => {
    const app = buildApp({ swaps: true, swapRows: rows });

    const response = await request(app).get("/api/v1/swaps/swap-2");
    expect(response.status).toBe(200);
    expect(response.body.data.swapId).toBe("onchain-2");
    expect(response.body.data.seller.amount).toBe("50.0000000");

    const missing = await request(app).get("/api/v1/swaps/nope");
    expect(missing.status).toBe(404);
  });
});

describe("swap projection from AtomicSwapExecuted events", () => {
  it("records both sides, amounts and fee, and is idempotent per swap id", async () => {
    const rows: AtomicSwap[] = [];
    const service = createAtomicSwapService({ swapRepository: fakeSwapRepository(rows) });

    const event: DecodedSorobanEvent = {
      id: "evt-1",
      contractId: "CSWAP",
      ledger: 900,
      ledgerClosedAt: "2026-02-01T00:00:00.000Z",
      txHash: "d".repeat(64),
      topic: "atomic_swap_executed",
      topics: ["atomic_swap_executed", BUYER, SELLER, "swap-77"],
      data: {
        buyer_invoice_id: "inv-a",
        seller_invoice_id: "inv-b",
        buyer_amount: 100,
        seller_amount: 98,
        fee: 2,
        fee_recipient: "GFEE",
      },
      inSuccessfulContractCall: true,
    };

    await service.handle(event);
    await service.handle(event);

    expect(rows).toHaveLength(1);
    const view = await service.getSwap("swap-1");
    expect(view).toMatchObject({
      swapId: "swap-77",
      buyer: { address: BUYER, invoiceId: "inv-a", amount: "100" },
      seller: { address: SELLER, invoiceId: "inv-b", amount: "98" },
      fee: { amount: "2" },
      timestamp: "2026-02-01T00:00:00.000Z",
    });
  });

  it("keeps a cursor round-trippable through the repository ordering", () => {
    const executedAt = new Date("2026-02-01T00:00:00.000Z");
    expect(encodeCursor(executedAt, "abc")).toBe(
      Buffer.from(`${executedAt.toISOString()}::abc`).toString("base64")
    );
  });
});
