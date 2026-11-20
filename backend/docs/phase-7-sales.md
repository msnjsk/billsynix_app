# Phase 7 — POS sales, invoices and payments

**Exit criterion:** *Repeated requests cannot create duplicate sales, and each successful sale has
consistent invoice, payment and inventory records.* Met. Evidence is in `test/sales.e2e-spec.ts`
(23 tests).

* **Retries:** a retried sale is replayed, and five identical requests sent at once make one sale.
* **Duplicate bills:** a POS bill id (`clientRef`) can't be saved twice.
* **Failed sales leave nothing:** no stock moves and no invoice number is used.
* **The last unit:** two counters selling it at once results in exactly one sale.
* **Consistency, checked in the database for every sale:**
  * Σ line finals = total;
  * payable = total rounded to the rupee;
  * Σ payments = payable;
  * the invoice document exists under the sale's number;
  * stock movements = quantities sold.

## A sale (`POST /sales`, `Idempotency-Key` required)

One transaction; any failure rolls back all of it:

1. **Idempotency.** The key is recorded first, so a retry (or a concurrent duplicate) waits and
   then gets the stored response.
2. **Counter and drawer.** A PIN session bills on its device's counter; a password session names
   one. The cashier must have their own drawer open on it.
3. **Prices are the server's.** The branch's price list, else the product's selling price.
   * A client price is accepted only for open-price items, and never above MRP.
   * Tax-exclusive products get GST and cess added.
   * `expectedPayable` lets the POS catch a price change (`409 PRICE_CHANGED`).
   * `POST /sales/quote` returns the same calculation, with stock on hand, without saving.
4. **Billing maths.** The same algorithm as the frontend's `computeBill`, ported to decimals:
   * line discounts (₹ or %) first, then the bill discount shared pro-rata, with the rounding
     remainder on the biggest line;
   * GST worked back out of each line's tax-inclusive amount;
   * CGST/SGST halved per rate slab;
   * IGST when a business buyer's GSTIN is from another state;
   * payable rounded to the rupee, with the difference shown as round-off.

   Composition and unregistered businesses issue a **Bill of Supply** with no GST.
5. **Discounts above the limit** (any line, or the bill overall, over
   `settings.approvalLimits.discountPct`, 10%) need `discount:override`, or a manager's PIN in
   `approval`.
6. **Stock** leaves through the ledger as `SALE`. Rows are locked and checked, never below zero
   online, earliest expiry first for batch-tracked items unless a batch is named. Each line keeps
   its cost (the average at that moment) for margin reports.
7. **The invoice number** is the next in the counter's series for the financial year (see below).
   It is gap-free: a failed sale rolls the counter back.
8. **Snapshots on every line:** name, SKU, HSN, unit, quantity, unit price, MRP, price source,
   discount, bill share, final amount, taxable value, GST and cess rates and amounts, cost.
9. **Payments:**
   * The tenders must add up to the payable exactly.
   * Cash may be over-tendered, and change is computed.
   * Cash is `SUCCEEDED` at once. **UPI and card are `PENDING_VERIFICATION`.**
   * Every state change is appended to `payment_transactions`, which can't be edited.
10. **The printed document** is stored as JSON in `invoices`. `GET /sales/:id/receipt` returns it,
    and `GET /sales/:id/receipt.html` renders an 80 mm receipt, escaped and under a strict CSP,
    that prints to paper or PDF.

## Invoice numbering (docs/phase-0 §4)

| Document | Format | Example |
| --- | --- | --- |
| Invoice / bill of supply | `{branch code}{counter}/{FY}/{5 digits}` | `ANR1/2627/00042` |
| Credit note | `{branch code}{counter}/{FY}/C{4 digits}` | `ANR1/2627/C0007` |

* **Series:** one per counter, so offline counters (Phase 9) can't collide.
* **Restart:** the series restarts every financial year (April–March, by the branch's business
  date).
* **Length:** at most 16 characters (GST rule 46).
* ⚠ **Change from Phase 0:** the plan's `CN{series}/…` credit-note format is 17 characters with
  a 5-character series, so the credit-note marker moved to the sequence (`/C0007`). Confirm both
  formats with the GST professional.

## Payment states

