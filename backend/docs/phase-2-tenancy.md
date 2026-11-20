# Phase 2 — Multi-tenant data foundation

**Exit criterion:** *A user from Tenant A cannot read or modify Tenant B data, including through
guessed record IDs or manipulated request parameters.* — met; evidence in `test/tenancy.e2e-spec.ts`.

## What exists

| Area | Endpoints |
| --- | --- |
| Onboarding | `POST /tenants` (public) — business + owner + system roles + HQ branch + Counter 1, returns an access token |
| Business profile | `GET/PATCH /tenants/current` |
| Branches | `GET/POST /stores`, `GET/PATCH /stores/:id`, `POST /stores/:id/close` |
| Counters | `GET/POST /stores/:id/counters`, `PATCH /counters/:id` |
| Devices | `POST /counters/:id/devices` (key shown once), `GET /stores/:id/devices`, `POST /devices/:id/revoke` |
| Staff | `GET/POST /memberships`, `GET/PATCH /memberships/:id`, `GET /roles` |

## How isolation is enforced (three independent locks)

1. **Tenant comes only from the token, re-checked live.** The access token carries
   `sub` (user), `tid` (business), `mid` (membership). On every request the guard loads that
   membership and requires all three to match an *active* user, membership and business. A token
   claiming another business, or a disabled member, gets 401 on the next request. Clients never
   send a tenant id.
2. **Every query is scoped in code.** Lookups use `{ id, tenantId }` and branch access; anything of
   another business — or a branch the caller isn't assigned to — answers **404**, never 403, so ids
   can't be probed.
3. **The database refuses on its own.**
   * *Row-level security* on `roles`, `membership_roles`, `stores`, `store_memberships`,
     `counters`, `terminal_devices`: rows are only visible inside `PrismaService.withTenant()`,
     which sets `app.tenant_id` for the transaction. Writes for another tenant fail the policy.
   * The API connects as **`billing_app`** (not superuser, `NOBYPASSRLS`); migrations run as the
     owner via `DIRECT_URL`. Superusers bypass RLS, so this split is what makes it effective.
   * *Composite foreign keys* `(tenant_id, x_id) → (tenant_id, id)` make it impossible to link a
     counter, device, role assignment or branch assignment to another business's rows.

## Authorization model

* Roles and permissions from `docs/phase-0/02-roles-permissions.md` live in
  `src/access/permissions.ts`; system roles are created per business at registration.
* Tenant-wide roles (Owner, Business Admin) see every branch; others see only assigned branches.
* `@RequirePermissions()` on routes; services re-check permission + branch scope.
* Staff rules: only owners create/modify owners; branch managers manage only cashiers in their own
  branches; nobody changes their own roles/status; the last active owner can't be removed.
* One person, many businesses: adding an existing email links the existing account and never
  touches its password.

## Deliberately left for Phase 3

Login, refresh-token rotation, logout/session revocation, password reset, PIN sign-in on a
registered device, login rate limiting. Until then, tests mint access tokens for staff with
`TokenService`.

## Operating notes

* New environments: run `docker/initdb/app-role.psql` as the owner against each database
  (`-v app_password=…`), then point `DATABASE_URL` at `billing_app` and `DIRECT_URL` at the owner.
* Any new branch-owned table must: carry `tenant_id`, use composite FKs, get the
  `tenant_isolation` policy in its migration, and be accessed through `withTenant()`.
