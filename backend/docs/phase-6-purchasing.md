# Phase 6 — Suppliers and purchase management

**Exit criterion:** *A purchase receipt updates inventory and supplier balances atomically, and
partial deliveries are represented accurately.* Met. Evidence is in
`test/purchasing.e2e-spec.ts` (24 tests):

* A receipt posts stock, the payable and the PO's progress in one transaction.
* A receipt that fails (a missing batch number) leaves stock, balance and receipt count
  untouched.
* Two deliveries posted at once against one PO both count.
* A purchase order goes PARTIAL → RECEIVED with exact quantities per line.
* Every supplier balance equals the sum of its ledger entries.

## Documents

| Document | Number | Effect |
| --- | --- | --- |
| Purchase order | `PO-00001` | None on stock or payables. `DRAFT → SENT`, or `→ PENDING_APPROVAL → SENT` above the limit; then `PARTIAL → RECEIVED` from receipts; `CLOSED` (short) or `CANCELLED` (nothing received). |
| Goods receipt (GRN) | `GRN-00001` | The delivery **and** the supplier's invoice. Stock in: `PURCHASE_RECEIPT` of the accepted qty. Payable up: invoice value of the received qty. |
| Purchase return (debit note) | `DN-00001` | Stock out (`PURCHASE_RETURN`) unless the goods arrived damaged. Payable down. |
| Supplier payment | `PAY-00001` | Payable down (or up for a refund received). Allocated to receipts. |

Numbers are gap-free per business: a row-locked counter that rolls back with a failed document.

## Rules

* **Quantities on a receipt line:** ordered (still outstanding on the PO), received, damaged, and
  **accepted = received − damaged**. Only accepted stock goes in.
* **Damaged goods.** The payable is the supplier's invoice value of what they sent. Goods that
  arrived damaged go back on a purchase return with `fromDamaged`, which issues the debit note
  without touching stock.
* **Three-way match.** A receipt line is compared with its PO line:
  * `NOT_ORDERED`: the product isn't on the PO.
  * `OVER_RECEIPT`: more accepted than was still outstanding.
  * `PRICE`: net rate more than 0.5% above the PO.

  Findings are stored on the receipt as `matchIssues`. As agreed in Phase 0, they **don't
  block** the receipt.
* **Duplicate invoices.** A supplier's invoice number can be entered only once (ignoring case).
* **GST:**
  * **Who charges it:** a registered supplier (one with a GSTIN) charges GST.
  * **Which kind:** CGST + SGST when their state matches the receiving branch's, IGST otherwise.
  * **Totals:** line discount first, then GST and cess per line. The document total is rounded to
    the rupee, with the difference shown as round-off. This is the same method as the frontend's
    `totalsOf`.
  * **Snapshots:** every document stores its totals and line taxes as computed when saved, and
    they're never recalculated.
* **Stock cost (weighted average, ADR-006):** the net rate per unit. GST and cess are added when
  the business can't claim input credit (composition or unregistered).
* **Prices:**
  * **Line rate:** taken from the request, else the PO line, else the supplier's price, else the
    product's last purchase cost.
  * **After each receipt:** it updates the supplier's price for that product and the product's
    `purchaseCost`.
* **Approvals.** A PO whose total is above `settings.approvalLimits.purchaseOrderValue` (₹50,000
  by default) waits for someone with `purchases:approve`. Holders of that permission send their
  own large POs directly.
* **Returns limit.** A receipt line can't be returned beyond what it brought: its accepted
  quantity from stock, or its damaged quantity for `fromDamaged` returns.
* **Payments:**
  * Allocations are checked against what is still owed on each receipt.
  * Without allocations, a payment settles the oldest due receipts first.
  * `allocations: []` keeps the whole payment as an advance.
  * Concurrent payments to one supplier are serialised by a lock on the supplier.
* **Idempotency.** Receipts, returns and payments require `Idempotency-Key`.

## Payables

* **`supplier_transactions`** is the payables ledger, append-only through a trigger.
  * Entry types: `OPENING`, `PURCHASE` (+), `RETURN` (−), `PAYMENT` (−), `REFUND` (+).
  * Each entry stores the balance after it.
  * `suppliers.balance` is changed only together with an entry, under a row lock.
  * Positive means we owe them; negative means an advance or credit with them.
* **Outstanding per receipt** = total − payments allocated − debit notes against it, never below
  zero.
* **Due date** = invoice date (or receipt date) + the supplier's credit days, unless given.
* **Ageing** (`GET /reports/payables`) groups each supplier's unpaid receipts into not yet due,
  1–30, 31–60 and 60+ days late. `other` is the rest of the balance (opening balance, advances).

## Endpoints (`/api/v1`)

| Endpoint | Permission |
| --- | --- |
| `GET /suppliers`, `GET /suppliers/:id`, `GET /suppliers/:id/products` | any of `suppliers:manage`, `purchases:write`, `supplier-payments:write`, `reports:finance` (balances shown only to the last two) |
| `POST /suppliers`, `PATCH /suppliers/:id`, `PUT /suppliers/:id/products` | `suppliers:manage` (an opening balance also needs a payer) |
| `GET /suppliers/:id/statement?from=&to=`, `GET /suppliers/:id/open-bills`, `GET /reports/payables` | `supplier-payments:write` or `reports:finance` |
| `GET /products/:id/purchase-history` | `purchases:write`, `suppliers:manage` or `reports:finance` |
| `GET/POST /purchase-orders`, `GET/PATCH /purchase-orders/:id`, `POST …/submit`, `…/cancel`, `…/close` | `purchases:write` |
| `POST /purchase-orders/:id/approve` | `purchases:approve` |
| `POST /goods-receipts` ★, `GET /goods-receipts[/:id]` (`?unpaid=true`) | `purchases:write` |
| `POST /purchase-returns` ★, `GET /purchase-returns[/:id]` | `purchases:write` |
| `POST /supplier-payments` ★, `GET /supplier-payments[/:id]` | `supplier-payments:write` |

★ requires `Idempotency-Key`. Branch-scoped staff see and act on POs, receipts and returns of
their own branches only.

## Seed data

`npm run db:seed` adds four suppliers:

* Sri Balaji Traders (Tamil Nadu)
* Amudham Dairy Co-op (Tamil Nadu)
* Fizzo Beverages (Karnataka, so IGST)
* an unregistered vegetable supplier

It also adds three purchasing documents:

* a part-received PO from Sri Balaji, with one damaged bag on the receipt and a ₹10,000 payment;
* a Fizzo invoice from 40 days ago, which appears as overdue in the ageing report.

## Not in this phase

* **A separate supplier-bill document** covering several receipts. Following the plan's entity
  list, a receipt carries its own invoice.
* **Partial cancellation of PO lines.** Close the PO and raise a new one instead.
* **TDS on supplier payments, and e-invoice / e-way bill integration:** later phases.
