import { encodeCursor, decodeCursor } from "../../src/utils/cursor-pagination.utils";

describe("encodeCursor / decodeCursor", () => {
  it("encodes and decodes a cursor correctly", () => {
    const date = new Date("2026-07-28T15:00:00.000Z");
    const id = "abc-123-def";

    const cursor = encodeCursor(date, id);
    const decoded = decodeCursor(cursor);

    expect(decoded.createdAt.toISOString()).toBe(date.toISOString());
    expect(decoded.id).toBe(id);
  });

  it("produces a valid base64 string", () => {
    const date = new Date();
    const id = "some-uuid-here";
    const cursor = encodeCursor(date, id);

    // Should be a non-empty base64 string
    expect(cursor).toBeTruthy();
    expect(typeof cursor).toBe("string");

    // Should be decodable by standard base64
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    expect(decoded).toContain("::");
  });

  it("handles UUIDs with hyphens and numbers", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    const id = "550e8400-e29b-41d4-a716-446655440000";

    const cursor = encodeCursor(date, id);
    const decoded = decodeCursor(cursor);

    expect(decoded.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(decoded.id).toBe(id);
  });

  it("handles dates with timezone offsets correctly", () => {
    // Date with +05:30 offset
    const date = new Date("2026-07-28T20:30:00.000+05:30");
    const id = "test-id";

    const cursor = encodeCursor(date, id);
    const decoded = decodeCursor(cursor);

    // Should normalize to UTC
    expect(decoded.createdAt.toISOString()).toBe("2026-07-28T15:00:00.000Z");
    expect(decoded.id).toBe(id);
  });

  it("throws on invalid cursor format (no separator)", () => {
    const invalidCursor = Buffer.from("just-a-string-without-separator").toString("base64");

    expect(() => decodeCursor(invalidCursor)).toThrow("Invalid cursor format");
  });

  it("throws on cursor with empty date component", () => {
    const invalidCursor = Buffer.from("::some-id").toString("base64");

    expect(() => decodeCursor(invalidCursor)).toThrow("Invalid cursor format");
  });

  it("throws on cursor with empty id component", () => {
    const invalidCursor = Buffer.from("2026-07-28T15:00:00.000Z::").toString("base64");

    expect(() => decodeCursor(invalidCursor)).toThrow("Invalid cursor format");
  });

  it("throws on cursor with unparseable date", () => {
    const invalidCursor = Buffer.from("not-a-date::some-id").toString("base64");

    expect(() => decodeCursor(invalidCursor)).toThrow("Invalid cursor format");
  });

  it("throws on completely invalid base64 string", () => {
    expect(() => decodeCursor("!!!not-valid-base64!!!")).toThrow();
  });

  it("supports ids containing pipe characters (:: is the separator)", () => {
    const date = new Date("2026-07-28T15:00:00.000Z");
    const id = "pipe|in|id";

    const cursor = encodeCursor(date, id);
    const decoded = decodeCursor(cursor);

    expect(decoded.createdAt.toISOString()).toBe(date.toISOString());
    expect(decoded.id).toBe(id);
  });
});
