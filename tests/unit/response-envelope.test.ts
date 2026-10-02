import { buildPaginatedResponse } from "../../src/utils/response-envelope.utils";

describe("buildPaginatedResponse", () => {
  it("returns the correct envelope structure with items and meta", () => {
    const items = [{ id: "1" }, { id: "2" }];
    const result = buildPaginatedResponse(items, 10, 2, "cursor-abc");

    expect(result).toEqual({
      success: true,
      data: items,
      meta: {
        total: 10,
        limit: 2,
        hasNextPage: true,
        nextCursor: "cursor-abc",
      },
    });
  });

  it("sets hasNextPage to false and nextCursor to null when no cursor is provided", () => {
    const items = [{ id: "1" }];
    const result = buildPaginatedResponse(items, 1, 20);

    expect(result.meta.hasNextPage).toBe(false);
    expect(result.meta.nextCursor).toBeNull();
  });

  it("sets hasNextPage to false when nextCursor is an empty string", () => {
    const items: number[] = [];
    const result = buildPaginatedResponse(items, 0, 20, "");

    expect(result.meta.hasNextPage).toBe(false);
    expect(result.meta.nextCursor).toBeNull();
  });

  it("handles an empty items array", () => {
    const result = buildPaginatedResponse([], 0, 20);

    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
    expect(result.meta.hasNextPage).toBe(false);
  });

  it("preserves the generic type of the items array", () => {
    interface Invoice {
      id: string;
      amount: string;
    }

    const invoices: Invoice[] = [
      { id: "inv-1", amount: "5000" },
      { id: "inv-2", amount: "10000" },
    ];

    const result = buildPaginatedResponse(invoices, 2, 10);

    expect(result.data[0].amount).toBe("5000");
    expect(result.data[1].id).toBe("inv-2");
  });
});
