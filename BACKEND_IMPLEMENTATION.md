# billing Backend Implementation Phases

**Product:** billing -- Supermarket Billing, Inventory and Business
Operating System\
**Architecture:** Modular monolith\
**Backend stack:** NestJS, Node.js, TypeScript, PostgreSQL, Prisma\
**Frontend clients:** Existing Lovable/React admin dashboard, POS PWA,
React Native mobile app\
**Primary market:** Indian supermarkets\
**Delivery approach:** Founder-led, budget-conscious MVP with
production-grade transaction and security foundations

------------------------------------------------------------------------

## 1. Goals and architectural principles

Build a secure, multi-tenant backend that supports supermarket
businesses, multiple branches, multiple POS counters, inventory,
purchasing, sales, payments, reporting and SaaS subscriptions.

### Core principles

1.  **NestJS modular monolith:** Keep one deployable backend with
    clearly separated domain modules. Do not start with microservices.
2.  **PostgreSQL as the system of record:** Use relational constraints
    and database transactions for financial and stock operations.
3.  **Prisma for data access:** Use versioned migrations and typed
    queries. Use raw SQL only where justified and reviewed.
4.  **Tenant isolation by design:** Derive tenant context from
    authenticated membership; never trust a tenant ID supplied by the
    browser.
5.  **Branch-aware authorization:** A user can access only the stores
    and counters assigned to them.
6.  **One source of business truth:** The backend calculates prices,
    discounts, tax, totals, payment status and stock changes.
7.  **Auditable inventory:** Record every stock change in an append-only
    movement ledger; maintain balance tables transactionally.
8.  **Idempotent operations:** Retried sales, sync events and payment
    webhooks must not create duplicate business records.
9.  **Offline-capable POS:** Persist sales locally and synchronize
    safely when connectivity returns.
10. **API-first integration:** Document APIs with OpenAPI/Swagger and
    generate frontend types from the contract.
11. **Security and recovery:** Include authorization tests, audit logs,
    backups and restore drills before production.
12. **Phased infrastructure:** Start with managed PostgreSQL and a
    simple deployment. Add Redis, queues and additional services when
    justified.

------------------------------------------------------------------------

## 2. Recommended technology stack

  -----------------------------------------------------------------------
  Area                    Technology              Notes
  ----------------------- ----------------------- -----------------------
  Runtime                 Node.js LTS +           Pin supported versions
                          TypeScript              

  Backend framework       NestJS                  Modular architecture,
                                                  guards, pipes and
                                                  dependency injection

  Database                PostgreSQL              Primary transactional
                                                  database

  ORM                     Prisma                  Schema, migrations and
                                                  typed data access

  API                     REST + OpenAPI/Swagger  Version APIs under
                                                  `/api/v1`

  Authentication          NestJS Passport + JWT   Short-lived access
                          or secure session       credentials and refresh
                          strategy                rotation

  Authorization           RBAC + branch-scoped    Enforce on every
                          permission guards       protected API

  Validation              class-validator or Zod  Standardize DTO
                                                  validation

  Password hashing        Argon2id                Never store plaintext
                                                  passwords

  Offline browser         IndexedDB + Dexie       POS local catalogue and
  database                                        pending sales

  Cache                   Redis (when needed)     Cache, distributed rate
                                                  limiting

  Background jobs         BullMQ + Redis (when    Notifications, exports
                          needed)                 and scheduled jobs

  File storage            S3-compatible storage / Product images and
                          Cloudflare R2           documents

  Logging                 Pino                    Structured logs with
                                                  correlation IDs

  Error monitoring        Sentry or equivalent    API and frontend error
                                                  reporting

  Testing                 Jest, Supertest,        Unit, integration and
                          Playwright              end-to-end tests

  Containers              Docker + Docker Compose Local development and
                                                  deployment

  CI/CD                   GitHub Actions          Lint, test, build,
                                                  migration and deploy
                                                  pipeline
  -----------------------------------------------------------------------

### Keep the initial stack lean

Do not introduce Kubernetes, Kafka, Elasticsearch, microservices or a
data warehouse for the first MVP. Redis and BullMQ can be added when
there is a concrete need for caching or asynchronous processing.

