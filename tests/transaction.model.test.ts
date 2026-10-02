import "reflect-metadata";
import { getMetadataArgsStorage } from "typeorm";
import { Transaction } from "../src/models/Transaction.model";
import { TransactionType, TransactionStatus } from "../src/types/enums";

function getEntityIndexNames(entity: new (...args: never[]) => unknown): Set<string> {
  const storage = getMetadataArgsStorage();
  return new Set(
    storage.indices
      .filter((index) => index.target === entity)
      .map((index) => String(index.name)),
  );
}

/** Maps column propertyName -> explicit DB column name (when configured). */
function getEntityColumnNames(entity: new (...args: never[]) => unknown): Map<string, string | undefined> {
  const storage = getMetadataArgsStorage();
  const map = new Map<string, string | undefined>();
  for (const column of storage.columns) {
    if (column.target !== entity) continue;
    if (!column.propertyName) continue;
    map.set(column.propertyName, column.options?.name);
  }
  return map;
}

function getEntityRelationNames(entity: new (...args: never[]) => unknown): Set<string> {
  const storage = getMetadataArgsStorage();
  return new Set(
    storage.relations
      .filter((relation) => relation.target === entity)
      .map((relation) => String(relation.propertyName)),
  );
}

describe("Transaction entity", () => {
  it("maps to the transactions table", () => {
    const storage = getMetadataArgsStorage();
    const entity = storage.tables.find((table) => table.target === Transaction);
    expect(entity).toBeDefined();
    expect(entity?.name).toBe("transactions");
  });

  it("declares a composite status/type/timestamp index", () => {
    const names = getEntityIndexNames(Transaction);
    expect(names.has("idx_transactions_status_type_timestamp")).toBe(true);
  });

  it("declares a composite user_id/timestamp index for history fetching", () => {
    const names = getEntityIndexNames(Transaction);
    expect(names.has("idx_transactions_user_id_timestamp")).toBe(true);
  });

  it("exposes the expected scalar columns", () => {
    const columns = getEntityColumnNames(Transaction);

    for (const property of [
      "id",
      "userId",
      "investmentId",
      "invoiceId",
      "amount",
      "type",
      "stellarTxHash",
      "stellarOperationIndex",
      "status",
      "timestamp",
    ]) {
      expect(columns.has(property)).toBe(true);
    }

    expect(columns.get("userId")).toBe("user_id");
    expect(columns.get("investmentId")).toBe("investment_id");
    expect(columns.get("invoiceId")).toBe("invoice_id");
    expect(columns.get("stellarTxHash")).toBe("stellar_tx_hash");
    expect(columns.get("stellarOperationIndex")).toBe("stellar_operation_index");
  });

  it("declares user, investment, and invoice relations", () => {
    const relations = getEntityRelationNames(Transaction);
    expect(relations.has("user")).toBe(true);
    expect(relations.has("investment")).toBe(true);
    expect(relations.has("invoice")).toBe(true);
  });
});

describe("Transaction type/status enums", () => {
  it("has all transaction types used by the domain", () => {
    expect(TransactionType.INVESTMENT).toBe("investment");
    expect(TransactionType.PAYMENT).toBe("payment");
    expect(TransactionType.WITHDRAWAL).toBe("withdrawal");
    expect(TransactionType.REFUND).toBe("refund");
  });

  it("has all transaction statuses", () => {
    expect(TransactionStatus.PENDING).toBe("pending");
    expect(TransactionStatus.COMPLETED).toBe("completed");
    expect(TransactionStatus.FAILED).toBe("failed");
  });
});
