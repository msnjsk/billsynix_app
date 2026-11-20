# Phase 0 — Roles and permission matrix

Permissions are strings `resource:action`. Roles are bundles of permissions seeded per tenant
(Business Admin bundles can be edited by the owner later). **Scope** says where a membership's
permissions apply:

* **Tenant** — every branch of the business.
* **Assigned branches** — only branches listed in `store_memberships`.
* **Assigned counter** — only the counter the cashier's session is opened on.

| Permission | Super Admin | Owner | Business Admin | Branch Manager | Inventory Mgr | Cashier |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| `platform:manage` (tenants, plans) | ✔ | | | | | |
| `tenant:read` / `tenant:update` (business profile) | | ✔ / ✔ | ✔ / ✔ | ✔ / – | ✔ / – | ✔ / – |
| `subscription:manage` | | ✔ | | | | |
| `users:manage` (invite, roles, branch access) | | ✔ | ✔ | own branch, cashiers only | | |
| `stores:manage` (create/edit/close branch) | | ✔ | ✔ | | | |
| `counters:manage` / `devices:register` | | ✔ | ✔ | ✔ | | |
| `products:read` | | ✔ | ✔ | ✔ | ✔ | ✔ |
| `products:write` (catalogue, barcodes, tax) | | ✔ | ✔ | | ✔ | |
| `prices:write` (branch prices) | | ✔ | ✔ | ✔ | | |
| `inventory:read` | | ✔ | ✔ | ✔ | ✔ | own counter's store, quantity only |
| `inventory:adjust` (adjustments, counts) | | ✔ | ✔ | ✔ (approval > ₹5k) | ✔ (approval > ₹5k) | |
| `inventory:approve` | | ✔ | ✔ | ✔ | | |
| `transfers:request` / `transfers:dispatch` / `transfers:receive` | | ✔ | ✔ | ✔ | ✔ | |
| `suppliers:manage` | | ✔ | ✔ | | ✔ | |
| `purchases:write` (PO, GRN, returns) | | ✔ | ✔ | ✔ | ✔ | |
| `purchases:approve` (PO above limit) | | ✔ | ✔ | ✔ | | |
| `supplier-payments:write` | | ✔ | ✔ | | | |
| `sales:create` | | ✔ | ✔ | ✔ | | ✔ |
| `sales:read` | | ✔ | ✔ | ✔ | | own sales today |
| `sales:return` | | ✔ | ✔ | ✔ | | ✔ (≤ ₹2k, else manager PIN) |
| `sales:void` / `discount:override` (> 10 %) | | ✔ | ✔ | ✔ | | |
| `cash:session` (open/close own drawer) | | ✔ | ✔ | ✔ | | ✔ |
| `cash:reconcile` | | ✔ | ✔ | ✔ | | |
| `customers:read` / `customers:write` | | ✔ / ✔ | ✔ / ✔ | ✔ / ✔ | | ✔ / create only |
| `reports:sales` | | ✔ | ✔ | own branches | | |
| `reports:finance` (margin, GST, payables) | | ✔ | ✔ | | | |
| `expenses:write` | | ✔ | ✔ | ✔ | | |
| `audit:read` | | ✔ | ✔ | | | |

## Rules

1. Scope is checked on the **resource's** `storeId`, never on a store id sent by the client alone.
2. A user can hold different roles in different tenants (memberships are per tenant).
3. Cashier PIN sign-in is only allowed on a registered device bound to a counter of an
   assigned branch.
4. Approval thresholds (₹5k adjustments, ₹2k returns, 10 % discount) are tenant settings.
5. Hiding UI is not security: every check above is enforced by API guards (Phase 3) and tested.
