import {
  PAUSED_RETRY_AFTER_SECONDS,
  checkContractNotPaused,
} from "@/middleware/contract-pause-guard.middleware";
import { AppError } from "@/utils/http-error";
import type { ContractGuardService } from "@/services/stellar/contract-guard.service";

// Valid StrKey contract id (checksummed); the guard rejects malformed ids at startup.
const CONTRACT_ID = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";
const TOKEN_CONTRACT_ID = "CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ";
const DISTRIBUTOR_CONTRACT_ID = "CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L";

function createContext() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    headersSent: false,
  };
  const req = { method: "POST", originalUrl: "/api/v1/investments", path: "/" };
  const next = jest.fn();
  return { req: req as never, res: res as never, next, resMock: res };
}

function guardService(impl: jest.Mock): ContractGuardService {
  return { checkContractPauseState: impl } as unknown as ContractGuardService;
}

const silentLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(),
} as never;

describe("checkContractNotPaused", () => {
  it("lets the request through when the contract is not paused", async () => {
    const check = jest.fn().mockResolvedValue(false);
    const { req, res, next, resMock } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: CONTRACT_ID,
      logger: silentLogger,
    })(req, res, next);

    expect(check).toHaveBeenCalledWith(CONTRACT_ID);
    expect(next).toHaveBeenCalledWith();
    expect(resMock.status).not.toHaveBeenCalled();
  });

  it("rejects with 503 and a CONTRACT_PAUSED error when the contract is paused", async () => {
    const check = jest.fn().mockResolvedValue(true);
    const { req, res, next, resMock } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: CONTRACT_ID,
      logger: silentLogger,
    })(req, res, next);

    expect(resMock.status).toHaveBeenCalledWith(503);
    expect(resMock.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: "CONTRACT_PAUSED",
        message: "Smart contract operations are currently paused by administration.",
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("logs the blocked request so a pause is visible in operations", async () => {
    const warn = jest.fn();
    const check = jest.fn().mockResolvedValue(true);
    const { req, res, next } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: CONTRACT_ID,
      logger: { ...(silentLogger as object), warn } as never,
    })(req, res, next);

    expect(warn).toHaveBeenCalledWith("Request blocked: smart contract is paused", {
      contract_id: CONTRACT_ID,
      method: "POST",
      path: "/api/v1/investments",
    });
  });

  it("is inert when no contract id is configured", async () => {
    const check = jest.fn();
    const { req, res, next, resMock } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: null,
      logger: silentLogger,
    })(req, res, next);

    expect(check).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
    expect(resMock.status).not.toHaveBeenCalled();
  });

  it("rejects with 503 CONTRACT_PAUSE_CHECK_FAILED on an unexpected guard failure rather than allowing the request", async () => {
    const error = jest.fn();
    const check = jest.fn().mockRejectedValue(new Error("guard exploded"));
    const { req, res, next, resMock } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: CONTRACT_ID,
      logger: { ...(silentLogger as object), error } as never,
    })(req, res, next);

    const forwarded = next.mock.calls[0][0];
    expect(forwarded).toBeInstanceOf(AppError);
    expect(forwarded).toMatchObject({ statusCode: 503, code: "CONTRACT_PAUSE_CHECK_FAILED" });
    expect(resMock.status).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "Contract pause state check failed; rejecting request",
      expect.objectContaining({
        contract_id: CONTRACT_ID,
        reason: "error",
        error: "guard exploded",
      })
    );
  });

  it("fails closed when the pause check hangs past the timeout", async () => {
    const error = jest.fn();
    const check = jest.fn().mockReturnValue(new Promise(() => undefined));
    const { req, res, next } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: CONTRACT_ID,
      logger: { ...(silentLogger as object), error } as never,
      timeoutMs: 20,
    })(req, res, next);

    expect(next.mock.calls[0][0]).toMatchObject({
      statusCode: 503,
      code: "CONTRACT_PAUSE_CHECK_FAILED",
    });
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "timeout" })
    );
  });

  it("treats a synchronous throw from the service like any other failure", async () => {
    const check = jest.fn(() => {
      throw new Error("sync boom");
    });
    const { req, res, next } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: CONTRACT_ID,
      logger: silentLogger,
    })(req, res, next);

    expect(next.mock.calls[0][0]).toMatchObject({ code: "CONTRACT_PAUSE_CHECK_FAILED" });
  });

  it("sets Retry-After on a paused rejection", async () => {
    const { req, res, next, resMock } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(jest.fn().mockResolvedValue(true)),
      contractId: CONTRACT_ID,
      logger: silentLogger,
    })(req, res, next);

    expect(resMock.setHeader).toHaveBeenCalledWith(
      "Retry-After",
      String(PAUSED_RETRY_AFTER_SECONDS)
    );
  });

  it("does not write a response when headers were already sent", async () => {
    const { req, res, next, resMock } = createContext();
    resMock.headersSent = true;

    await checkContractNotPaused({
      contractGuardService: guardService(jest.fn().mockResolvedValue(true)),
      contractId: CONTRACT_ID,
      logger: silentLogger,
    })(req, res, next);

    expect(resMock.status).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps the query string out of logs", async () => {
    const warn = jest.fn();
    const { req, res, next } = createContext();
    (req as { originalUrl: string }).originalUrl = "/api/v1/investments?token=secret";

    await checkContractNotPaused({
      contractGuardService: guardService(jest.fn().mockResolvedValue(true)),
      contractId: CONTRACT_ID,
      logger: { ...(silentLogger as object), warn } as never,
    })(req, res, next);

    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ path: "/api/v1/investments" })
    );
  });

  it("trims the configured contract id and treats a blank id as inert", async () => {
    const check = jest.fn().mockResolvedValue(false);

    const trimmed = createContext();
    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: `  ${CONTRACT_ID}\n`,
      logger: silentLogger,
    })(trimmed.req, trimmed.res, trimmed.next);
    expect(check).toHaveBeenCalledWith(CONTRACT_ID);

    check.mockClear();
    const blank = createContext();
    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: "   ",
      logger: silentLogger,
    })(blank.req, blank.res, blank.next);
    expect(check).not.toHaveBeenCalled();
    expect(blank.next).toHaveBeenCalledWith();
  });

  it.each([
    ["a malformed contract id", { contractId: "CESCROW123" }, "not a valid Soroban contract id"],
    [
      "an account id instead of a contract id",
      { contractId: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7" },
      "not a valid Soroban contract id",
    ],
    ["a non-positive timeout", { timeoutMs: 0 }, "timeoutMs must be a positive integer"],
  ])("rejects %s at construction", (_label, overrides, message) => {
    expect(() =>
      checkContractNotPaused({
        contractGuardService: guardService(jest.fn()),
        contractId: CONTRACT_ID,
        logger: silentLogger,
        ...overrides,
      })
    ).toThrow(message);
  });

  it("re-checks on every request so an unpause takes effect without a restart", async () => {
    const check = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const middleware = checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: CONTRACT_ID,
      logger: silentLogger,
    });

    const blocked = createContext();
    await middleware(blocked.req, blocked.res, blocked.next);
    expect(blocked.resMock.status).toHaveBeenCalledWith(503);

    const allowed = createContext();
    await middleware(allowed.req, allowed.res, allowed.next);
    expect(allowed.next).toHaveBeenCalledWith();
    expect(allowed.resMock.status).not.toHaveBeenCalled();
  });
});

