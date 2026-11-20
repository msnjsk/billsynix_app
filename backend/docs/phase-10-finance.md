# Phase 10 — Reports, finance and SaaS subscriptions

**Exit criterion:** *Dashboard numbers reconcile with underlying business transactions, and
subscription entitlements are enforced by the backend.* Met. Evidence is in
`test/finance.e2e-spec.ts` (21 tests) and `src/subscriptions/subscription-policy.spec.ts`.

The test bills a mixed day:

* three GST rates;
* a discount;
* an inter-state B2B buyer;
* UPI waiting for verification;
* a credit sale;
* a damaged return;
* a void;
* expenses.

Then it checks every report against sums taken straight from the database.

* **Net sales agree everywhere:** `/reports/sales`, its periods, the dashboard's
  `/reports/sales-summary`, branches and counters, and products and categories (through their
  round-off reconciliation).
* **Gross profit:** the dashboard, the sales report, the product report and the business summary
  agree.
* **GST:** net taxable value by rate adds up to net taxable sales, and output tax equals the sales
  tax.
* **Stock valuation** equals Σ qty × average cost. Movements and shrinkage match the ledger.
* **Money reports:** tenders, credit, customer receipts and expenses match what was recorded.

On the subscription side, the tests cover:

* a trial;
* a verified webhook that activates a plan, once;
* a bad signature refused, a wrong amount not activating;
* renewal extending the period;
* branch, counter and user limits;
* a downgrade refused;
* grace, lapse to read-only, and paying again;
* cancel and resume.

## One definition of the money

| Figure | Definition |
| --- | --- |
| Net sales | Σ payable of completed sales by business date − Σ refunds of returns by **the return's** business date |
| Taxable / tax | same, from the stored snapshots (never today's rates) |
| Cost of goods | Σ qty × the cost each line left stock at, less the same for returned units |
| Gross profit | net taxable value − cost of goods |
| Product / category revenue | the lines' value before rupee round-off. These reports return `reconciliation`: lines + sales round-off − refund rounding = net sales, with `matches: true` |

* **Voided sales** are excluded everywhere (they are reported as voids, per cashier).
* **Aggregation** runs on the transaction tables with their (tenant, branch, date) indexes. Summary
  tables wait until real volumes need them (plan §Phase 10).

## Reports (`GET /reports/…`, all with `from`, `to`, optional `storeId`)

| Report | Permission | What |
| --- | --- | --- |
| `sales?groupBy=day\|week\|month` | `reports:sales` | bills, gross, discounts, returns, net, taxable, tax, average bill; cost, profit and margin with `reports:finance` |
| `sales-by-location` | `reports:sales` | per branch and counter (returns where they were taken) |
| `products?categoryId=` | `reports:sales` | units, returned units, revenue, share; cost, profit, margin for finance |
| `categories` | `reports:sales` | top-level departments (sub-categories roll up), uncategorised together |
| `inventory-valuation` | `reports:finance` | on hand at average cost, at today's branch selling price, at MRP; per branch and department; negative-stock lines |
| `stock-movements` | `inventory:read` | in/out quantity and value by movement type and reason; shrinkage (write-offs + transfer losses) at cost |
| `expiry?days=30` | `inventory:read` | batches expired / within 7 / within 30 days, at cost and MRP |
| `purchases` | `reports:finance` | per supplier: bought, returned, paid, refunded in the period; owed now |
| `payables` (Phase 6) | | what we owe, with ageing |
| `receivables` | `customers:read` | what customers owe, ageing from the oldest unpaid credit |
| `cashier-performance` | `cash:reconcile` | bills, value, average, lines per bill, discounts (and how many needed approval), voids, returns, drawer variance and shortage |
| `cashiers?date=` (Phase 7) | | one day's drawer view |
| `expenses` | `reports:finance` or `expenses:write` | by category, payment mode, month, branch |
| `gst` | `reports:finance` | see below |
| `payment-reconciliation` | `cash:reconcile` | each tender (cash, UPI, card, credit): recorded, settled, waiting for verification, failed, refunded; oldest unverified; refunds by method and status; customer receipts; drawers closed (expected, counted, variance), awaiting review, open now |
| `business-summary` | `reports:finance` | see below |

At most 400 days per request.

### GST summary ⚖

* **Outward supplies by rate:**
  * invoiced;
  * credit notes, split CGST/SGST/IGST/cess the way the returns were;
  * net.
* **Other outward views:**
  * B2B vs B2C, with the list of B2B invoices (GSTIN, place of supply);
  * HSN summary (HSN, unit, rate, quantity, taxable, tax);
  * bills of supply.
* **Inward:** goods received with GST, less debit notes.
* **Indicative net:** output tax − input tax.

It is a working summary for the GST professional, not a return: it doesn't decide whether input
tax is eligible. Expenses' GST is recorded but not counted as input tax here.

### Business summary

Covers the period's sales, cost of goods, gross profit and margin, then:

* expenses, net of their GST for a GST-registered business, which claims it back;
* **operating result** = gross profit − expenses;
* purchases, returns to suppliers and supplier payments;
* credit given and collected;
* cash in and out of the drawers;
* now: stock at cost, receivable, payable.

It says plainly that it is a management summary from the operational records, **not an accounting
ledger**: no double entry, depreciation or accruals. That is a later product phase (plan §Phase 10).

## Finance

### Customers and credit (khata), docs/phase-0 §3

* **Customers:** `/customers` CRUD.
  * Phone is unique per business.
  * Each has a credit limit (0 = no credit) and an optional opening balance.
* **Credit sale:** `POST /sales` with `customerId` and a `CREDIT` tender (any mix with cash, UPI,
  card).
  * The customer row is locked and *balance + credit ≤ limit* is checked (`CREDIT_LIMIT`).
  * The sale's payment status becomes `CREDIT`.
  * The buyer on the invoice defaults to the customer.
* **Returns:** `refundMethod: CREDIT` puts the refund back on the account. **Voids** take the credit
  off it.
* **Receipts:** `POST /customers/:id/receipts` (`Idempotency-Key`), cash, UPI or card, numbered
  `RCPT-00001`. Cash taken by someone with an open drawer is a pay-in of that drawer, so closing
  still adds up.
* **Ledger:** `customer_transactions` is append-only (trigger), like the supplier ledger.
  `GET /customers/:id/ledger` is the statement.
* **Offline:** credit isn't allowed in offline bills (the limit can't be checked); sync refuses it.

