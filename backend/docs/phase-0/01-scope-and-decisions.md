# Phase 0 — Scope and product decisions

Status: **Defaults accepted by the owner (2026-11-17)** (items marked ⚖ also need a GST professional).
Source: `BACKEND_IMPLEMENTATION.md` §Phase 0, plus behaviour already built in the frontend
(`src/lib/**`), which is treated as the agreed UX.

## 1. Initial customer profile

| Item | Decision |
| --- | --- |
| Customer | Independent supermarkets / kirana chains, also pharmacies (business type already supported) |
| Branches | 1–3 per business at launch (data model allows more; plan limits enforce the cap) |
| Counters | 2–5 POS counters per branch |
| Devices | Windows PC (Electron app or browser), Android tablet later (React Native) |
| Region | India only; INR; GST regime; timezone per store, default `Asia/Kolkata` |

## 2. MVP feature boundary

**In the MVP** (matches §6 of the plan): tenants and branches, users, roles and branch access,
products and barcodes, pricing and GST, the stock ledger, suppliers, POs, goods receipts,
purchase returns, supplier payments, POS sales, invoices, returns, cash sessions, basic
reports, audit log, offline POS sync, stock transfers between branches.

**Deferred** (UI exists but stays on local/sample data until a later phase):
AI assistant, loyalty programme accounting, customer orders (delivery/pick-up), WhatsApp
notifications, subscription billing automation, advanced finance.

## 3. Feature decisions for release 1

| Question | Decision | Why |
| --- | --- | --- |
| Credit sales (khata) | **Yes, basic**: a sale can carry a `CREDIT` tender against a named customer; outstanding = sum of credit tenders − receipts. No interest, no statements. | The frontend already has khata; shops expect it. Advanced credit is Release 2. |
| Split payments | **Yes** — any mix of Cash / UPI / Card / Credit on one sale. | Already in the POS. |
| Weighted (loose) products | **Yes** — quantities are `Decimal(12,3)`; `unit.allowsFraction` controls it. | Loose rice, dal, vegetables. |
| Batches & expiry | **Yes**, per product flag `tracksBatches`. Sales may pick a batch; FEFO otherwise. | Pharmacy + near-expiry markdowns already in POS. |
| Price basis | **GST-inclusive** (MRP-style) by default; per-tenant setting allows exclusive. | Indian retail norm; matches `computeBill`. |
| Selling price cap | Selling price ≤ MRP, always (Legal Metrology). Branch prices may be lower. | Already enforced in the Branches UI. |
| Discounts | Line discount (₹ or %) then bill discount shared pro-rata; GST worked back from the discounted amount. | Same algorithm as `computeBill` — moved to the backend, unchanged. |
| Rounding | Invoice payable rounded to nearest ₹1; difference shown as "Round off". | Current behaviour. |
| Negative stock | **Online: blocked.** Offline: allowed and flagged for reconciliation (see §5). | Plan §Phase 9 "Essential rule". |
| Stock valuation | **Weighted average cost** per store/product, recalculated on each receipt. | Simple, accepted for SMB; documented in ADR-006. |
| Composition / unregistered businesses | Supported: documents become *Bill of Supply*, no GST charged. | Already in the business profile. |

## 4. Invoice numbering ⚖

GST rule 46: max 16 characters, unique per financial year (Apr–Mar), letters/digits/`-`/`/`.
Several series are allowed.

* **One series per counter** so offline counters never collide:
  `{SERIES}/{FY}/{SEQ}` → `TNG1/2425/00042`
  * `SERIES` = branch code (2–4 chars) + counter number (1 digit) → ≤ 5 chars
  * `FY` = `2425` for 2024-25 (4 chars, no hyphen to stay within 16)
  * `SEQ` = 5 digits, restarting each FY → max length 5+1+4+1+5 = **16**
* Online sales take the next number in a DB transaction (`invoice_sequences` row lock).
* Offline counters pre-reserve a **block** of numbers from their own series (default 200) while
  online; the sync endpoint verifies each offline invoice number belongs to a block issued to that
  device. No gaps are reused; voided numbers stay recorded as cancelled.
* Credit notes: separate series `CN{SERIES}/{FY}/{SEQ}` (≤ 16 with 4-digit seq).

> Change from the current frontend (`SFM/24-25/04822`): the FY loses its hyphen and gains a counter
> digit. Confirm with the GST professional before Phase 7.

## 5. Offline POS operating policy

| Rule | Policy |
| --- | --- |
| What works offline | Billing, returns against bills made on the same device, cash drawer, printing |
| Payments offline | **Cash**: settled. **UPI (static QR) / Card (standalone terminal)**: recorded as `PENDING_VERIFICATION` with the UTR/approval code; a manager confirms after sync. **Credit**: only for customers cached on the device, within their cached limit. |
| Price used | Price list version cached on the device; the sync keeps the device's price (it's what the customer paid) and flags a `PRICE_CHANGED` warning if the server price changed. |
| Stock | Device keeps a local per-counter balance; may sell below zero. Server accepts the sale, posts the movement, and raises a `NEGATIVE_STOCK` reconciliation item. |
| Offline limit | Device refuses to bill after **24 h** offline or **500** pending sales (configurable), forcing a sync. |
| Identity | A device must be registered (Phase 2) and have a signed-in cashier session cached; PIN unlock works offline against a locally cached hash. |

## 6. Roles (summary — full matrix in `02-roles-permissions.md`)

Platform Super Admin, Business Owner, Business Admin, Branch Manager, Inventory Manager, Cashier.
The current frontend roles map as: `owner` → Business Owner, `manager` → Branch Manager,
`cashier` → Cashier.

## 7. Pilot acceptance criteria

The 13 scenarios in §10 of the plan, verbatim, plus:

* A sale billed in Koramangala (KA) to a Tamil Nadu GSTIN buyer charges IGST; the same sale in
  Chennai charges CGST+SGST.
* A stock transfer between branches with different GSTINs produces a tax invoice; same GSTIN
  produces a delivery challan; stock is in-transit between dispatch and receipt.
* An invoice reprinted after a price/tax change shows the original values.

## 8. Open questions for the owner

1. Is the per-counter invoice series (§4) acceptable, or must each branch have one series?
2. Offline cut-off — is 24 h / 500 sales right for your pilot stores?
3. Which payment gateway for UPI/card verification in Phase 7 (Razorpay, PayU, Pine Labs, none)?
4. Hosting region / provider for production PostgreSQL (Phase 12).
