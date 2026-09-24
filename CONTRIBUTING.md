# Contributing to StellarSettle API

Thank you for improving StellarSettle. This repository accepts changes through
pull requests targeting `dev`; `main` is reserved for stable releases.

## Before you begin

- Search existing issues and pull requests to avoid duplicate work.
- For behavior changes, agree on scope in an issue before implementation.
- Read [`DEVELOPMENT.md`](./DEVELOPMENT.md) and set up the service with `npm ci`.
- Never include credentials, private customer data, or Stellar secret seeds.

## Commits: Conventional Commits (enforced)

All commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced by **Husky** (`commit-msg` hook) and the **Commitlint** GitHub Action on pull requests.

### Format

```
<type>(<optional scope>): <short description>

[optional body]
```

### Common types

| Type       | Use for                                                 |
| ---------- | ------------------------------------------------------- |
| `feat`     | New feature                                             |
| `fix`      | Bug fix                                                 |
| `docs`     | Documentation only                                      |
| `chore`    | Maintenance, tooling, deps                              |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test`     | Adding or updating tests                                |
| `ci`       | CI / workflow changes                                   |

### Examples

- `feat(auth): add wallet challenge endpoint`
- `fix(invoices): correct net amount rounding`
- `chore: bump typescript to 5.7.2`

### Bypass (emergency only)

Avoid skipping hooks. If absolutely required: `git commit --no-verify` — maintainers may reject such PRs.

### Hook fails with “[input] is required”

Recent **npm** versions can swallow `--edit` when invoked via `npx`. The repo’s `.husky/commit-msg` uses `npx --no -- commitlint --edit "$1"` so the flag reaches Commitlint. If you changed that file locally, restore the `--` before `commitlint`.

---

## Secrets and credentials

- **Never commit** `.env`, `.env.local`, private keys (`.pem`, `.key`), JWT secrets, database URLs with passwords, API keys, or Stellar seed phrases.
- Use **`.env.example`** (or README) for variable _names_ only, with placeholder values.
- If you accidentally commit a secret: rotate the credential immediately and ask maintainers to purge it from git history.
- Prefer running a local secret scanner (e.g. [Gitleaks](https://github.com/gitleaks/gitleaks) CLI) before pushing if you use one; it is optional for this repo.

---

## Pull requests

- Keep each pull request focused and explain observable behavior and trade-offs.
- Add tests for fixes and features; documentation-only changes should verify every command and link.
- **All GitHub Actions workflows must pass** before merge, including API CI and Commitlint.
- Link issues with `Closes #123` in the PR description where applicable.
- Describe configuration, migration, security, or deployment impact explicitly.
- Match existing code style and complete the local gate below.

### Local gate

```bash
npm run verify:openapi
npm run lint
npm run type-check
npm run build
npm test
git diff --check
```

Database and integration changes must also run the applicable migration and E2E
tests. If a check cannot run locally, state the reason and provide equivalent
verification in the pull request.

---

## Local setup

```bash
npm install
```

`npm install` runs the `prepare` script and installs **Husky** hooks automatically.

## 🌿 Branching & Pull Request Workflow

### Default Branch: `dev`

All active development happens on the `dev` branch. The `main` branch is reserved
for stable, production-ready releases only.

### How to Contribute

1. **Fork** the repository (external contributors) or create a branch (team members).
2. **Branch off `dev`**:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes**, commit using [Conventional Commits](https://www.conventionalcommits.org/).
4. **Push to your fork/branch** and open a Pull Request **targeting `dev`**.
5. **Wait for CI checks** to pass (automated via GitHub Actions).
6. **Address review feedback** if requested.
7. **Merge** after approval (maintainers only).

### Branch Protection Rules

- ❌ Direct pushes to `main` are **not allowed**.
- ❌ Direct pushes to `dev` are **not allowed**.
- ✅ All changes must go through a Pull Request.
- ✅ CI status checks must pass before merging.
- ✅ At least 1 maintainer approval is required.

### Branch Naming Convention

- `feature/` — New features
- `fix/` — Bug fixes
- `docs/` — Documentation changes
- `test/` — Test additions/modifications
- `refactor/` — Code refactoring
- `chore/` — Maintenance tasks

## Review checklist

- [ ] Public inputs are validated and errors use stable API codes.
- [ ] Logs contain useful context without credentials or personal data.
- [ ] Money and Stellar amounts avoid floating-point arithmetic.
- [ ] Database changes include migrations and preserve rollback safety.
- [ ] External calls have bounded timeouts/retries and tested failure behavior.
- [ ] Multi-replica behavior is considered for caches, workers, idempotency, and rate limits.
- [ ] Endpoint changes update `docs/openapi.json` and pass `npm run verify:openapi`.
- [ ] New behavior is covered by focused tests and the existing suite remains green.

## Reporting security issues

Do not open a public issue for a suspected vulnerability. Follow the private
reporting process in [`SECURITY.md`](./SECURITY.md).