------------------------------------------------------------------------

## 3. Target backend module structure

``` text
billing-backend/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── common/
│   │   ├── decorators/
│   │   ├── guards/
│   │   ├── interceptors/
│   │   ├── filters/
│   │   ├── pipes/
│   │   └── utils/
│   ├── config/
│   ├── database/
│   ├── auth/
│   ├── tenants/
│   ├── memberships/
│   ├── users/
│   ├── roles/
│   ├── stores/
│   ├── counters/
│   ├── products/
│   ├── categories/
│   ├── brands/
│   ├── units/
│   ├── pricing/
│   ├── taxes/
│   ├── inventory/
│   ├── batches/
│   ├── stock-transfers/
│   ├── suppliers/
│   ├── purchases/
│   ├── customers/
│   ├── sales/
│   ├── payments/
│   ├── invoices/
│   ├── cash-management/
│   ├── expenses/
│   ├── reports/
│   ├── subscriptions/
│   ├── notifications/
│   ├── sync/
│   ├── audit/
│   └── health/
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── test/
│   ├── integration/
│   └── e2e/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
└── README.md
```

Each feature module should normally contain a module, controller,
service, DTOs and tests. Keep controllers thin; put business rules in
services/domain logic and isolate persistence behind clear data-access
methods. Avoid creating abstractions that merely duplicate Prisma
without adding value.

------------------------------------------------------------------------

# 4. Implementation phases

The following plan assumes a lean MVP and parallel frontend/backend work
where practical. The durations are estimates, not guarantees. Offline
synchronization, tax validation, hardware integration and production
hardening may extend the schedule.

## Phase 0 -- Requirements, workflows and technical decisions

**Estimated duration:** 3--5 working days\
**Priority:** Critical

### Tasks

-   Confirm initial customer profile: independent supermarkets with 1--3
    branches and 2--5 POS counters.
-   Define user roles: platform admin, business owner, business admin,
    branch manager, inventory manager and cashier.
-   Define tenant, branch, counter and device relationships.
-   Document sale, refund, purchase receipt, stock adjustment and branch
    transfer workflows.
-   Decide whether the first release supports credit sales, split
    payments, weighted products, batches and expiry tracking.
-   Define offline POS operating policy, including offline stock limits
    and payment restrictions.
-   Define invoice numbering and financial-year rules with a GST
    professional.
-   Define API conventions, error format, pagination and date/time
    handling.
-   Agree on the MVP feature boundary and defer AI features.

### Deliverables

-   Approved product requirements and workflow diagrams.
-   Role/permission matrix.
-   Initial ERD and data dictionary.
-   API conventions document.
-   MVP scope and acceptance criteria.
-   Architecture decision records for major choices.

### Exit criteria

The team can explain how a sale, refund, purchase receipt and stock
transfer affect inventory and financial records without ambiguity.

------------------------------------------------------------------------

## Phase 1 -- Backend foundation and developer experience

**Estimated duration:** 1 week\
**Priority:** P0

### Tasks

-   Create the NestJS TypeScript project.
-   Configure formatting, linting and strict TypeScript settings.
-   Configure environment-specific settings and validation.
-   Add Prisma and connect to PostgreSQL.
-   Create initial database migration.
-   Configure global validation pipes and exception handling.
-   Add request correlation IDs.
-   Configure structured logging.
-   Add API version prefix `/api/v1`.
-   Configure Swagger/OpenAPI.
-   Add health and readiness endpoints.
-   Create Dockerfile and local Docker Compose environment.
-   Add `.env.example`; keep secrets out of source control.
-   Set up GitHub Actions for lint, type-check, tests and build.

### Deliverables

-   Running NestJS application.
-   PostgreSQL development environment.
-   Prisma migration workflow.
-   Swagger endpoint.
-   Health endpoint.
-   CI pipeline.
-   Developer setup instructions.

### Exit criteria

A developer can clone the repository, configure environment variables,
start the services, run migrations and execute tests using documented
steps.

------------------------------------------------------------------------

## Phase 2 -- Multi-tenant data foundation

