import {
  ContractGuardService,
  PAUSE_STATE_TTL_MS,
  buildPausedLedgerKey,
} from "@/services/stellar/contract-guard.service";

const RPC_URL = "https://soroban-testnet.example/rpc";
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

/**
 * Stand-in for a base64 ledger entry. The real decoder is XDR; these tests
 * inject a trivial one so they exercise the caching, concurrency and failure
 * behaviour rather than re-testing the SDK's codec.
 */
function pausedEntryXdr(paused: boolean): string {
  return paused ? "PAUSED" : "NOT_PAUSED";
}

const decodeEntry = (entryXdr: string) => entryXdr === "PAUSED";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function entriesResponse(paused: boolean | null) {
  return jsonResponse({
    jsonrpc: "2.0",
    id: 1,
    result: {
      entries: paused === null ? [] : [{ key: "k", xdr: pausedEntryXdr(paused) }],
    },
  });
}

describe("ContractGuardService", () => {
  let currentTime: number;
  const now = () => currentTime;

  beforeEach(() => {
    currentTime = 1_700_000_000_000;
  });

  function createService(fetchFn: jest.Mock, ttlMs?: number) {
    return new ContractGuardService({
      rpcUrl: RPC_URL,
      fetchFn: fetchFn as unknown as typeof fetch,
      now,
      ttlMs,
      decodeEntry,
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
      } as never,
    });
  }

  it("requires an rpcUrl", () => {
    expect(() => new ContractGuardService({ rpcUrl: "" })).toThrow("rpcUrl is required.");
  });

  describe("buildPausedLedgerKey", () => {
    it("produces a deterministic base64 key for a contract", () => {
      const key = buildPausedLedgerKey(CONTRACT_ID);
      expect(key).toEqual(buildPausedLedgerKey(CONTRACT_ID));
      expect(key).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(key.length).toBeGreaterThan(0);
    });

    it("produces a different key for a different contract", () => {
      const other = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";
      expect(buildPausedLedgerKey(CONTRACT_ID)).not.toEqual(buildPausedLedgerKey(other));
    });
  });

  describe("reading on-chain state", () => {
    it("reports paused when the contract stores true", async () => {
      const fetchFn = jest.fn().mockResolvedValue(entriesResponse(true));
      const service = createService(fetchFn);

      await expect(service.checkContractPauseState(CONTRACT_ID)).resolves.toBe(true);
    });

    it("reports not paused when the contract stores false", async () => {
      const fetchFn = jest.fn().mockResolvedValue(entriesResponse(false));
      const service = createService(fetchFn);

      await expect(service.checkContractPauseState(CONTRACT_ID)).resolves.toBe(false);
    });

    it("treats a missing Paused entry as not paused", async () => {
      const fetchFn = jest.fn().mockResolvedValue(entriesResponse(null));
      const service = createService(fetchFn);

      await expect(service.checkContractPauseState(CONTRACT_ID)).resolves.toBe(false);
    });

    it("queries getLedgerEntries with the contract's persistent Paused key", async () => {
      const fetchFn = jest.fn().mockResolvedValue(entriesResponse(false));
      const service = createService(fetchFn);

      await service.checkContractPauseState(CONTRACT_ID);

      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe(RPC_URL);
      const body = JSON.parse(init.body);
      expect(body.method).toBe("getLedgerEntries");
      expect(body.params.keys).toEqual([buildPausedLedgerKey(CONTRACT_ID)]);
    });
  });

  describe("caching", () => {
    it("defaults to a 15 second TTL", () => {
      expect(PAUSE_STATE_TTL_MS).toBe(15_000);
    });

    it("serves repeat calls inside the TTL from cache without hitting the RPC", async () => {
      const fetchFn = jest.fn().mockResolvedValue(entriesResponse(true));
      const service = createService(fetchFn);

      await service.checkContractPauseState(CONTRACT_ID);
      currentTime += PAUSE_STATE_TTL_MS - 1;
      await service.checkContractPauseState(CONTRACT_ID);

      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("re-reads once the TTL has elapsed", async () => {
      const fetchFn = jest
        .fn()
        .mockResolvedValueOnce(entriesResponse(false))
        .mockResolvedValueOnce(entriesResponse(true));
      const service = createService(fetchFn);

      await expect(service.checkContractPauseState(CONTRACT_ID)).resolves.toBe(false);
      currentTime += PAUSE_STATE_TTL_MS;
      await expect(service.checkContractPauseState(CONTRACT_ID)).resolves.toBe(true);

      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("caches per contract rather than globally", async () => {
      const other = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
      const fetchFn = jest.fn().mockResolvedValue(entriesResponse(false));
      const service = createService(fetchFn);

      await service.checkContractPauseState(CONTRACT_ID);
      await service.checkContractPauseState(other);

      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("collapses concurrent reads of the same contract into one RPC call", async () => {
      const fetchFn = jest.fn().mockResolvedValue(entriesResponse(true));
      const service = createService(fetchFn);

      const results = await Promise.all([
        service.checkContractPauseState(CONTRACT_ID),
        service.checkContractPauseState(CONTRACT_ID),
        service.checkContractPauseState(CONTRACT_ID),
      ]);

      expect(results).toEqual([true, true, true]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("forgets everything when the cache is cleared", async () => {
      const fetchFn = jest.fn().mockResolvedValue(entriesResponse(false));
      const service = createService(fetchFn);

      await service.checkContractPauseState(CONTRACT_ID);
      service.clearCache();
      await service.checkContractPauseState(CONTRACT_ID);

      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  describe("degraded RPC", () => {
    it("serves the last known reading when a refresh fails", async () => {
      const fetchFn = jest
        .fn()
        .mockResolvedValueOnce(entriesResponse(true))
        .mockRejectedValueOnce(new Error("connection reset"));
      const service = createService(fetchFn);

      await expect(service.checkContractPauseState(CONTRACT_ID)).resolves.toBe(true);
      currentTime += PAUSE_STATE_TTL_MS;

      // The refresh fails, but the last thing we knew was "paused", so the
      // guard keeps blocking rather than opening up during an incident.
      await expect(service.checkContractPauseState(CONTRACT_ID)).resolves.toBe(true);
    });

    it("assumes not paused when no reading has ever succeeded", async () => {
      const fetchFn = jest.fn().mockRejectedValue(new Error("connection reset"));
      const service = createService(fetchFn);

      await expect(service.checkContractPauseState(CONTRACT_ID)).resolves.toBe(false);
    });

    it("treats a non-2xx RPC response as a failure", async () => {
      const fetchFn = jest.fn().mockResolvedValue(jsonResponse({}, false, 502));
      const service = createService(fetchFn);

      await expect(service.checkContractPauseState(CONTRACT_ID)).resolves.toBe(false);
    });

    it("treats a JSON-RPC error payload as a failure", async () => {
      const fetchFn = jest
        .fn()
        .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, error: { message: "boom" } }));
      const service = createService(fetchFn);

      await expect(service.checkContractPauseState(CONTRACT_ID)).resolves.toBe(false);
    });

    it("does not cache a failed read as a negative result", async () => {
      const fetchFn = jest
        .fn()
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValueOnce(entriesResponse(true));
      const service = createService(fetchFn);

      await expect(service.checkContractPauseState(CONTRACT_ID)).resolves.toBe(false);
      // No TTL advance: a failure must not have poisoned the cache with false.
      await expect(service.checkContractPauseState(CONTRACT_ID)).resolves.toBe(true);
    });
  });
});
