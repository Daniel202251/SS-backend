import express from "express";
import request from "supertest";

import { createInvoiceSearchHandler } from "../../src/routes/invoice-search.routes";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  type InvoiceSearchService,
} from "../../src/services/invoice-search.service";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import type { AppLogger } from "../../src/observability/logger";
import { InvoiceStatus } from "../../src/types/enums";

const silentLogger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

function buildApp() {
  const search = jest.fn().mockResolvedValue({ items: [], limit: 20, nextCursor: "next" });
  const app = express();
  app.get(
    "/invoices/search",
    createInvoiceSearchHandler({ search } as unknown as InvoiceSearchService)
  );
  app.use(createErrorMiddleware(silentLogger));
  return { app, search };
}

describe("GET /invoices/search", () => {
  it("passes the query and every filter through together", async () => {
    const { app, search } = buildApp();

    const res = await request(app).get("/invoices/search").query({
      q: "acme logistics",
      status: "published,funded",
      min_amount: "100",
      max_amount: "5000.50",
      due_after: "2026-10-01",
      due_before: "2026-12-31",
      limit: "10",
      cursor: "abc",
    });

    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledWith({
      q: "acme logistics",
      status: [InvoiceStatus.PUBLISHED, InvoiceStatus.FUNDED],
      minAmount: "100",
      maxAmount: "5000.50",
      dueAfter: new Date("2026-10-01"),
      dueBefore: new Date("2026-12-31"),
      cursor: "abc",
      limit: 10,
    });
    expect(res.body.meta).toEqual({
      limit: 20,
      hasNextPage: true,
      nextCursor: "next",
      ranked: true,
    });
  });

  it("reports unranked results when only filters are given", async () => {
    const { app } = buildApp();

    const res = await request(app).get("/invoices/search").query({ min_amount: "100" });

    expect(res.status).toBe(200);
    expect(res.body.meta.ranked).toBe(false);
  });

  it.each([
    [{ status: "draft" }, "status must be one of"],
    [{ min_amount: "abc" }, "min_amount"],
    [{ min_amount: "500", max_amount: "100" }, "min_amount must not exceed max_amount"],
    [{ due_after: "2026-12-01", due_before: "2026-11-01" }, "due_after must not be later"],
    [{ limit: "1000" }, "limit"],
  ])("rejects invalid params %j", async (query, message) => {
    const { app, search } = buildApp();

    const res = await request(app).get("/invoices/search").query(query);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(message);
    expect(search).not.toHaveBeenCalled();
  });
});

describe("search cursor", () => {
  it("round-trips ranked and unranked positions", () => {
    const ranked = { r: 0.30000001192092896, c: "2026-09-25T10:00:00.000Z", i: "id-1" };
    const unranked = { c: "2026-09-25T10:00:00.000Z", i: "id-2" };

    expect(decodeSearchCursor(encodeSearchCursor(ranked), true)).toEqual(ranked);
    expect(decodeSearchCursor(encodeSearchCursor(unranked), false)).toEqual(unranked);
  });

  it("rejects a cursor replayed against the other ordering or tampered with", () => {
    const ranked = encodeSearchCursor({ r: 0.5, c: "2026-09-25T10:00:00.000Z", i: "id-1" });

    expect(() => decodeSearchCursor(ranked, false)).toThrow("Invalid search cursor.");
    expect(() => decodeSearchCursor("not-a-cursor", true)).toThrow("Invalid search cursor.");
  });
});