**Estimated duration:** 1 week\
**Priority:** P0

### Core entities

-   `tenants`
-   `users`
-   `memberships`
-   `roles`
-   `permissions`
-   `membership_roles` or equivalent role assignment
-   `stores`
-   `store_memberships` or branch assignments
-   `counters`
-   `terminal_devices`

### Tasks

-   Implement tenant registration and business profile creation.
-   Implement user-to-tenant membership.
-   Support users who may belong to more than one business, if required.
-   Create branches and assign users to branches.
-   Create POS counters and register terminal devices.
-   Add tenant and branch identifiers to tenant-owned records.
-   Add compound unique constraints and indexes.
-   Implement tenant context derived from authenticated membership.
-   Add PostgreSQL Row Level Security as a defense-in-depth control
    where the connection and session model supports it.
-   Ensure application queries also enforce tenant and branch scope.
-   Add cross-tenant isolation tests.

### Deliverables

-   Tenant and branch database model.
-   Business onboarding APIs.
-   Store and counter APIs.
-   Tenant context and authorization foundation.

### Exit criteria

A user from Tenant A cannot read or modify Tenant B data, including
through guessed record IDs or manipulated request parameters.

------------------------------------------------------------------------

## Phase 3 -- Authentication and authorization

**Estimated duration:** 1 week\
**Priority:** P0

### Tasks

-   Implement registration and login.
-   Hash passwords using Argon2id.
-   Implement short-lived access tokens and refresh-token rotation, or a
    secure cookie-backed session design.
-   Implement logout and session revocation.
-   Implement forgot-password and reset-password flows.
-   Add email/mobile verification as required.
-   Implement optional multi-factor authentication as a later
    enhancement.
-   Implement role and permission guards.
-   Implement branch-level authorization.
-   Add login rate limiting and account protection.
-   Record security-sensitive audit events.
-   Never expose secrets or privileged tokens to the frontend.

### Initial roles

  Role                   Typical access
  ---------------------- ---------------------------------------------
  Platform Super Admin   SaaS platform administration
  Business Owner         All authorized business operations
  Business Admin         Configurable business administration
  Branch Manager         Assigned branch operations
  Inventory Manager      Products, stock and purchasing
  Cashier                Assigned counter sales and shift operations

### Deliverables

-   Authentication APIs.
-   Session management.
-   Role and permission model.
-   Branch access enforcement.
-   Authentication and authorization tests.

### Exit criteria

Protected routes reject unauthenticated users, and every role is
restricted to its approved actions and branches.

------------------------------------------------------------------------

## Phase 4 -- Product catalogue, pricing and tax configuration

**Estimated duration:** 1 week\
**Priority:** P0

### Core entities

-   `products`
-   `categories`
-   `brands`
-   `units`
-   `product_barcodes`
-   `product_variants`
-   `tax_rates`
-   `price_lists`
-   `product_prices`

### Tasks

-   Implement product CRUD.
-   Implement SKU and barcode uniqueness within the appropriate tenant
    scope.
-   Support multiple barcodes and pack sizes where required.
-   Support categories, brands and units of measurement.
-   Store HSN and configurable tax classifications.
-   Support MRP, purchase cost and selling price.
-   Support branch-specific pricing if required.
-   Implement product search and barcode lookup.
-   Implement bulk CSV import with validation and error reports.
-   Implement product image upload using object storage.
-   Store price and tax snapshots on sales documents later; never
    recalculate old invoices using current product settings.

### Deliverables

-   Product and category APIs.
-   Barcode lookup API.
-   Pricing and tax configuration APIs.
-   Import/export workflow.
-   Product seed data for supermarket testing.

### Exit criteria

A business owner can create, import, search and update products without
accessing another tenant's catalogue.

------------------------------------------------------------------------

## Phase 5 -- Inventory and stock ledger

**Estimated duration:** 1--2 weeks\
**Priority:** P0

### Core entities

-   `stock_balances`
-   `stock_movements`
-   `stock_adjustments`
-   `product_batches`
-   `stock_counts`
-   `stock_count_items`

### Tasks