| Tender | At sale | Then |
| --- | --- | --- |
| Cash | `SUCCEEDED` | — |
| UPI / card | `PENDING_VERIFICATION` (sale `PENDING`) | `POST /sale-payments/:id/confirm` (seen in the bank or terminal statement) → `SUCCEEDED`; `/fail` → `FAILED` (sale `DUE`). Needs `cash:reconcile`. A payment-provider webhook can drive the same transitions later. |
| Any | — | `REFUNDED` on void |

A cashier's tap is never treated as proof that UPI or card money arrived.
`GET /sales/pending-payments` is the verification queue.

## Returns (`POST /sales/:id/returns`, `Idempotency-Key` required)

* **Limits:** only against the invoice, and per line no more than sold − already returned. The
  sale is locked, so concurrent returns can't over-return.
* **Value:** what was charged per unit after all discounts, from the snapshot, never today's
  price. The return that empties the invoice refunds exactly what's left of the payable; others
  are rounded to the rupee.
* **Credit note** from the returning counter's series, stored like an invoice.
* **Stock:** `SALE_RETURN` back to the batches it left from, at the cost it left with. `DAMAGED`
  and `EXPIRED` returns are then written off (`WRITE_OFF`).
* **Refund:**
  * Cash comes out of the cashier's open drawer.
  * UPI or card refunds are `PENDING` until sent.
  * A refund above `returnWithoutManager` (₹2,000) needs `sales:void` or a manager's PIN.

## Voids (`POST /sales/:id/void`)

* **Allowed:** same business day, no returns yet, and the sale's drawer still open. Needs
  `sales:void` or a manager's PIN.
* **Effect:** stock goes back at the cost it left with, payments become `REFUNDED`, and the
  invoice is marked `CANCELLED`. The number stays used, and the receipt shows a CANCELLED stamp.

## Cash drawers

* **Opening:** `POST /cash-sessions` with a float. There's one open drawer per counter, and a
  cashier has one at a time (unique indexes).
* **During the shift:** `POST /cash-sessions/:id/movements` records `PAY_IN` and `PAY_OUT`; a
  pay-out can't exceed what should be in the drawer. `GET /cash-sessions/current` shows live
  figures: float, cash sales, cash refunds, pay-ins, pay-outs, expected cash, and UPI/card split
  into settled and pending.
* **Expected cash** = float + cash taken (excluding change) − cash refunds + pay-ins − pay-outs.
  Sales voided in the session drop out.
* **Closing:** `POST /cash-sessions/:id/close` takes the counted cash, plus optional
  denominations that must add up, and records the variance.
  * A variance over `settings.approvalLimits.cashVariance` (₹200) waits as `PENDING_REVIEW`.
  * Someone with `cash:reconcile` closes it with `POST /cash-sessions/:id/review`.
* **Report:** `GET /reports/cashiers?date=` gives cashier-wise bills, voids, sales, discounts,
  tenders by method, pending verification, refunds and drawer variance.

## Who can do what

| Action | Permission |
| --- | --- |
| Quote, sell | `sales:create` (+ own open drawer) |
| See sales | `sales:read`. Without `reports:sales` (cashiers): only your own bills. |
| Line costs on a sale | `reports:finance` |
| Return | `sales:return` (large refunds: + manager) |
| Void | `sales:void`, or a manager's PIN |
| Discount above limit | `discount:override`, or a manager's PIN |
| Open/close own drawer, pay-in/out | `cash:session` |
| Verify UPI/card, review drawers, cashier report | `cash:reconcile` |

**Manager PIN approval:** the request carries `approval: { userId, pin }`. The PIN is checked in
its own transaction, so failed attempts count even when the request is refused, and 5 wrong PINs
lock it for 15 minutes. The manager must hold the needed permission at that branch. The approver
is recorded on the sale (`discountApprovedBy`), the return or the void.

## Seed data

`npm run db:seed` adds a morning at Anna Nagar counter 1:

* a cash bill with change;
* a UPI bill awaiting verification;
* a bill with a 5% discount and a named customer;
* the drawer then counted and closed.

## Not in this phase

* **Credit (khata) sales and customer accounts:** Phase 10, with customer receivables. The
  buyer's name, phone and GSTIN are already kept on the invoice.
* **Offline sales and reserved number blocks:** Phase 9. `clientRef` and the per-counter series
  are already in place.
* **Payment-provider integration** (UPI collect, card terminal callbacks), driving the same
  verification transitions.
* **E-invoicing (IRN) for B2B invoices** above the turnover threshold.
* **A server-generated PDF:** the HTML receipt prints to PDF; a PDF engine can be added if needed.
