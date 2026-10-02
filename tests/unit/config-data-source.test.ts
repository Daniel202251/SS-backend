type LoggerMock = {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

function createLoggerMock(): LoggerMock {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function createDataSourceMock(overrides: Partial<{
  isInitialized: boolean;
  initialize: jest.Mock;
  destroy: jest.Mock;
  options: Record<string, unknown>;
}> = {}) {
  return {
    isInitialized: false,
    initialize: jest.fn(async () => {
      /* default succeeds */
    }),
    destroy: jest.fn(async () => {
      /* default succeeds */
    }),
    options: { type: "sqlite", migrationsRun: false },
    ...overrides,
  };
}

describe("data-source module", () => {
  const ORIGINAL_ENV = process.env;

  let loggerMock: LoggerMock;
  let DataSourceMock: jest.Mock;
  let dataSourceInstance: ReturnType<typeof createDataSourceMock>;
  let loggerModuleId: string;
  let dataSourceModuleId: string;

  async function loadFreshModule(): Promise<{
    dataSource: typeof dataSourceInstance;
    mod: typeof import("../../src/config/data-source");
  }> {
    jest.resetModules();
    jest.doMock("../../src/observability/logger", () => ({
      logger: loggerMock,
    }));
    jest.doMock("../../src/config/database", () => {
      DataSourceMock(dataSourceInstance);
      return { default: dataSourceInstance, __esModule: true };
    });
    const mod = await import("../../src/config/data-source");
    return { dataSource: dataSourceInstance, mod };
  }

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, NODE_ENV: "test" };
    loggerMock = createLoggerMock();
    DataSourceMock = jest.fn();
    dataSourceInstance = createDataSourceMock();
    loggerModuleId = "../../src/observability/logger";
    dataSourceModuleId = "../../src/config/database";
  });

  afterEach(() => {
    jest.resetModules();
    jest.dontMock(loggerModuleId);
    jest.dontMock(dataSourceModuleId);
    process.env = ORIGINAL_ENV;
  });

  it("throws an AppError when the underlying DataSource is missing", async () => {
    jest.resetModules();
    jest.doMock("../../src/observability/logger", () => ({ logger: loggerMock }));
    jest.doMock("../../src/config/database", () => ({ default: undefined, __esModule: true }));

    await expect(import("../../src/config/data-source")).rejects.toMatchObject({
      name: "AppError",
      code: "DATASOURCE_INVALID",
      statusCode: 500,
    });
  });

  it("throws an AppError when the DataSource lacks required TypeORM methods", async () => {
    jest.resetModules();
    jest.doMock("../../src/observability/logger", () => ({ logger: loggerMock }));
    jest.doMock("../../src/config/database", () => ({ default: { foo: "bar" }, __esModule: true }));

    await expect(import("../../src/config/data-source")).rejects.toMatchObject({
      code: "DATASOURCE_SHAPE_INVALID",
    });
  });

  it("initializes the DataSource exactly once across concurrent callers", async () => {
    let resolveInit: () => void = () => {
      throw new Error("resolveInit called before assignment");
    };
    dataSourceInstance.initialize = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = () => {
            dataSourceInstance.isInitialized = true;
            resolve();
          };
        }),
    );

    const { mod } = await loadFreshModule();

    const a = mod.initializeDataSource();
    const b = mod.initializeDataSource();
    const c = mod.initializeDataSource();

    expect(dataSourceInstance.initialize).toHaveBeenCalledTimes(1);

    resolveInit();
    const results = await Promise.all([a, b, c]);

    expect(results).toEqual([dataSourceInstance, dataSourceInstance, dataSourceInstance]);
    expect(dataSourceInstance.initialize).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      "DataSource initialized successfully",
      expect.objectContaining({ driver: "sqlite", duration_ms: expect.any(Number) }),
    );
  });

  it("returns the existing DataSource without reinitializing when already open", async () => {
    dataSourceInstance.isInitialized = true;
    const { mod } = await loadFreshModule();

    const result = await mod.initializeDataSource();

    expect(result).toBe(dataSourceInstance);
    expect(dataSourceInstance.initialize).not.toHaveBeenCalled();
    expect(loggerMock.debug).toHaveBeenCalledWith(
      "DataSource already initialized, reusing connection",
      expect.any(Object),
    );
  });

  it("wraps initialization failures in an AppError and clears the cached promise", async () => {
    const failure = new Error("ECONNREFUSED");
    dataSourceInstance.initialize = jest.fn(async () => {
      throw failure;
    });

    const { mod } = await loadFreshModule();

    await expect(mod.initializeDataSource()).rejects.toMatchObject({ code: "DATASOURCE_INIT_FAILED" });
    await expect(mod.initializeDataSource()).rejects.toMatchObject({ code: "DATASOURCE_INIT_FAILED" });

    expect(dataSourceInstance.initialize).toHaveBeenCalledTimes(2);
    expect(loggerMock.error).toHaveBeenCalledWith(
      "Failed to initialize DataSource",
      expect.objectContaining({ error: "ECONNREFUSED" }),
    );
  });

  it("closes an open DataSource and resets the initialization cache", async () => {
    dataSourceInstance.isInitialized = true;
    const { mod } = await loadFreshModule();

    await mod.closeDataSource();

    expect(dataSourceInstance.destroy).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      "DataSource closed successfully",
      expect.any(Object),
    );

    dataSourceInstance.isInitialized = false;
    await mod.initializeDataSource();
    expect(dataSourceInstance.initialize).toHaveBeenCalledTimes(1);
  });

  it("tolerates closing a DataSource that was never initialized", async () => {
    const { mod } = await loadFreshModule();
    await expect(mod.closeDataSource()).resolves.toBeUndefined();
    expect(dataSourceInstance.destroy).not.toHaveBeenCalled();
  });

  it("wraps shutdown failures in an AppError", async () => {
    dataSourceInstance.isInitialized = true;
    dataSourceInstance.destroy = jest.fn(async () => {
      throw new Error("pool closed");
    });

    const { mod } = await loadFreshModule();

    await expect(mod.closeDataSource()).rejects.toMatchObject({
      code: "DATASOURCE_SHUTDOWN_FAILED",
    });
    expect(loggerMock.error).toHaveBeenCalledWith(
      "Failed to close DataSource",
      expect.objectContaining({ error: "pool closed" }),
    );
  });

  it("reports readiness via isDataSourceReady without initializing", async () => {
    dataSourceInstance.isInitialized = false;
    const { mod } = await loadFreshModule();

    expect(mod.isDataSourceReady()).toBe(false);

    dataSourceInstance.isInitialized = true;
    expect(mod.isDataSourceReady()).toBe(true);
    expect(dataSourceInstance.initialize).not.toHaveBeenCalled();
  });

  it("re-exports the shared DataSource as default for the TypeORM CLI", async () => {
    const { mod } = await loadFreshModule();
    expect(mod.default).toBe(dataSourceInstance);
  });
});