-   Design an append-only stock movement ledger.
-   Implement branch-level stock balances.
-   Implement opening stock.
-   Implement stock inward and outward.
-   Implement stock adjustments with reasons and approvals.
-   Implement physical stock counting and reconciliation.
-   Implement reorder levels and low-stock queries.
-   Implement batch and expiry tracking for applicable products.
-   Implement damaged, expired and wastage movements.
-   Implement inventory valuation policy and document it.
-   Update ledger and balance atomically within database transactions.
-   Prevent negative stock according to business policy.
-   Add audit history for adjustments.

### Critical rules

-   Do not directly edit historical stock movements.
-   Correct errors with reversal or compensating movements.
-   Update stock balances in the same transaction as ledger entries.
-   Use decimal quantities to support weighted products.
-   Use appropriate row locking or conditional updates to prevent
    concurrent overselling.
-   Define how stock reservations, returns and in-transit stock are
    represented.

### Deliverables

-   Inventory APIs.
-   Stock ledger.
-   Branch stock views.
-   Low-stock and expiry alerts.
-   Inventory reconciliation tests.

### Exit criteria

Every stock balance can be explained by its opening balance plus
recorded movements, and concurrent stock operations cannot silently
corrupt balances.

------------------------------------------------------------------------

## Phase 6 -- Suppliers and purchase management

**Estimated duration:** 1 week\
**Priority:** P0

### Core entities

-   `suppliers`
-   `supplier_transactions`
-   `purchase_orders`
-   `purchase_order_items`
-   `goods_receipts`
-   `goods_receipt_items`
-   `purchase_returns`
-   `supplier_payments`
-   `purchase_item_batches`

### Tasks

-   Implement supplier CRUD.
-   Create purchase orders.
-   Support supplier-specific purchase prices.
-   Support discounts and tax breakdowns.
-   Support partial goods receipt.
-   Verify ordered, received, damaged and accepted quantities.
-   Capture batch numbers and expiry dates.
-   Update stock ledger and balances on receipt.
-   Record supplier payable transactions.
-   Implement purchase returns and supplier payment recording.
-   Maintain purchase history and supplier outstanding reports.

### Deliverables

-   Supplier APIs.
-   Purchase order APIs.
-   Goods receiving APIs.
-   Purchase return and supplier payment APIs.

### Exit criteria

A purchase receipt updates inventory and supplier balances atomically,
and partial deliveries are represented accurately.

------------------------------------------------------------------------

## Phase 7 -- POS sales, invoices and payments

**Estimated duration:** 1--2 weeks\
**Priority:** P0

### Core entities

-   `sales`
-   `sale_items`
-   `sale_payments`
-   `payment_transactions`
-   `sale_returns`
-   `sale_return_items`
-   `invoices`
-   `invoice_sequences`
-   `cash_sessions`
-   `cash_movements`

### Tasks

-   Implement product lookup and cart validation APIs.
-   Calculate discounts, taxable value and tax on the backend.
-   Support tax-inclusive and tax-exclusive pricing as configured.
-   Support cash, UPI, card and split tender records.
-   Support payment pending, successful, failed and refunded states.
-   Implement sale creation as one database transaction.
-   Deduct stock through the inventory ledger.
-   Generate controlled invoice numbers.
-   Store invoice line price, discount, HSN and tax snapshots.
-   Implement receipt data and PDF/print-ready invoice responses.
-   Implement sale returns and refund workflows.
-   Implement counter opening and closing sessions.
-   Implement cashier-wise cash reconciliation.
-   Add idempotency keys to sale creation.
-   Ensure failed transactions do not leave partial stock or financial
    records.

### Important payment distinction

Record payment status based on verified payment-provider callbacks or
trusted server-side confirmation. A browser success message is not proof
of payment.

For offline cash sales, define a separate payment state and sync policy.
Do not represent an unverified UPI/card payment as settled.

### Deliverables

-   POS APIs.
-   Sales and invoice APIs.
-   Payment records and reconciliation foundation.
-   Returns APIs.
-   Cash session APIs.
-   Transaction and concurrency tests.

### Exit criteria

Repeated requests cannot create duplicate sales, and each successful
sale has consistent invoice, payment and inventory records.

