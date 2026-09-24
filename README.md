# StellarSettle API

Backend API for StellarSettle, an invoice-financing platform that settles on
Stellar and uses Soroban contracts for escrow and payment distribution.

## What this service provides

- Stellar wallet challenge authentication and short-lived JWT access tokens
- Seller invoice creation, document upload, KYC-gated publishing, and lifecycle tracking
- Public marketplace discovery with cursor pagination, filtering, and sorting
- Fractional investments with idempotent payment verification and reconciliation
- Settlement orchestration, notifications, webhooks, health checks, and Prometheus metrics

## Requirements

- Node.js 22 or newer and npm 10 or newer
- PostgreSQL 14 or newer
- Stellar testnet credentials for payment verification
- Pinata-compatible IPFS credentials for document uploads

## Quick start

```bash
git clone https://github.com/StellarState/SS-backend.git
cd SS-backend
npm ci
cp .env.example .env
npm run db:migrate
npm run dev
```

The API listens on `http://localhost:3000` by default. Confirm startup with:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/health/db
```

`GET /metrics` is available when `METRICS_ENABLED=true`.

## Configuration

Start from [`.env.example`](./.env.example). Startup validates required values
and exits with an actionable error instead of running with partial configuration.

Required for a normal local boot:

| Variable       | Purpose                                                |
| -------------- | ------------------------------------------------------ |
| `DATABASE_URL` | PostgreSQL connection URL                              |
| `JWT_SECRET`   | JWT signing secret; use a unique non-placeholder value |
| `IPFS_API_URL` | Pinning API endpoint                                   |
| `IPFS_JWT`     | Pinning service credential                             |

Useful operational settings:

| Variable          | Purpose                                                                     | Default                       |
| ----------------- | --------------------------------------------------------------------------- | ----------------------------- |
| `LOG_LEVEL`       | Winston log verbosity (`error`, `warn`, `info`, `debug`)                     | `info` (`silent` in tests)    |
| `METRICS_ENABLED` | Exposes `GET /metrics` (Prometheus) when `true`                              | `true`                        |
| `PORT`            | HTTP port                                                                   | `3000`                        |

Security-sensitive operational settings include `TRUST_PROXY`,
`CORS_ALLOWED_ORIGINS`, `ADMIN_IP_WHITELIST`, and the `RATE_LIMIT_*` values.
Only enable `TRUST_PROXY` when requests arrive through a trusted proxy; Express
uses it when resolving the client IP for global rate limiting.

Soroban funding is opt-in. Configure `SOROBAN_ESCROW_ENABLED`,
`SOROBAN_ESCROW_CONTRACT_ID`, `SOROBAN_RPC_URL`, and the contract-specific
variables documented in [the integration guide](./docs/SOROBAN_INTEGRATION_GUIDE.md).
Never commit live keys or Stellar secret seeds.

## Common commands

| Command                     | Purpose                                |
| --------------------------- | -------------------------------------- |
| `npm run dev`               | Run the TypeScript server with reloads |
| `npm run build`             | Compile to `dist/`                     |
| `npm start`                 | Run the compiled server                |
| `npm test`                  | Run the Jest suite                     |
| `npm run test:e2e`          | Run end-to-end tests                   |
| `npm run lint`              | Lint application TypeScript            |
| `npm run type-check`        | Type-check without emitting files      |
| `npm run verify:openapi`    | Detect route/OpenAPI drift             |
| `npm run db:migrate`        | Apply pending TypeORM migrations       |
| `npm run db:migrate:revert` | Revert the latest migration            |

Run the complete local gate with `npm run ci`. Database integration tests require
a reachable PostgreSQL instance and an appropriate `DATABASE_URL`.

## API surface

All application routes use the `/api/v1` prefix.

- `/api/v1/auth` — wallet challenge authentication
- `/api/v1/kyc` — KYC submission, status, and webhook ingestion
- `/api/v1/invoices` — invoice CRUD, publishing, lifecycle, and document upload
- `/api/v1/marketplace` — public invoice discovery
- `/api/v1/investments` — investment creation and history
- `/api/v1/settlements` — settlement operations
- `/api/v1/notifications` — user notifications
- `/api/v1/admin` — allowlisted administrative operations

The checked-in OpenAPI contract is [`docs/openapi.json`](./docs/openapi.json).
Feature-specific references are available under [`docs/`](./docs/):

| Doc | Covers |
| --- | ------ |
| [`docs/MARKETPLACE_API.md`](./docs/MARKETPLACE_API.md) | Public invoice discovery API |
| [`docs/INVOICE_LIFECYCLE.md`](./docs/INVOICE_LIFECYCLE.md) | Invoice state machine |
| [`docs/INVOICE_DOCUMENT_UPLOAD.md`](./docs/INVOICE_DOCUMENT_UPLOAD.md) | Document upload flow |
| [`docs/INVOICE_INVEST_API.md`](./docs/INVOICE_INVEST_API.md) | Fractional investment flow |
| [`docs/SOROBAN_INTEGRATION_GUIDE.md`](./docs/SOROBAN_INTEGRATION_GUIDE.md) | Escrow/funding integration |
| [`docs/DB_WORKFLOW.md`](./docs/DB_WORKFLOW.md) | Migration workflow |
| [`docs/IPFS.md`](./docs/IPFS.md) | IPFS pinning details |

## Architecture

```text
src/
├── config/          environment, database, and Stellar configuration
├── controllers/     HTTP request/response adapters
├── middleware/      security, validation, throttling, and observability
├── models/          TypeORM entities
├── routes/          API route composition
├── services/        business and external-integration logic
│   └── stellar/     Horizon and Soroban integrations
├── workers/         bounded background reconciliation
├── observability/   structured logging, redaction, and metrics
└── utils/           shared pure helpers
```

Controllers should remain thin; business rules belong in services, and database
schema changes must be represented by migrations. See
[`DEVELOPMENT.md`](./DEVELOPMENT.md) for the full workflow.

## Reliability and security

- Structured Winston logs redact sensitive values and include request correlation data.
- Global throttling defaults to 100 requests per minute and emits standard rate-limit headers.
- Multiple API replicas should provide a shared `express-rate-limit` store; the in-memory default is process-local.
- Input sanitization, Helmet, CORS allowlists, admin CIDR allowlists, and parameterized TypeORM queries form the HTTP boundary.
- The reconciliation worker is disabled by default. Run one worker replica unless distributed locking is added.

See [`SECURITY.md`](./SECURITY.md) for private vulnerability reporting.

## Environment variable groups

[`.env.example`](./.env.example) is the canonical list, grouped by domain:

| Group | Variables |
| ----- | --------- |
| Server | `PORT`, `NODE_ENV` |
| HTTP security | `TRUST_PROXY`, `CORS_ORIGIN`, `CORS_ALLOWED_ORIGINS`, `CORS_ALLOW_CREDENTIALS`, `HTTP_BODY_SIZE_LIMIT`, `HTTP_SHUTDOWN_TIMEOUT_MS` |
| Rate limiting | `RATE_LIMIT_ENABLED`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` |
| Database | `DATABASE_URL` |
| Stellar | `STELLAR_NETWORK`, `STELLAR_HORIZON_URL`, `STELLAR_USDC_ASSET_CODE`, `STELLAR_USDC_ASSET_ISSUER`, `STELLAR_ESCROW_PUBLIC_KEY`, `STELLAR_VERIFY_ALLOWED_AMOUNT_DELTA`, `STELLAR_VERIFY_RETRY_ATTEMPTS`, `STELLAR_VERIFY_RETRY_BASE_DELAY_MS`, `PLATFORM_SECRET_KEY` |
| Smart contracts | `ESCROW_CONTRACT_ID`, `TOKEN_CONTRACT_ID`, and the Soroban escrow variables from the [integration guide](./docs/SOROBAN_INTEGRATION_GUIDE.md) |
| IPFS | `IPFS_API_URL`, `IPFS_JWT`, `IPFS_MAX_FILE_SIZE_MB`, `IPFS_ALLOWED_MIME_TYPES`, `IPFS_UPLOAD_RATE_LIMIT_*` |
| Auth | `JWT_SECRET`, `JWT_EXPIRES_IN`, `AUTH_CHALLENGE_TTL_MS` |
| Observability | `LOG_LEVEL`, `METRICS_ENABLED` |
| Background reconciliation | `STELLAR_RECONCILIATION_*` |
| Email | `SENDGRID_API_KEY`, `FROM_EMAIL` |
| Admin | `ADMIN_API_KEY`, `ADMIN_IP_WHITELIST` |