describe("checkContractNotPaused with several contracts", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("checks every contract concurrently and passes when none is paused", async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<boolean>>>();
    const check = jest.fn((id: string) => {
      started.push(id);
      const gate = deferred<boolean>();
      gates.set(id, gate);
      return gate.promise;
    });
    const { req, res, next } = createContext();

    const run = checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: CONTRACT_ID,
      contractIds: [TOKEN_CONTRACT_ID, DISTRIBUTOR_CONTRACT_ID],
      logger: silentLogger,
    })(req, res, next);

    // All reads are in flight before any of them has answered.
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual([CONTRACT_ID, TOKEN_CONTRACT_ID, DISTRIBUTOR_CONTRACT_ID]);

    gates.forEach((gate) => gate.resolve(false));
    await run;
    expect(next).toHaveBeenCalledWith();
  });

  it("blocks as soon as one contract reports paused without waiting for slower reads", async () => {
    const warn = jest.fn();
    const check = jest.fn((id: string) =>
      id === TOKEN_CONTRACT_ID ? Promise.resolve(true) : new Promise<boolean>(() => undefined)
    );
    const { req, res, next, resMock } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractIds: [CONTRACT_ID, TOKEN_CONTRACT_ID],
      logger: { ...(silentLogger as object), warn } as never,
      timeoutMs: 1_000,
    })(req, res, next);

    expect(resMock.status).toHaveBeenCalledWith(503);
    expect(warn).toHaveBeenCalledWith(
      "Request blocked: smart contract is paused",
      expect.objectContaining({ contract_id: TOKEN_CONTRACT_ID })
    );
  });

  it("prefers a paused reading over another contract's failed read", async () => {
    const check = jest.fn((id: string) =>
      id === CONTRACT_ID ? Promise.reject(new Error("rpc down")) : Promise.resolve(true)
    );
    const { req, res, next, resMock } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractIds: [CONTRACT_ID, DISTRIBUTOR_CONTRACT_ID],
      logger: silentLogger,
    })(req, res, next);

    expect(resMock.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "CONTRACT_PAUSED" }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed when a read fails and no contract is paused", async () => {
    const check = jest.fn((id: string) =>
      id === TOKEN_CONTRACT_ID ? Promise.reject(new Error("rpc down")) : Promise.resolve(false)
    );
    const { req, res, next } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractIds: [CONTRACT_ID, TOKEN_CONTRACT_ID],
      logger: silentLogger,
    })(req, res, next);

    expect(next.mock.calls[0][0]).toMatchObject({
      statusCode: 503,
      code: "CONTRACT_PAUSE_CHECK_FAILED",
    });
  });

  it("de-duplicates contracts and ignores blanks", async () => {
    const check = jest.fn().mockResolvedValue(false);
    const { req, res, next } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: CONTRACT_ID,
      contractIds: [` ${CONTRACT_ID} `, null, undefined, "", TOKEN_CONTRACT_ID],
      logger: silentLogger,
    })(req, res, next);

    expect(check).toHaveBeenCalledTimes(2);
    expect(check.mock.calls.map(([id]) => id)).toEqual([CONTRACT_ID, TOKEN_CONTRACT_ID]);
  });

  it("is inert when every configured contract is blank", async () => {
    const check = jest.fn();
    const { req, res, next } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: null,
      contractIds: [null, "  "],
      logger: silentLogger,
    })(req, res, next);

    expect(check).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects a malformed entry in contractIds at construction", () => {
    expect(() =>
      checkContractNotPaused({
        contractGuardService: guardService(jest.fn()),
        contractIds: [CONTRACT_ID, "CTOKEN"],
        logger: silentLogger,
      })
    ).toThrow("not a valid Soroban contract id");
  });
});