### Expenses

* **Categories:** `/expense-categories`. Ten defaults (rent, electricity, salaries…) are created on
  first use; names are unique ignoring case.
* **Recording:** `POST /expenses` (`Idempotency-Key`), numbered `EXP-00001`, with GST shown on the
  bill.
  * `fromDrawer: true` pays cash out of your open drawer as a PAY_OUT, refused if the drawer hasn't
    that much.
  * Future dates are refused.
* **Voiding:** `POST /expenses/:id/void` reverses the drawer pay-out (while the drawer is open).
  Nothing is deleted.

### Already in place (earlier phases)

* Cash opening, closing and movements (Phase 7).
* Supplier payables (Phase 6).
* UPI/card verification (Phase 7).

`payment-reconciliation` brings these together.

## Subscriptions

### Plans (`GET /plans`, public)

Prices exclude 18% GST and are placeholders for the owner to set.

| | Starter | Growth | Business |
| --- | --- | --- | --- |
| ₹ / month | 499 | 1,299 | 2,999 |
| ₹ / year | 4,990 | 12,990 | 29,990 |
| Branches | 1 | 3 | 10 |
| Counters | 2 | 10 | 50 |
| Active staff | 5 | 20 | 100 |

### Life of a subscription

* **Trial:** every new business gets a **14-day trial of Business**. Existing businesses got one
  from the migration.
* **Status:** `GET /subscription` shows the plan, what applies now, usage against the limits, and
  dates.
* **What applies now** is derived on every request from the stored state and the dates, so no
  scheduler is needed:

| Now | When | Effect |
| --- | --- | --- |
| `TRIALING` / `ACTIVE` | before the trial/period ends | normal |
| `PAST_DUE` | up to **7 days** after it ended unpaid | normal (grace) |
| `EXPIRED` | after grace | **read-only** |
| `CANCELLED` | the owner chose not to renew and the period ended | read-only |
| `SUSPENDED` | set by the platform | read-only |

* **Read-only** means writes answer `402 SUBSCRIPTION_INACTIVE`. Reading and exporting still work.
  So do the routes marked `@AllowWhenReadOnly`:
  * signing in and out, and passwords;
  * paying (`/subscription/*`);
  * synchronising bills a counter already made offline (no data is lost);
  * closing a drawer;
  * opening another business.
* **Limits:** branches, counters and active staff are checked when one is added or re-activated
  (`403 PLAN_LIMIT_REACHED`, with the limit). The subscription row is locked, so two concurrent
  additions can't both slip in.

### Paying

* **Checkout:** `POST /subscription/checkout {plan, interval}` (`subscription:manage`, owner).
  * It refuses a plan smaller than what's in use (`409 PLAN_TOO_SMALL`, listing what's over).
  * It voids an unfinished checkout.
  * It creates an invoice: price + 18% GST, numbered platform-wide `SUB/2627/000042`.
  * It creates a payment-provider order and returns what the browser's payment widget needs.
