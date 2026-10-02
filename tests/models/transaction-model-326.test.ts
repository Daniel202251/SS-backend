import { Transaction } from "../../src/models/Transaction.model";
import { TransactionType, TransactionStatus } from "../../src/types/enums";
import { AppError } from "../../src/utils/http-error";

describe("Transaction Model - Issue #326 Enhancements", () => {
  it("should sanitize amount and Stellar tx hash on lifecycle hooks", () => {
    const tx = new Transaction();
    tx.userId = "user-326";
    tx.type = TransactionType.INVESTMENT;
    tx.amount = "150.5";
    tx.stellarTxHash = "  abc123def456  ";

    tx.sanitizeTransactionData();

    expect(tx.amount).toBe("150.5000");
    expect(tx.stellarTxHash).toBe("ABC123DEF456");
  });

  it("should throw AppError on negative transaction amount", () => {
    const tx = new Transaction();
    tx.amount = "-50.00";

    expect(() => tx.sanitizeTransactionData()).toThrow(AppError);
  });

  it("should transition to completed status via markCompleted", () => {
    const tx = new Transaction();
    tx.status = TransactionStatus.PENDING;

    tx.markCompleted("HASH12345", 2);

    expect(tx.status).toBe(TransactionStatus.COMPLETED);
    expect(tx.stellarTxHash).toBe("HASH12345");
    expect(tx.stellarOperationIndex).toBe(2);
  });

  it("should transition to failed status via markFailed", () => {
    const tx = new Transaction();
    tx.status = TransactionStatus.PENDING;

    tx.markFailed("Insufficient balance");

    expect(tx.status).toBe(TransactionStatus.FAILED);
  });

  it("should process batch of transactions safely", async () => {
    const tx1 = new Transaction();
    tx1.amount = "100";
    tx1.stellarTxHash = "hash1";

    const tx2 = new Transaction();
    tx2.amount = "250";
    tx2.stellarTxHash = "hash2";

    const batch = await Transaction.processBatchTransactions([tx1, tx2]);
    expect(batch[0].amount).toBe("100.0000");
    expect(batch[0].stellarTxHash).toBe("HASH1");
    expect(batch[1].amount).toBe("250.0000");
    expect(batch[1].stellarTxHash).toBe("HASH2");
  });
});
