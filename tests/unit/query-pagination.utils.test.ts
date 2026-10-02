import { SelectQueryBuilder } from "typeorm";
import {
  paginateQuery,
  encodeQueryCursor,
  decodeQueryCursor,
} from "../../src/utils/query-pagination.utils";

interface FakeRow {
  id: string;
  createdAt: Date;
  score: number;
}

function makeQueryBuilder(rows: FakeRow[]): jest.Mocked<SelectQueryBuilder<FakeRow>> {
  const qb: Partial<jest.Mocked<SelectQueryBuilder<FakeRow>>> = {
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    take: jest.fn(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  qb.andWhere!.mockReturnValue(qb as any);
  qb.orderBy!.mockReturnValue(qb as any);
  qb.addOrderBy!.mockReturnValue(qb as any);
  qb.take!.mockReturnValue(qb as any);
  return qb as any;
}

function makeRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "row-1",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    score: 10,
    ...overrides,
  };
}

describe("paginateQuery", () => {
  it("returns the first page with no cursor and encodes an opaque base64 nextCursor", async () => {
    const rows = [
      makeRow({ id: "1", createdAt: new Date("2024-01-03T00:00:00.000Z") }),
      makeRow({ id: "2", createdAt: new Date("2024-01-02T00:00:00.000Z") }),
      makeRow({ id: "3", createdAt: new Date("2024-01-01T00:00:00.000Z") }),
    ];
    const qb = makeQueryBuilder(rows);

    const result = await paginateQuery({
      queryBuilder: qb,
      cursorField: "row.createdAt",
      limit: 2,
    });

    expect(qb.orderBy).toHaveBeenCalledWith("row.createdAt", "DESC");
    expect(qb.take).toHaveBeenCalledWith(3);
    expect(qb.andWhere).not.toHaveBeenCalled();

    expect(result.items).toHaveLength(2);
    expect(result.items.map((r) => r.id)).toEqual(["1", "2"]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();

    // Cursor must be opaque base64 that decodes back to field/value JSON.
    expect(() => Buffer.from(result.nextCursor as string, "base64")).not.toThrow();
    const decoded = decodeQueryCursor(result.nextCursor as string);
    expect(decoded.field).toBe("row.createdAt");
    expect(decoded.value).toBe(new Date("2024-01-02T00:00:00.000Z").toISOString());
  });

  it("uses a returned cursor to fetch the subsequent page, filtering strictly past it", async () => {
    const cursor = encodeQueryCursor("row.createdAt", new Date("2024-01-02T00:00:00.000Z"));
    const qb = makeQueryBuilder([
      makeRow({ id: "3", createdAt: new Date("2024-01-01T00:00:00.000Z") }),
    ]);

    const result = await paginateQuery({
      queryBuilder: qb,
      cursorField: "row.createdAt",
      limit: 2,
      cursor,
    });

    expect(qb.andWhere).toHaveBeenCalledWith("row.createdAt < :cursor_row_createdAt", {
      cursor_row_createdAt: new Date("2024-01-02T00:00:00.000Z").toISOString(),
    });
    expect(result.items.map((r) => r.id)).toEqual(["3"]);
  });

  it("returns hasMore: false and nextCursor: null on the last page", async () => {
    const qb = makeQueryBuilder([makeRow({ id: "3" })]);

    const result = await paginateQuery({
      queryBuilder: qb,
      cursorField: "row.createdAt",
      limit: 2,
    });

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.items).toHaveLength(1);
  });

  it("returns hasMore: false and nextCursor: null for an empty result set", async () => {
    const qb = makeQueryBuilder([]);

    const result = await paginateQuery({
      queryBuilder: qb,
      cursorField: "row.createdAt",
      limit: 2,
    });

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.items).toEqual([]);
  });

  it("supports a configurable sort field other than createdAt (e.g. a numeric score)", async () => {
    const rows = [makeRow({ id: "a", score: 90 }), makeRow({ id: "b", score: 80 })];
    const qb = makeQueryBuilder(rows);

    const result = await paginateQuery({
      queryBuilder: qb,
      cursorField: "row.score",
      order: "DESC",
      limit: 5,
    });

    expect(qb.orderBy).toHaveBeenCalledWith("row.score", "DESC");
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  it("supports ASC ordering, filtering with '>' when a cursor is supplied", async () => {
    const cursor = encodeQueryCursor("row.score", 80);
    const qb = makeQueryBuilder([makeRow({ id: "c", score: 90 })]);

    await paginateQuery({
      queryBuilder: qb,
      cursorField: "row.score",
      order: "ASC",
      limit: 5,
      cursor,
    });

    expect(qb.orderBy).toHaveBeenCalledWith("row.score", "ASC");
    expect(qb.andWhere).toHaveBeenCalledWith("row.score > :cursor_row_score", {
      cursor_row_score: 80,
    });
  });

  it("rejects a cursor encoded for a different field than the one being paginated", async () => {
    const cursor = encodeQueryCursor("row.score", 80);
    const qb = makeQueryBuilder([]);

    await expect(
      paginateQuery({
        queryBuilder: qb,
        cursorField: "row.createdAt",
        limit: 5,
        cursor,
      })
    ).rejects.toThrow(/was encoded for field "row.score"/);
  });

  it("rejects a malformed cursor string", async () => {
    const qb = makeQueryBuilder([]);

    await expect(
      paginateQuery({
        queryBuilder: qb,
        cursorField: "row.createdAt",
        limit: 5,
        cursor: "not-valid-base64-json!!",
      })
    ).rejects.toThrow(/Invalid cursor/);
  });

  it("rejects a non-positive or non-integer limit", async () => {
    const qb = makeQueryBuilder([]);

    await expect(
      paginateQuery({ queryBuilder: qb, cursorField: "row.createdAt", limit: 0 })
    ).rejects.toThrow(/positive integer/);

    await expect(
      paginateQuery({ queryBuilder: qb, cursorField: "row.createdAt", limit: 1.5 })
    ).rejects.toThrow(/positive integer/);
  });

  it("rejects a cursorField not in '<alias>.<column>' form", async () => {
    const qb = makeQueryBuilder([]);

    await expect(
      paginateQuery({ queryBuilder: qb, cursorField: "createdAt", limit: 5 })
    ).rejects.toThrow(/Invalid cursorField/);
  });

  it("treats a null cursor the same as an absent cursor (first page)", async () => {
    const qb = makeQueryBuilder([makeRow()]);

    await paginateQuery({
      queryBuilder: qb,
      cursorField: "row.createdAt",
      limit: 5,
      cursor: null,
    });

    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it("applies a secondary id tiebreaker so equal sort values order deterministically", async () => {
    const rows = [
      makeRow({ id: "1", createdAt: new Date("2024-01-01T00:00:00.000Z"), score: 50 }),
      makeRow({ id: "2", createdAt: new Date("2024-01-01T00:00:00.000Z"), score: 50 }),
      makeRow({ id: "3", createdAt: new Date("2024-01-01T00:00:00.000Z"), score: 50 }),
    ];
    const qb = makeQueryBuilder(rows);

    await paginateQuery({
      queryBuilder: qb,
      cursorField: "row.score",
      limit: 2,
    });

    // Primary column DESC plus secondary id ASC tiebreaker.
    expect(qb.orderBy).toHaveBeenCalledWith("row.score", "DESC");
    expect(qb.addOrderBy).toHaveBeenCalledWith("row.id", "ASC");
  });

  it("encodes the primary row value and its id in a page cursor for stable resumption", async () => {
    const rows = [
      makeRow({ id: "1", createdAt: new Date("2024-01-02T00:00:00.000Z"), score: 100 }),
      makeRow({ id: "2", createdAt: new Date("2024-01-01T00:00:00.000Z"), score: 90 }),
      makeRow({ id: "3", createdAt: new Date("2023-12-31T00:00:00.000Z"), score: 80 }),
    ];
    const qb = makeQueryBuilder(rows);

    const result = await paginateQuery({
      queryBuilder: qb,
      cursorField: "row.score",
      limit: 2,
    });

    expect(result.hasMore).toBe(true);
    const decoded = decodeQueryCursor(result.nextCursor as string);
    expect(decoded.field).toBe("row.score");
    expect(decoded.value).toBe(90);
    expect(decoded.id).toBe("2");
  });

  it("filters strictly past both the primary value and the id tiebreaker when a cursor carries an id", async () => {
    const cursor = encodeQueryCursor("row.score", 90, "2");
    const qb = makeQueryBuilder([makeRow({ id: "3", score: 90 })]);

    await paginateQuery({
      queryBuilder: qb,
      cursorField: "row.score",
      limit: 5,
      cursor,
    });

    expect(qb.andWhere).toHaveBeenCalledWith(
      "(row.score < :cursor_row_score OR (row.score = :cursor_row_score AND row.id > :cursor_row_id))",
      { cursor_row_score: 90, cursor_row_id: "2" }
    );
  });

  it("supports composite ASC filtering with an id tiebreaker", async () => {
    const cursor = encodeQueryCursor("row.score", 90, "2");
    const qb = makeQueryBuilder([makeRow({ id: "3", score: 90 })]);

    await paginateQuery({
      queryBuilder: qb,
      cursorField: "row.score",
      order: "ASC",
      limit: 5,
      cursor,
    });

    expect(qb.andWhere).toHaveBeenCalledWith(
      "(row.score > :cursor_row_score OR (row.score = :cursor_row_score AND row.id > :cursor_row_id))",
      { cursor_row_score: 90, cursor_row_id: "2" }
    );
  });
});

describe("encodeQueryCursor / decodeQueryCursor", () => {
  it("round-trips a string value", () => {
    const cursor = encodeQueryCursor("row.id", "abc-123");
    expect(decodeQueryCursor(cursor)).toEqual({ field: "row.id", value: "abc-123" });
  });

  it("round-trips a numeric value", () => {
    const cursor = encodeQueryCursor("row.score", 42);
    expect(decodeQueryCursor(cursor)).toEqual({ field: "row.score", value: 42 });
  });

  it("round-trips a Date value as an ISO string", () => {
    const date = new Date("2024-06-15T12:00:00.000Z");
    const cursor = encodeQueryCursor("row.createdAt", date);
    expect(decodeQueryCursor(cursor)).toEqual({
      field: "row.createdAt",
      value: date.toISOString(),
    });
  });

  it("produces an opaque base64 string that does not leak plaintext field/value", () => {
    const cursor = encodeQueryCursor("row.id", "super-secret-id");
    expect(cursor).not.toContain("super-secret-id");
    expect(cursor).not.toContain("row.id");
  });

  it("throws on a cursor missing the field/value shape", () => {
    const badCursor = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64");
    expect(() => decodeQueryCursor(badCursor)).toThrow(/missing 'field' or 'value'/);
  });
});
