# StellarSettle API

Backend API for StellarSettle, an invoice-financing platform that settles on
Stellar and uses Soroban contracts for escrow and payment distribution.

## What this service provides

- Stellar wallet challenge authentication and short-lived JWT access tokens
- Seller invoice creation, document upload, KYC-gated publishing, and lifecycle tracking
- Redis caching layer for read-heavy invoice listing and detail routes with automated mutation invalidation and `X-Cache` observability headers
- HMAC-SHA256 signature verification middleware for authenticating third-party webhook payloads
- Public marketplace discovery with cursor pagination, filtering, and sorting
- Fractional investments with idempotent payment verification and reconciliation
- Settlement orchestration, notifications, webhooks, health checks, and Prometheus metrics
- Hardened structured logging with correlation IDs, sensitive data redaction, and cycle-safe serialization

## Requirements

- Node.js 22 or newer and npm 10 or newer
- PostgreSQL 14 or newer
- Redis 6 or newer (optional; API gracefully falls back to direct database access if disconnected)
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

### Redis Caching Settings

| Variable                   | Default                  | Purpose                                                  |
| -------------------------- | ------------------------ | -------------------------------------------------------- |
| `REDIS_URL`                | `redis://localhost:6379` | Redis connection URL (falls back to DB if unreachable)   |
| `CACHE_ENABLED`            | `true`                   | Enable or disable caching layer                          |
| `CACHE_TTL_INVOICES_LIST`  | `30`                     | TTL in seconds for invoice listing (`GET /invoices`)     |
| `CACHE_TTL_INVOICE_DETAIL` | `60`                     | TTL in seconds for invoice details (`GET /invoices/:id`) |

### Webhook & Security Settings

| Variable             | Purpose                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `KYC_WEBHOOK_SECRET` | Shared secret for HMAC-SHA256 signature verification on KYC webhooks |
| `WEBHOOK_SECRET`     | Default shared secret for generic provider webhook signature checks  |

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
- `/api/v1/invoices` — invoice CRUD, publishing, caching, lifecycle, and document upload
- `/api/v1/marketplace` — public invoice discovery
- `/api/v1/investments` — investment creation and history
- `/api/v1/settlements` — settlement operations
- `/api/v1/notifications` — user notifications
- `/api/v1/admin` — allowlisted administrative operations

The checked-in OpenAPI contract is [`docs/openapi.json`](./docs/openapi.json).
Feature-specific references are available under [`docs/`](./docs/).

## Architecture

```text
src/
├── config/          environment, database, cache, and Stellar configuration
├── controllers/     HTTP request/response adapters
├── middleware/      security, validation, HMAC webhooks, and observability
├── models/          TypeORM entities
├── routes/          API route composition and caching integration
├── services/        business, cache, and external-integration logic
│   └── stellar/     Horizon and Soroban integrations
├── workers/         bounded background reconciliation
├── observability/   hardened structured logging, cycle-safe redaction, and metrics
└── utils/           shared pure helpers
```

Controllers should remain thin; business rules belong in services, and database
schema changes must be represented by migrations. See
[`DEVELOPMENT.md`](./DEVELOPMENT.md) for the full workflow.

## Reliability and security

- **Redis Caching Layer**: Frequently accessed invoice listing and detail responses are cached in Redis with configurable TTLs (30s and 60s respectively). Cached responses are served within 10ms with `X-Cache: HIT`, and mutations (create, update, publish, delete) automatically invalidate cache keys. If Redis is unavailable or disconnected, the service falls back to PostgreSQL without error (`X-Cache: MISS`).
- **HMAC-SHA256 Webhook Verification**: Inbound webhooks are verified using constant-time HMAC-SHA256 comparisons (`crypto.timingSafeEqual`) against configured shared secrets before processing, with raw payload preservation on `req.rawBody` and support for configurable signature header names.
- **Hardened Observability**: Winston structured logging stamps request correlation IDs via `AsyncLocalStorage`, redacts sensitive keys, and safely sanitizes `BigInt`, circular references, and `Error` objects to guarantee non-throwing execution.
- **Rate Limiting & Boundary Guards**: Global throttling defaults to 100 requests per minute with per-wallet rate limits on invoice publishing and investment operations.
- **Boundary Defense**: Input sanitization, Helmet, CORS allowlists, admin CIDR allowlists, and parameterized TypeORM queries secure the HTTP boundary.

See [`SECURITY.md`](./SECURITY.md) for private vulnerability reporting.

## Contributing

Pull requests must target `dev`. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md)
before opening a change and use Conventional Commits. For setup and troubleshooting,
see [`DEVELOPMENT.md`](./DEVELOPMENT.md).

## License

MIT