------------------------------------------------------------------------

## Phase 8 -- Frontend integration with Lovable application


**Estimated duration:** 1 week, parallelizable\
**Priority:** P0

### Frontend integration stack

-   Axios or generated OpenAPI client.
-   TanStack Query for server state.
-   React Hook Form for forms.
-   Zod for client-side validation.
-   Zustand only for local UI state where needed.
-   Typed API contracts generated from Swagger.

### Tasks

-   Inspect the existing Lovable project before modifying it.
-   Preserve current design, navigation and components.
-   Configure API base URL per environment.
-   Implement centralized API client and error handling.
-   Integrate authentication and session expiry behavior.
-   Integrate tenant and branch selection.
-   Connect product listing, creation, editing and search.
-   Connect inventory and stock movement screens.
-   Connect suppliers and purchase screens.
-   Connect POS and sales screens.
-   Connect dashboard metrics to real reporting endpoints.
-   Add loading, empty, validation and error states.
-   Remove mock data from production paths.
-   Ensure UI permissions reflect backend permissions without treating
    UI hiding as security.

### Deliverables

-   Working admin dashboard connected to backend.
-   Typed API client.
-   Consistent error and loading behavior.
-   Integration test coverage for critical flows.

### Exit criteria

A user can complete the agreed product, inventory, purchase and sale
workflows from the existing frontend using real backend data.

------------------------------------------------------------------------

## Phase 9 -- Offline POS and synchronization

**Estimated duration:** 1--2 weeks\
**Priority:** P0 for a supermarket production pilot

### Client-side technology

-   IndexedDB.
-   Dexie.js.
-   Service Worker.
-   Unique UUIDs for offline transactions.
-   Persistent sync queue.

### Backend entities

-   `terminal_devices`
-   `terminal_sessions`
-   `sync_events`
-   `offline_sales`
-   `idempotency_records`
-   `outbox_events`

### Tasks

-   Cache authorized product catalogue and pricing versions.
-   Persist offline sales before showing local completion.
-   Generate globally unique transaction IDs.
-   Store terminal and device identity.
-   Implement authenticated batch sync endpoint.
-   Validate and process each transaction idempotently.
-   Return per-transaction results.
-   Implement retry with exponential backoff and jitter.
-   Preserve failed records for manual resolution.
-   Handle browser restart and device restart.
-   Implement conflict and price-change policies.
-   Define offline payment restrictions.
-   Define per-counter offline stock limits or oversell policies.
-   Monitor queue age and failed synchronization.

### Essential rule

Do not promise globally accurate real-time stock while multiple counters
are offline. Offline sales may temporarily oversell shared stock unless
the business reserves stock allocations or accepts a defined
reconciliation policy.

### Deliverables

-   Offline POS data model.
-   Sync APIs.
-   Client sync queue.
-   Conflict handling.
-   Offline and reconnect test scenarios.

### Exit criteria

A sale survives browser restart, is not duplicated on retry, and is
either synchronized or clearly retained as failed/pending for operator
action.

------------------------------------------------------------------------

## Phase 10 -- Reports, finance and SaaS subscriptions

**Estimated duration:** 1--2 weeks\
**Priority:** P1

### Reporting tasks

-   Daily, weekly and monthly sales.
-   Sales by branch and counter.
-   Product and category performance.
-   Gross margin reporting using cost snapshots.
-   Inventory valuation.
-   Stock movement and expiry reports.
-   Purchase and supplier outstanding reports.
-   Cashier performance.
-   Expense summaries.
-   GST summary reports.

Use database indexes and optimized aggregation queries. Introduce
summary tables or scheduled aggregation only when real query performance
requires them.

### Finance tasks

-   Expense categories and entries.
-   Cash opening and closing.
-   Cash movements.
-   Supplier payable records.
-   Customer receivable records if credit sales are enabled.
-   Payment reconciliation.
-   Basic cash and business summaries.

Do not describe basic sales-minus-purchases reporting as a complete
accounting ledger. A proper double-entry accounting module can be a
later product phase.

### Subscription tasks

