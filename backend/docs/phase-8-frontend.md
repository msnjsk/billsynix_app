# Phase 8 — Frontend integration

**Exit criterion:** *A user can complete the agreed product, inventory, purchase and sale workflows
from the existing frontend using real backend data.* Met for those four workflows. Evidence is in
`src/lib/live/workflows.live.test.ts` (frontend repo root, 8 tests, `npm run test:live` against a
running API). It drives the same functions the screens call, then checks what the screens' stores
show:

* sign in;
* add and edit a product with opening stock;
* write off damaged stock;
* add a supplier;
* raise and send a PO;
* receive it with a damaged line returned;
* pay the supplier;
* sell at the POS, with a server-numbered invoice and change;
* return part of the sale (credit note);
* catch a price the POS showed that the server no longer agrees with;
* see today's figures on the dashboard and sales screen;
* refund a bill;
* sign out.

The whole frontend also builds for production in connected mode (`next build`, 17 pages).

## Switching it on

```env
# .env.local (frontend root)
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
```

* **Set:** the app is *connected*. Sign-in, the business, branches, catalogue, stock, purchases,
  POS sales and reports come from the API. No business data is written to browser storage.
* **Unset:** the app runs exactly as before, on this computer's own data (first-run setup or demo
  mode). Nothing changed for that path.

`npm run api:types` regenerates the typed contract (`src/lib/api/schema.d.ts`) from the API's
OpenAPI document.

## How it fits the existing UI

The screens already read small stores (business profile, branches and stock, catalogue,
purchases, POS register, dashboard figures). Connected mode keeps every screen, layout and
component as it was:

* **Load (`src/lib/live/hydrate.ts`, `dashboard.ts`):** after sign-in the API data is loaded into
  those same stores. Pages render once it has loaded, with the existing spinner, and show a
  retry card if loading fails. Changing branch reloads.
* **Write through (`src/lib/live/actions.ts`):** each save calls the API and then reloads. Every
  screen shows the server's result, and every business rule is the backend's.
* **API client (`src/lib/api/client.ts`):**
  * the access token is kept in memory only;
  * the refresh token is the API's httpOnly cookie;
  * a 401 triggers one refresh, shared by concurrent calls, and the request is retried;
  * when the session ends, the user is signed out;
  * errors become an `ApiError` carrying the API's `code`, `message`, field details and
    `requestId`.
* **Session (`src/lib/live/session.ts`):** `/auth/me` is mapped to the UI's `Session`.
  * Roles: owner/business admin → owner; branch/inventory manager → manager; cashier → cashier.
  * `can(permission)` mirrors the API's permissions so the UI doesn't offer what will be refused.
    The API still checks every request; hiding a button is never the security boundary.
  * A person in several businesses picks one at sign-in.
  * Reopening the app continues the session from the cookie.

## Connected screens

| Screen | Reads | Writes |
| --- | --- | --- |
| Login | — | email + password sign-in, business choice, sign-out ends the server session |
| Products | catalogue (branch price), 14-day units and trend, last supplier | add (with GST rate and opening stock), edit (price, cost, category, stock correction), archive |
| Inventory | branch stock, recent movements | stock in/out with a reason (adjustment; above the limit it waits for approval) |
| Suppliers | suppliers, balances, payments | add supplier, record payment (settles oldest bills first) |
| Purchases | POs, goods receipts (also shown as bills), debit notes, payments | create/edit/send/cancel PO, receive goods (stock + payable), return damaged goods, debit note, payment |
| POS | catalogue with branch prices and stock | sale (server prices, numbers and records it; the cashier's drawer is opened with the first sale), return against a bill made on this counter |
| Sales | today's bills, per-counter totals, 7D/14D/8W/6M series, hourly pattern | refund a whole bill |
| Dashboard | today's revenue, bills, profit, average bill, payment split, low stock, stock value, category share, expiring batches, activity, branch comparison | — |

`GET /reports/sales-summary` was added to the backend for these figures: per day, per payment
method, per product and per hour, net of returns. Profit is shown only with `reports:finance`.

## Differences from the local app, by design

* **Sign-in is by email.** The cashier PIN tab appears only on a computer registered as a counter
  (Phase 9, `docs/phase-9-offline.md`).
* **No separate bill entry.** A goods receipt carries the supplier's invoice (Phase 6), so
  "Enter bill" explains that the bill is already recorded. Debit notes are settled when they're
  posted.
* **New products default to PCS** and take their GST rate from a new field on the form (live mode
  only). The supplier field is optional there.
* **Stock-in reasons** "Purchase" and "Customer return" post as `FOUND` adjustments. Real
  purchases should come in through a goods receipt.

## Not connected yet

* **Branches screen** (adding and editing branches, counters, branch prices, transfers),
  **Customers**, **Orders**, **Business profile edit**, **Assistant**: they still show the
  loaded data, but their own edits stay local.
* **First-run setup:** with a backend, a business is created through `POST /tenants`; the setup
  wizard doesn't call it yet.
* **At the POS:**
  * no manager-PIN prompt yet for discounts above 10% or refunds above ₹2,000; these get the
    API's "needs a manager's approval" message;
  * returns are possible only for bills made in the current browser session;
  * the opening float is asked with a simple prompt;
  * near-expiry batch markdowns aren't loaded from the stock ledger yet.
* **Lint:** `npm run lint` fails before running (`@rushstack/eslint-patch` doesn't load). This was
  already the case before this phase.
* **Windows:** run `npm run test:live` from PowerShell, cmd or the VS Code terminal. A shell that
  reports the drive in lower case (Git Bash) makes Vitest load itself twice.