* **The subscription changes only from a verified provider webhook** (`POST
  /webhooks/payments/:provider`), never from the browser:
  * **Signature:** HMAC-SHA256 of the exact raw body with the webhook secret. Bad signature →
    recorded and 401.
  * **Once per event:** each provider event id is processed once (`payment_webhook_events`); a
    redelivery returns `duplicate: true`. If processing failed, the redelivery processes it again.
  * **Exact amount:** the paid amount must equal the invoice total; otherwise it is recorded and
    audited but doesn't activate.
  * **Paid** → the invoice is `PAID` with its period:
    * renewing the same plan extends from the end of the paid period;
    * another plan switches at once, and the unused days of the old one carry over, valued at the
      new plan's price;
    * a lapsed business starts a fresh period.
  * **Failed** → the invoice is `FAILED` with the reason. Access follows the dates (grace).
* **Cancel / resume:** `POST /subscription/cancel` = don't renew (works until the period ends);
  `/resume` undoes it before then.
* **History:** `GET /subscription/invoices`.

### Gateway

* **Configuration:** `PAYMENT_PROVIDER=none|razorpay` plus `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`
  and `RAZORPAY_WEBHOOK_SECRET` (see `.env.example`).
* **With `none`:** checkout answers `503 PAYMENTS_NOT_CONFIGURED`.
* **The Razorpay adapter:**
  * creates orders through the Orders API;
  * verifies `X-Razorpay-Signature`;
  * handles `payment.captured`, `order.paid` (both may arrive for one payment; the second is a
    no-op) and `payment.failed`.
* ⚖ **The gateway choice is still open** (Phase 0 question 3). Another one implements the same
  `PaymentGateway` interface. The tests use the real signature check with a test secret; only order
  creation is stubbed.

## Data model (migration `finance_subscriptions`)

| Table | |
| --- | --- |
| `customers`, `customer_transactions` (append-only), `customer_receipts` | credit accounts |
| `expense_categories`, `expenses` | expenses (linked to the drawer pay-out) |
| `plans` | platform-wide, seeded |
| `subscriptions` (one per business), `subscription_invoices`, `payment_webhook_events` | SaaS billing |
| `sales` + | `customer_id`; tender method and payment status `CREDIT` |

* **Row-level security** on every tenant table. `plans` and `payment_webhook_events` are
  platform-wide.
* **Constraints:** amounts are checked.
* **Invoice numbers:** a sequence numbers subscription invoices.

## Customer orders (delivery / pickup)

`/customer-orders` (`sales:read` to see, `sales:create` to take and move orders), numbered
`ORD-00001`:

* **Taking an order:** a phone, WhatsApp or in-store order for delivery or pickup, with a slot,
  lines from the catalogue and a payment: cash on delivery, prepaid UPI, or khata (saved customers
  only).
* **Stages:** received → packing → ready → dispatched (with a rider; delivery only) → completed
  (cash on delivery: how it was collected), or cancelled with a reason.
  * Each step is checked against the current stage under a row lock.
  * The timeline is kept on the order.
* **Board:** `GET /customer-orders` lists the branch's open orders and the day's closed ones;
  `?customerId=` lists one customer's orders.
* **Billing:** an order is the agreement with the customer. It is billed at the POS: *Bill at
  POS* on the order opens `/pos?order=<id>` with its items and customer on the bill.
  * The sale carries `customerOrderId`, so billing it is the normal sale: stock out, invoice,
    payment.
  * The order is then marked paid, with the bill's invoice number (`sale` on the order) and a
    "Billed …" line in its timeline.
  * An order is billed once (`409 ORDER_ALREADY_BILLED`), only at its own branch, and only while
    open.
  * A billed order can't be cancelled until its bill is voided or returned (`409 ORDER_BILLED`);
    voiding the bill makes the order billable again.
  * The delivery fee is billed only if the catalogue has a product named "Delivery charge"
    (otherwise the POS says it's not on the bill).
  * Billing an order needs a connection: an offline counter refuses it.

The Customers and Orders screens use these APIs in connected mode (`src/lib/live/customers.ts`).
`GET /customers` also returns each customer's visits and spend over the last 90 days, last visit,
and since when they owe.

## Not in this phase

* **Screens:** reports, expenses, customers and subscription billing have no screens yet. The
  dashboard keeps its `sales-summary`, which now provably agrees with the reports.
* **Automatic renewal** (UPI AutoPay, Razorpay Subscriptions). Renewal is paying the next invoice;
  reminders come with Phase 11's notifications.
* **A platform admin console** (plans, suspending a business, refunds). For now these are done in
  the database. Suspending sets `subscriptions.status = 'SUSPENDED'`.
* **Customer statements by SMS/WhatsApp, and interest** (Release 2).
* **Double-entry accounting** (a later product phase).