-   Plans and entitlements.
-   Trial period.
-   Subscription status.
-   Renewal and cancellation.
-   Branch, user and counter limits.
-   Payment provider integration.
-   Verified webhook processing.
-   Subscription invoice history.
-   Grace period and suspension policy.

### Deliverables

-   Reporting APIs.
-   Finance summary APIs.
-   Subscription and entitlement APIs.
-   Payment webhook handling.

### Exit criteria

Dashboard numbers reconcile with underlying business transactions, and
subscription entitlements are enforced by the backend.

------------------------------------------------------------------------

## Phase 11 -- Notifications, audit and background processing

**Estimated duration:** 3--5 working days\
**Priority:** P1

### Tasks

-   Implement audit logs for sensitive actions.
-   Implement low-stock notifications.
-   Implement expiry notifications.
-   Implement purchase approval notifications.
-   Implement subscription renewal reminders.
-   Implement email notifications.
-   Add WhatsApp provider integration only after consent, templates and
    provider configuration are ready.
-   Introduce Redis and BullMQ if asynchronous workload justifies them.
-   Implement retry, dead-letter/manual recovery handling and job
    monitoring.
-   Implement a transactional outbox for reliable event publication
    where needed.

### Deliverables

-   Audit APIs and views.
-   Notification preferences.
-   Background job workers.
-   Failed-job monitoring and recovery procedure.

### Exit criteria

Critical events are traceable, and a failed notification job does not
lose the underlying business transaction.

------------------------------------------------------------------------

## Phase 12 -- Security, performance and production readiness

**Estimated duration:** 1--2 weeks\
**Priority:** Critical before public launch

### Security

-   Review tenant and branch isolation.
-   Review every authorization guard.
-   Test object-level access using guessed IDs.
-   Validate all DTOs and uploaded files.
-   Configure CORS and security headers.
-   Configure API rate limiting.
-   Verify password and token handling.
-   Verify webhook signatures and replay protection.
-   Ensure secrets are stored in a secret manager or protected
    environment configuration.
-   Avoid sensitive data in logs.
-   Review dependency vulnerabilities.

### Reliability

-   Configure automated database backups.
-   Test point-in-time recovery if supported.
-   Perform a full restore drill.
-   Configure health and readiness probes.
-   Configure application monitoring.
-   Configure database connection limits.
-   Test graceful shutdown and deployment.
-   Define incident and rollback procedures.

### Performance

-   Add indexes based on real query patterns.
-   Use pagination for large tables.
-   Avoid N+1 queries.
-   Load-test concurrent checkout and stock updates.
-   Test multiple POS terminals.
-   Monitor database locks and slow queries.
-   Add caching only where measured benefit exists.

### Essential test scenarios

-   Tenant A cannot access Tenant B data.
-   Cashier cannot access owner-only reports.
-   Two counters attempt to sell the same remaining stock.
-   Duplicate sale request is submitted.
-   Payment webhook is delivered more than once.
-   Purchase is partially received.
-   Sale is returned after price or tax configuration changes.
-   Offline sale is retried after a timeout.
-   Browser restarts with pending offline sales.
-   Database restore is performed from backup.

### Deliverables

-   Security review.
-   Load and concurrency test results.
-   Backup and restore evidence.
-   Production runbook.
-   Release checklist.

### Exit criteria

Critical business workflows pass tests, tenant isolation is verified,
recovery procedures work and known production risks have owners and
mitigations.

------------------------------------------------------------------------

## 5. Suggested delivery schedule

A realistic lean MVP schedule is approximately 12--16 weeks, depending
on team size, founder involvement, hardware testing and how much
frontend work already exists.

  Phase   Workstream                               Estimate
  ------- ------------------------------------ ------------
  0       Requirements and architecture           3--5 days
  1       Backend foundation                         1 week
  2       Tenant and business foundation             1 week
  3       Authentication and authorization           1 week
  4       Products, pricing and tax                  1 week
  5       Inventory and stock ledger             1--2 weeks
  6       Suppliers and purchases                    1 week
  7       POS, invoices and payments             1--2 weeks
  8       Lovable frontend integration               1 week
  9       Offline POS synchronization            1--2 weeks
  10      Reports, finance and subscriptions     1--2 weeks
  11      Notifications and audit                 3--5 days
  12      Production hardening                   1--2 weeks