## Troubleshooting quick reference

Detailed guidance lives in [`DEVELOPMENT.md`](./DEVELOPMENT.md); the common
failures:

| Symptom | Likely cause / fix |
| ------- | ------------------ |
| `npm ci` rejects the lockfile | Use Node 22 + npm 10 and reinstall with the committed lockfile (`npm ci`), not `npm install`. |
| Server exits at startup with a configuration error | Startup validation fails on missing/placeholder values — complete `.env` (see the table above). |
| Database connection or migration failure | Check `DATABASE_URL`, ensure PostgreSQL 14+ is reachable, then `npm run db:migrate`. |
| Unexpected `429` responses | Global rate limiting (100 req/min default) — raise `RATE_LIMIT_MAX` locally or wait out the window. |
| Jest hangs after tests finish | Known open-handle issue — run `npm run test:ci` which passes `--forceExit`. |

Full guidance: [`DEVELOPMENT.md`](./DEVELOPMENT.md) (§ Troubleshooting).

## Logging and observability

Logs are structured JSON, written by the [`src/observability/logger.ts`](./src/observability/logger.ts)
module.

- **Verbosity** — set `LOG_LEVEL` (`error`, `warn`, `info`, or `debug`). It
  defaults to `info`, and to `silent` when `NODE_ENV=test` so test output stays
  clean. Suppressed levels cost nothing: their log calls short-circuit before
  any metadata processing.
- **Correlation IDs** — every log line emitted while handling an HTTP request
  is stamped with that request's correlation ID by the request-observability
  middleware, so service-level logs join to the HTTP access log.
- **Redaction** — the log pipeline redacts Stellar secret keys, JWTs, Bearer
  headers, and values under sensitive keys (`password`, `secret`, `token`,
  `authorization`, …) before anything reaches a transport.
- **Resilience** — a failing transport or formatter emits a fallback error
  line instead of crashing the request handler; oversized metadata is
  bounded so runaway callers cannot inflate log lines.
- **Health endpoints** — `GET /health` (liveness), `GET /health/db`
  (database), and `GET /metrics` (Prometheus, only when `METRICS_ENABLED=true`).

## Contributing

Pull requests must target `dev`. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md)
before opening a change and use Conventional Commits. For setup and troubleshooting,
see [`DEVELOPMENT.md`](./DEVELOPMENT.md).

## License

MIT
