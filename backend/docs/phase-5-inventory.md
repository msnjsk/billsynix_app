# Phase 5 — Inventory and stock ledger

**Exit criterion:** *Every stock balance can be explained by its opening balance plus recorded
movements, and concurrent stock operations cannot silently corrupt balances.* Met. Evidence is in
`test/inventory.e2e-spec.ts` (23 tests):

* After every scenario a database query confirms that each balance equals the sum of its
  movements, per product and per batch.
* 12 parallel write-offs against 5 units: exactly 5 succeed.
* 10 parallel receipts all land, with the correct weighted average.
* The same request sent 5 times at once is done once.
* Editing or deleting a movement is refused, even straight in the database.

## How stock is recorded

* **`stock_movements` is the ledger.** Each row is one signed quantity change for a product in a
  branch (and batch), valued at a unit cost and carrying the branch balance after it.
  * It is **append-only**: a trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` for every database
    role, including the owner.
  * Mistakes are fixed with new, compensating movements.
* **`stock_balances`** holds quantity and weighted average cost per branch and product.
  **`batch_stocks`** holds quantity per branch and batch.
* **`LedgerService.post` is the only code that changes stock.** Sales and goods receipts will use
  it in Phases 6 and 7. In one transaction, together with the document that caused it, it:
  1. Locks the balance rows involved in product-id order, then their batch rows in batch-id order.
     A fixed order means two postings can't deadlock.
  2. Checks the quantities actually available at that moment, so two counters can't both sell
     the last unit.
  3. Appends the movements and writes the new balances.
* **Movement types:** `OPENING, PURCHASE_RECEIPT, PURCHASE_RETURN, SALE, SALE_RETURN, ADJUSTMENT,
  COUNT_ADJUSTMENT, WRITE_OFF, TRANSFER_OUT, TRANSFER_IN, TRANSFER_LOSS`. Every movement points at
  the document that caused it (`refType`, `refId`).
* **Quantities** are `numeric(12,3)`. A product's unit decides how many decimals are allowed
  (PCS 0, KG 3).

## Policies

| Topic | Policy |
| --- | --- |
| Negative stock | Refused online (`409 STOCK_INSUFFICIENT`), and the database checks it too. Phase 9's offline sync may post below zero; such movements are flagged `negative` for reconciliation. |
| Valuation (ADR-006) | Weighted average cost per branch and product. Stock coming in at cost *c* gives avg = (q·avg + q_in·c) / (q + q_in). Stock going out leaves at the average. If stock was at or below zero, the new average is the incoming cost. |
| Batches | Per product: `tracksBatches` turns it on, along with expiry. Incoming stock must name its batch. Outgoing stock takes the earliest expiry first (FEFO) unless a batch is named. Batch quantities add up to the balance. |
| Opening stock | An `OPENING` adjustment with a unit cost. It must be the product's first movement in that branch; after that, use `FOUND` or `COUNT_CORRECTION`. |
| Approvals | An adjustment is valued at Σ \|qty\| × cost. Up to `settings.approvalLimits.adjustmentValue` (₹5,000) it posts immediately. Above that, a branch-scoped employee's adjustment waits for someone else with `inventory:approve`; owners and admins post their own. Count postings follow the same rule. |
| Changing tracking | `trackInventory` and `tracksBatches` can't change while a branch holds stock. |
| Idempotency | Stock-changing POSTs require `Idempotency-Key`. The first response is stored in the same transaction as the work: a retry gets it back (`Idempotent-Replayed: true`), and the same key with a different body gets `409 IDEMPOTENCY_CONFLICT`. |
| Costs visible to | `inventory:adjust`, `products:write`, `prices:write`, `purchases:write`, `reports:finance`. Cashiers see quantities only. |

## Representing reservations, returns and in-transit stock

* **Reservations:** none. A sale posts its `SALE` movements in the same transaction that creates
  it (Phase 7), so there's no gap to reserve across. Held or parked bills don't reserve stock;
  they are checked when completed.
* **Returns:** `SALE_RETURN` (+) at the original sale's cost, only for resaleable reasons. Damaged
  returns go back in and out again as `WRITE_OFF`, so the loss is visible. Purchase returns are
  `PURCHASE_RETURN` (−) (Phase 6).
* **In transit:** `TRANSFER_OUT` at dispatch takes stock out of the source. Until receipt it's in
  neither branch's sellable stock and is shown as `inTransitIn` / `inTransitOut`. On receipt,
  `TRANSFER_IN` brings in what was sent, and `TRANSFER_LOSS` takes out any shortfall, both at the
  dispatch cost.

## Endpoints (`/api/v1`)

| Endpoint | Permission | |
| --- | --- | --- |
| `GET /stores/:storeId/stock` | `inventory:read` | Branch stock: `q`, `categoryId`, `status=ALL\|IN_STOCK\|LOW\|OUT` |
| `GET /stores/:storeId/stock/:productId` | `inventory:read` | With batches and in-transit |
| `PUT /stores/:storeId/stock/:productId/reorder` | `inventory:adjust` | Reorder level and quantity |
| `GET /stores/:storeId/stock-movements` | `inventory:read` | Ledger, newest first, cursor (`meta.nextCursor`) |
| `GET /stock/alerts/low`, `GET /stock/alerts/expiry?days=` | `inventory:read` | Across your branches |
| `GET /stock/reconciliation?storeId=` | `inventory:approve` | Live check of the ledger invariant |
| `GET/POST /products/:id/batches` | read / `inventory:adjust` | |
| `POST /stores/:storeId/stock-adjustments` ★ | `inventory:adjust` | Reasons: `OPENING, DAMAGE, EXPIRY, WASTAGE, THEFT, FOUND, COUNT_CORRECTION, OTHER` |
| `GET /stock-adjustments`, `GET /stock-adjustments/:id` | `inventory:read` | Filter `status=PENDING_APPROVAL` for the approval queue |
| `POST /stock-adjustments/:id/approve` ★, `/reject`, `/cancel` | approve / approve / author or approver | |
| `POST /stores/:storeId/stock-counts` | `inventory:adjust` | Every stocked product, a category, or a product list |
| `PUT /stock-counts/:id/items`, `POST …/submit`, `POST …/cancel` | `inventory:adjust` | |
| `POST /stock-counts/:id/post` ★ | `inventory:approve` | Books counted − system |
| `POST /stock-transfers`, `GET /stock-transfers[/:id]` | `transfers:request` / read | |
| `POST /stock-transfers/:id/dispatch` ★, `/receive` ★, `/cancel` | dispatch (source branch) / receive (destination branch) / request | |

★ requires `Idempotency-Key`.

## Physical counts

Starting a count lists each stocked product, or each batch for batch-tracked products, with the
quantity the system expects. Recording a counted line also refreshes its system quantity to that
moment, so a sale during counting doesn't show up as a difference. Posting writes counted − system
as `COUNT_ADJUSTMENT` movements. Lines nobody counted are left alone. Stock found in a batch that
isn't on the sheet is booked with a `FOUND` adjustment.

## Seed data

`npm run db:seed` now also adds:

* Opening stock in both branches (T. Nagar holds about half of Anna Nagar).
* Reorder levels.
* Paneer and curd tracked by batch, with two batches each expiring in 4 and 12 days, so the expiry
  alert shows something.

## Not in this phase

* **Transfer documents:** the delivery challan or tax invoice for transfers, which needs invoice
  numbering (Phase 7). `crossGstin` on each transfer already says which document applies.
* **Cleaning up idempotency records** older than 24 hours: a background job in Phase 11. Until
  then the records simply stay.
* **Partial transfer receipts:** a transfer is received in one go, and any shortfall is booked as
  a loss.