Some phases can run in parallel, but the data model, tenant security and
transactional inventory foundations should be completed before dependent
workflows are built.

------------------------------------------------------------------------

## 6. MVP scope versus later releases

### MVP -- required for first supermarket pilot

-   Tenant and branch management.
-   Authentication and role permissions.
-   Product catalogue and barcode lookup.
-   Pricing and tax configuration.
-   Inventory ledger and balances.
-   Suppliers and purchase orders.
-   Goods receiving.
-   POS sales and invoices.
-   Cash and payment records.
-   Basic sales and inventory reports.
-   Audit logs.
-   Lovable frontend integration.
-   Offline POS synchronization for the pilot's supported workflows.
-   Backups, monitoring and recovery tests.

### Release 2

-   Customer loyalty.
-   Advanced customer credit.
-   Advanced finance and accounting.
-   More comprehensive multi-branch procurement.
-   WhatsApp notifications.
-   Advanced subscription automation.
-   Advanced analytics.
-   AI business assistant.

### Release 3

-   Supplier portal.
-   E-commerce integration.
-   Franchise management.
-   Advanced demand forecasting.
-   Enterprise integrations.
-   Advanced accounting and business intelligence.

------------------------------------------------------------------------

## 7. Initial database domain checklist

Use this as the starting schema inventory. Final fields, indexes,
foreign keys, unique constraints and deletion policies must be defined
in the ERD and Prisma schema.

  -----------------------------------------------------------------------
  Domain                              Tables
  ----------------------------------- -----------------------------------
  SaaS                                tenants, plans, subscriptions,
                                      subscription_invoices,
                                      subscription_events

  Identity                            users, memberships, roles,
                                      permissions, role_permissions,
                                      membership_roles, sessions

  Stores                              stores, store_memberships,
                                      counters, terminal_devices

  Catalogue                           products, categories, brands,
                                      units, product_barcodes,
                                      product_variants

  Pricing and tax                     price_lists, product_prices,
                                      tax_rates

  Inventory                           stock_balances, stock_movements,
                                      stock_adjustments, product_batches,
                                      stock_counts, stock_count_items

  Purchasing                          suppliers, purchase_orders,
                                      purchase_order_items,
                                      goods_receipts,
                                      goods_receipt_items,
                                      purchase_returns, supplier_payments

  POS                                 sales, sale_items, sale_payments,
                                      payment_transactions, sale_returns,
                                      sale_return_items, invoices,
                                      invoice_sequences

  Customers                           customers, loyalty_accounts,
                                      loyalty_transactions

  Cash and finance                    cash_sessions, cash_movements,
                                      expenses, expense_categories

  Transfers                           stock_transfers,
                                      stock_transfer_items

  Synchronization                     sync_events, offline_sales,
                                      idempotency_records, outbox_events

  Platform                            audit_logs, notifications,
                                      notification_preferences,
                                      webhook_events
  -----------------------------------------------------------------------

### Data design rules

-   Use UUID primary keys for business entities.
-   Use `NUMERIC`/Prisma `Decimal` for money and fractional quantities;
    never use floating-point for financial values.
-   Use UTC timestamps and store the business/store timezone explicitly.
-   Store invoice and sale snapshots so historical documents do not
    change when product settings change.
-   Use compound unique constraints such as `(tenant_id, sku)` and
    appropriate indexes.
-   Use explicit status enums or constrained values with documented
    state transitions.
-   Avoid hard deletes for financial and inventory history.
-   Define retention, archival and export policies.
-   Ensure every tenant-owned record is scoped by tenant; branch-owned
    records also carry store scope.

------------------------------------------------------------------------

## 8. API conventions

Base URL:

``` text
https://api.billing.in/api/v1
```

