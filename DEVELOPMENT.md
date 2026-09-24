# Development guide

This guide describes the supported local workflow for the StellarSettle API.

## Bootstrap

1. Install Node.js 22+ and npm 10+.
2. Start PostgreSQL 14+ and create a development database.
3. Install exactly the dependencies recorded in the lockfile.
4. Copy the environment template and replace required placeholders.
5. Apply migrations before starting the API.

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run dev
```

Use `npm install` only when intentionally changing dependencies; otherwise it can
rewrite the lockfile. Never place credentials directly in source files or commit
your `.env` file.

## Database workflow

TypeORM uses `src/config/data-source.ts` for CLI operations and the running
application. Do not enable automatic schema synchronization.

```bash
npm run db:migrate:show
npm run db:migrate
npm run db:migrate:revert
```

Every entity change requires a forward migration and, where practical, a safe
revert path. Test migrations against a disposable database before committing.
The detailed process is in [`docs/DB_WORKFLOW.md`](./docs/DB_WORKFLOW.md).

## Running the service

```bash
npm run dev              # reload on src/**/*.ts changes
npm run build
npm start                # execute compiled output
```

Useful probes:

```bash
curl -i http://localhost:3000/health
curl -i http://localhost:3000/health/db
curl -i http://localhost:3000/metrics
```

If startup fails, read the structured error first. The configuration loader
rejects missing `JWT_SECRET`, `IPFS_API_URL`, and `IPFS_JWT`, malformed positive
integer settings, invalid booleans, and unsupported Stellar networks.

## Test strategy

```bash
npm test                         # all Jest tests
npm test -- tests/path.test.ts   # focused file
npm run test:watch               # iterative development
npm run test:coverage            # thresholds from jest.config.js
npm run test:e2e                 # end-to-end suite
```

Integration tests require PostgreSQL. Match CI with:

```bash
export NODE_ENV=test
export DATABASE_URL=postgresql://postgres:password@localhost:5432/stellarsettle_test
npm test
```

Tests should be deterministic and isolated. Reset process-level stores between
tests, avoid live Horizon/IPFS calls, and inject or mock external dependencies.
For concurrency behavior, assert idempotency and final persisted state rather
than timing alone.

## Required checks

Before opening a pull request to `dev`, run:

```bash
npm run verify:openapi
npm run lint
npm run type-check
npm run build
npm test
git diff --check
```

`npm run ci` runs the primary lint, type-check, build, and test gate. The GitHub
workflow also validates migrations and OpenAPI drift where configured.

## Code conventions

- Keep controllers focused on HTTP translation and delegate business logic to services.
- Return the standard `{ success, data }` or `{ success: false, error }` envelope.
- Throw `AppError` for stable API error codes; do not leak provider messages or secrets.
- Use the shared structured logger rather than `console.*`.
- Use `Decimal` or integer stroops for money; do not use binary floating-point arithmetic.
- Preserve idempotency keys and optimistic-lock checks in investment and settlement paths.
- Add or update OpenAPI documentation when an endpoint contract changes.

Formatting and lint fixes are available through `npm run format` and
`npm run lint:fix`. Review automated rewrites before committing.

## Rate limiting in local and distributed environments

The global limiter uses an in-memory store by default. This is suitable for one
local process, but quotas are not shared between replicas. Production deployments
with multiple replicas should inject a compatible shared `express-rate-limit`
store. Store failures fail closed with `RATE_LIMIT_STORE_UNAVAILABLE` by default;
fail-open behavior must be an explicit, risk-reviewed choice.

Set `TRUST_PROXY` to the exact trusted proxy topology. A blanket value can allow
clients to spoof `X-Forwarded-For` and bypass IP-based quotas.

## Troubleshooting

### `npm ci` rejects the lockfile

Confirm `package.json` and `package-lock.json` came from the same commit. If you
are intentionally changing a dependency, run `npm install`, inspect the lockfile
diff, and rerun `npm ci` before committing.

### Database connection or migration failure

Verify `DATABASE_URL`, PostgreSQL reachability, and `npm run db:migrate:show`.
Do not work around migration failures with schema synchronization.

### Tests do not exit

Run the focused test with `--detectOpenHandles`. Close HTTP servers, database
connections, intervals, and workers in `afterEach`/`afterAll` hooks.

### Unexpected 429 responses

Inspect the standard `RateLimit` and `Retry-After` headers, confirm `TRUST_PROXY`,
and verify that all replicas use the same shared store in production.

## Debugging external integrations

Use Stellar testnet and mocked IPFS providers during development. Log provider
status, request IDs, and safe identifiers, but never log JWTs, API keys, signed
transactions, or Stellar secret seeds. Bound retries and surface stable `AppError`
codes so downstream callers can distinguish retryable failures.
