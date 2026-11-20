# Billing backend

NestJS 12 modular monolith on PostgreSQL 17 + Prisma 7 — the system of record for BillSynix
frontend (admin dashboard, POS, desktop app). Plan: [`../BACKEND_IMPLEMENTATION.md`](../BACKEND_IMPLEMENTATION.md).

| Phase | Status |
| --- | --- |
| 0 — Requirements & decisions | ✅ Defaults accepted — [`docs/phase-0`](docs/phase-0), [`docs/adr`](docs/adr) · invoice series still to confirm with a GST professional |
| 1 — Foundation & developer experience | ✅ Done |
| 2 — Multi-tenant data foundation | ✅ Done — [`docs/phase-2-tenancy.md`](docs/phase-2-tenancy.md) |
| 3 — Authentication & authorization | ✅ Done — [`docs/phase-3-auth.md`](docs/phase-3-auth.md) |
| 4 — Products, pricing & tax | ✅ Done — [`docs/phase-4-catalogue.md`](docs/phase-4-catalogue.md) |
| 5 — Inventory & stock ledger | ✅ Done — [`docs/phase-5-inventory.md`](docs/phase-5-inventory.md) |
| 6 — Suppliers & purchases | ✅ Done — [`docs/phase-6-purchasing.md`](docs/phase-6-purchasing.md) |
| 7 — POS sales, invoices & payments | ✅ Done — [`docs/phase-7-sales.md`](docs/phase-7-sales.md) |
| 8 — Frontend integration | ✅ Done (core workflows) — [`docs/phase-8-frontend.md`](docs/phase-8-frontend.md) |
| 9 — Offline POS & sync | ✅ Done — [`docs/phase-9-offline.md`](docs/phase-9-offline.md) · back-office review screen still to build |
| 10 — Reports, finance & subscriptions | ✅ Done — [`docs/phase-10-finance.md`](docs/phase-10-finance.md) · payment gateway to confirm; screens still to build |
| 11 — Notifications, audit & background jobs | ⏳ Next |
| 12 | Not started |

## Requirements

* Node.js 24 LTS (`.nvmrc` style pin in `package.json` → `engines`)
* Docker Desktop (for PostgreSQL), or your own PostgreSQL 16+

## First-time setup

```bash
cd backend
cp .env.example .env            # adjust if your ports differ
docker compose up -d db         # PostgreSQL on localhost:5433 (+ billing_test database)
npm install                     # also generates the Prisma client
npm run db:deploy               # apply migrations to the dev database
npm run start:dev               # http://localhost:4000/api/v1
```

* Swagger UI: <http://localhost:4000/api/docs> · OpenAPI JSON: `/api/docs-json`
* Liveness: `GET /api/v1/health` · Readiness (checks the DB): `GET /api/v1/health/ready`

Run everything in containers instead: `docker compose --profile api up --build`.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run start:dev` | API with watch mode |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | HTTP tests against the real `billing_test` database (migrated automatically) |
| `npm run lint` / `npm run format` | oxlint (type-aware) / Prettier |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate -- --name <change>` | Create + apply a migration after editing `prisma/schema.prisma` |
| `npm run db:deploy` | Apply pending migrations (CI / production) |
| `npm run db:studio` | Browse data |
| `npm run build` → `npm run start:prod` | Production build |

## Layout

```
src/
  main.ts / bootstrap.ts     app start-up (shared with tests: prefix, helmet, CORS, Swagger)
  config/                    env schema (Zod) — the app refuses to boot on bad config
  common/                    error format, exception filter, validation pipe, logging
  database/                  PrismaService (pg driver adapter)
  health/                    liveness + readiness
  access/                    permission catalogue, system roles, live permission resolution
  auth/                      sign-in, sessions, PIN login, guards, @RequirePermissions / @CurrentAuth
  mail/                      outgoing email (development transport until Phase 11)
  catalogue/                 products, barcodes, categories, brands, units, tax rates, price lists, CSV
  storage/                   uploaded files (local disk or S3-compatible)
  inventory/                 stock ledger, balances, batches, adjustments, counts, transfers
  purchasing/                suppliers, POs, goods receipts, returns, payments, payables
  sales/                     POS sales, invoices, payments, returns, cash drawers
  reports/                   sales summary for dashboards (full reporting: Phase 10)
  audit/                     append-only audit trail
  tenants/                   onboarding + business profile
  stores/                    branches, counters, POS devices
  memberships/               staff, roles, branch assignment
  generated/prisma/          generated client (git-ignored)
prisma/                      schema, migrations, seed
test/                        end-to-end tests
docs/                        phase-0 decisions, ADRs
```

## Conventions (see `docs/phase-0/05-api-conventions.md`)

* All routes under `/api/v1`. Errors are always
  `{ "error": { "code", "message", "details?", "requestId" } }`; internals are never returned.
* Every response has `X-Request-Id`; logs are JSON (pino) and carry the same id.
* Validate input with Zod: `@Body({ schema })`, `@Query({ schema })`, `@Param('id', { schema })`.
  The same schemas generate the OpenAPI document.
* Imports between source files end in `.js` (ESM).
* Never edit an applied migration; add a new one. CI fails if the schema and migrations drift.
* Two database roles: the API runs as `billing_app` (row-level security applies), migrations as
  the owner (`DIRECT_URL`). Tenant-owned queries go through `prisma.withTenant(tenantId, tx => …)`.
  See [`docs/phase-2-tenancy.md`](docs/phase-2-tenancy.md).

## CI

`.github/workflows/backend-ci.yml`: lint → format → type-check → migrations apply and match the
schema → unit tests → e2e tests (PostgreSQL service) → build → Docker image.