### Example endpoints

  Module          Method   Endpoint
  --------------- -------- ---------------------------
  Auth            POST     `/auth/login`
  Auth            POST     `/auth/refresh`
  Auth            GET      `/auth/me`
  Tenants         POST     `/tenants`
  Stores          GET      `/stores`
  Products        GET      `/products`
  Products        POST     `/products`
  Products        GET      `/products/barcode/:code`
  Inventory       GET      `/inventory/stock`
  Inventory       POST     `/inventory/adjustments`
  Purchases       POST     `/purchases`
  Receiving       POST     `/goods-receipts`
  Sales           POST     `/sales`
  Sales           GET      `/sales/:id`
  Returns         POST     `/sales/:id/returns`
  Sync            POST     `/sync/sales`
  Reports         GET      `/reports/dashboard`
  Subscriptions   GET      `/subscriptions/current`

### API standards

-   Use consistent response and error formats.
-   Use pagination for collections.
-   Validate all inputs on the server.
-   Use idempotency keys for non-repeatable operations.
-   Use request correlation IDs.
-   Document status codes and state transitions.
-   Do not expose internal database errors to clients.
-   Generate TypeScript clients from the OpenAPI contract.

------------------------------------------------------------------------

## 9. Environment and deployment checklist

### Environments

Maintain separate development, staging and production environments.

Example `.env.example`:

``` env
NODE_ENV=development
PORT=3000
API_PREFIX=api/v1

DATABASE_URL=
DIRECT_URL=

JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=

REDIS_URL=

OBJECT_STORAGE_ENDPOINT=
OBJECT_STORAGE_BUCKET=
OBJECT_STORAGE_ACCESS_KEY=
OBJECT_STORAGE_SECRET_KEY=

FRONTEND_URL=
CORS_ORIGINS=

SENTRY_DSN=
```

Use a secret manager or protected environment variables in hosted
environments. Do not commit real credentials.

### Deployment checklist

-   [ ] Production PostgreSQL provisioned.
-   [ ] Database migrations tested in staging.
-   [ ] Database backup policy configured.
-   [ ] Restore procedure tested.
-   [ ] NestJS API deployed.
-   [ ] Frontend deployed and configured with API URL.
-   [ ] HTTPS and CORS configured.
-   [ ] Secrets configured securely.
-   [ ] Health checks enabled.
-   [ ] Logs and error monitoring enabled.
-   [ ] Rate limiting enabled.
-   [ ] API documentation access controlled as appropriate.
-   [ ] Payment webhooks configured and verified.
-   [ ] Rollback process documented.

------------------------------------------------------------------------

## 10. Acceptance criteria for the first pilot

A supermarket pilot is ready only when the following end-to-end
scenarios work:

1.  Business owner registers a tenant and creates a branch.
2.  Owner creates users and assigns roles and branch permissions.
3.  Inventory manager imports products and barcodes.
4.  Manager records opening stock.
5.  Purchase order is created and goods are received.
6.  Cashier opens a counter session.
7.  Cashier scans products and completes a sale.
8.  Backend creates one invoice and records payment and stock movements
    atomically.
9.  Owner sees the sale in dashboard reports.
10. A return is processed with the correct stock and payment treatment.
11. A second tenant cannot access any of the first tenant's records.
12. A supported offline sale survives browser restart and synchronizes
    without duplication.
13. Backups can be restored and verified.

### Pilot launch decision

Do not launch publicly just because the UI and APIs work. Complete the
above scenarios with actual barcode scanners, receipt printers, multiple
counters and realistic supermarket data.

------------------------------------------------------------------------

## 11. Immediate next actions

Start in this exact order:

1.  Freeze the MVP workflows and role/permission matrix.
2.  Create the NestJS repository and Docker development environment.
3.  Design the tenant, membership, store and counter schema.
4.  Implement authentication and tenant isolation tests.
5.  Build product catalogue and barcode APIs.
6.  Build stock ledger and transactional inventory operations.
7.  Build purchase receiving.
8.  Build POS sale and invoice transaction.
9.  Connect the existing Lovable screens using the OpenAPI contract.
10. Add offline synchronization and complete pilot testing.

**Final recommendation:** billing should begin as a NestJS modular
monolith backed by PostgreSQL and Prisma. Keep all financial, tax,
payment and inventory decisions on the backend. Treat offline POS
synchronization, tenant isolation, idempotency and auditability as core
architecture---not features to bolt on after launch.
