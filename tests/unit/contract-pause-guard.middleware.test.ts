import { checkContractNotPaused } from "@/middleware/contract-pause-guard.middleware";
import type { ContractGuardService } from "@/services/stellar/contract-guard.service";

const CONTRACT_ID = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

function createContext() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
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

  it("forwards an unexpected guard failure to the error handler rather than allowing the request", async () => {
    const failure = new Error("guard exploded");
    const check = jest.fn().mockRejectedValue(failure);
    const { req, res, next, resMock } = createContext();

    await checkContractNotPaused({
      contractGuardService: guardService(check),
      contractId: CONTRACT_ID,
      logger: silentLogger,
    })(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    const err = (next as jest.Mock).mock.calls[0][0];
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe("PROCESSING_FAILED");
    expect(err.message).toBe("Processing failed");
    expect(resMock.status).not.toHaveBeenCalled();
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
