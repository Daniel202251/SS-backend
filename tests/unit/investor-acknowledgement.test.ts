import { InvestorAcknowledgementService } from "../../src/services/investor-acknowledgement.service";

describe("InvestorAcknowledgementService (issue #473)", () => {
  const originalTerms = process.env.TERMS_VERSION;

  afterEach(() => {
    if (originalTerms === undefined) delete process.env.TERMS_VERSION;
    else process.env.TERMS_VERSION = originalTerms;
  });

  function makeService(rows: Array<Record<string, unknown>> = []) {
    const store = [...rows];
    const repo = {
      create: jest.fn((data: Record<string, unknown>) => ({
        id: "ack-1",
        acknowledgedAt: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        ...data,
      })),
      save: jest.fn(async (row: Record<string, unknown>) => {
        store.push(row);
        return row;
      }),
      findOne: jest.fn(async (opts: { where: Record<string, unknown>; order?: unknown }) => {
        const where = opts.where;
        const matches = store.filter((r) =>
          Object.entries(where).every(([k, v]) => r[k] === v)
        );
        matches.sort(
          (a, b) =>
            new Date(b.acknowledgedAt as string).getTime() -
            new Date(a.acknowledgedAt as string).getTime()
        );
        return matches[0] ?? null;
      }),
    };
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(repo),
    };
    return {
      service: new InvestorAcknowledgementService(dataSource as never),
      repo,
      store,
    };
  }

  it("stores acknowledgement with wallet, timestamp, and terms version", async () => {
    process.env.TERMS_VERSION = "2026-09";
    const { service, repo } = makeService();
    const row = await service.acknowledge({
      walletAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDE",
      userId: "user-1",
    });
    expect(repo.save).toHaveBeenCalled();
    expect(row.termsVersion).toBe("2026-09");
    expect(row.walletAddress).toBe("GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDE");
  });

  it("returns acknowledged:false when only an older terms version was acknowledged", async () => {
    process.env.TERMS_VERSION = "2";
    const { service } = makeService([
      {
        walletAddress: "GWALLET",
        termsVersion: "1",
        acknowledgedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    const status = await service.getStatus("GWALLET");
    expect(status.acknowledged).toBe(false);
    expect(status.currentVersion).toBe("2");
    expect(status.acknowledgedVersion).toBe("1");
  });

  it("returns acknowledged:true for the current terms version", async () => {
    process.env.TERMS_VERSION = "2";
    const { service } = makeService([
      {
        walletAddress: "GWALLET",
        termsVersion: "2",
        acknowledgedAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]);
    const status = await service.getStatus("GWALLET");
    expect(status).toMatchObject({
      acknowledged: true,
      currentVersion: "2",
      acknowledgedVersion: "2",
    });
  });
});
