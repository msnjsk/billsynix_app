# Phase 9 — Offline POS and synchronisation

**Exit criterion:** *A sale survives browser restart, is not duplicated on retry, and is either
synchronized or clearly retained as failed/pending for operator action.* Met. Evidence:

* **Server:** `test/sync.e2e-spec.ts` (21 tests).
  * A retried upload, and the same bill sent three times at once, record one sale.
  * An id reused for a different bill is refused.
  * Refused bills fail alone (the rest of the batch is recorded), are kept with their payload, and
    are answered the same way when sent again.
  * A manager re-runs, renumbers or discards them.
  * Every sale, online or offline, has matching lines, payments, invoice, stock movements and
    sync record.
* **Counter:** `src/lib/offline/offline.live.test.ts` (frontend repo root, 9 tests, `npm run
  test:live` against a running API). It drives the functions the POS screen calls, on IndexedDB:
  * billing offline writes the bill before showing it as done;
  * the bill is still there after the database is closed and reopened (a restart);
  * back online it is sent once, and sending it again records nothing;
  * with no answer it waits with backoff and jitter;
  * a refused bill stays on the counter as *refused*, isn't resent, and appears in the manager's
    queue;
  * billing stops after the offline limit.

## How it works

```
 POS (registered counter)                                  API
 ──────────────────────────                                ───────────────────────────────
 GET  /sync/config     device, counter, business, policy, drawer, number blocks
 GET  /sync/catalogue  products at this branch's prices (delta after the first download)
 GET  /sync/stock      branch stock (the counter's local balance)
 POST /sync/number-blocks  reserve the next 200 invoice numbers of the counter's series

 offline bill ──► IndexedDB outbox (same transaction as its invoice number) ──► bill shown done
                         │
       when reachable ───┴──► POST /sync/batch [≤ 100 transactions, in order]
                               └─► one result per transaction: ACCEPTED / FAILED / RETRY
```

### Who can sync

Only a **registered device** with a **cashier PIN session** (Phase 3) can sync. Password
sessions get `403 DEVICE_REQUIRED`.

* **Registering:** a manager registers the computer from the POS (*Settings → Offline billing,
  sync and registering this computer*) and the device key is kept on it:
  * in the desktop app, encrypted by the OS (Electron `safeStorage`: DPAPI, Keychain);
  * in a browser, in the POS database.
* **The cashier's session** survives a restart of the desktop app the same way (refresh token in
  `safeStorage`; in a browser it's the httpOnly cookie).
* **Starting offline:** a counter that starts without a connection reopens with the cashier who
  was signed in, until their shift session ends.

### Transactions (`POST /sync/batch`)

| Type | What | Recorded as |
| --- | --- | --- |
| `CASH_SESSION_OPEN` | a drawer opened offline (its id becomes the drawer's id) | `cash_sessions.offline = true` |
| `SALE` | a bill made offline | `sales.offline = true`, `device_id`, `issued_at` = when billed, `synced_at` |

* **Idempotent:** each transaction's UUID, made on the device, is its key in `sync_events`.
  * The key is claimed first in the same database transaction, so a concurrent duplicate waits
    and then gets the stored answer.
  * The same id with a different payload gets `FAILED ID_REUSED`.
* **One at a time:** each transaction is validated and recorded on its own. A malformed one fails
  alone (`VALIDATION_FAILED`); it never blocks the device's queue.
* **Results:**
  * `ACCEPTED`, possibly with warnings;
  * `FAILED`, kept for a manager; the device stops sending it;
  * `RETRY`, nothing was recorded (deadlock, timeout); send it again.
* **Heartbeat:** an empty batch reports the device's queue (pending, failed, oldest), app version
  and clock skew.

### An offline bill is recorded as the customer was charged

| Rule | Policy (docs/phase-0 §5) |
| --- | --- |
| Price and tax | The device's: what the printed invoice says. The server recomputes the bill from the lines with the same maths and refuses it if the device's payable disagrees (`PAYABLE_MISMATCH`). If today's price or rate differs: warning `PRICE_CHANGED` / `TAX_CHANGED`. |
| Invoice number | Must come from a block reserved for **this device**, in the bill's financial year (`NUMBER_NOT_RESERVED`), and be unused (`NUMBER_IN_USE`). |
| Stock | May go below zero (`allowNegative`). The movement is flagged `negative`, with warning `NEGATIVE_STOCK` and outbox event `stock.negative`. Online sales are still refused below zero. |
| Payments | Cash `SUCCEEDED`; UPI/card `PENDING_VERIFICATION` with the UTR/approval code, confirmed by a manager as in Phase 7. |
| Cashier | Must have had a PIN session on this device covering the bill's time (±10 min clock grace), else `CASHIER_NOT_SIGNED_IN`. A cashier signs in on one counter at a time (a PIN sign-in ends their session elsewhere), but a computer that was offline can't be told: what it recorded after the cashier signed in elsewhere is accepted with warning `CASHIER_SIGNED_IN_ELSEWHERE`. |
| Drawer | The one named, for that cashier and counter (`UNKNOWN_DRAWER`). If it was already closed: warning `DRAWER_CLOSED` (its count didn't include the bill). |
| Discount above the limit | The device refuses it offline (a manager's PIN can't be checked). If one arrives: warning `DISCOUNT_ABOVE_LIMIT`. |
| Dates | Business date and financial year from the time billed, in the branch's time zone. Future-dated bills are refused (`FUTURE_DATED`). Bills older than the offline limit: warning `OFFLINE_TOO_LONG`. |
| Already recorded | An online attempt that reached the server but whose answer was lost used the same UUID as `clientRef`. The offline copy is matched to it, not recorded twice, with warning `RENUMBERED` if the numbers differ. |

### Invoice numbers offline (ADR-007)

* **Reserving:** `POST /sync/number-blocks` takes the next `blockSize` (200) numbers of the
  counter's series for the current financial year. Online sales on the counter continue after the
  block.
* **Limits:**
  * a device holds at most two unfinished blocks;
  * the counter tops up when fewer than `blockLowWater` (50) are left.
* **On the device:** the number is taken in the same IndexedDB transaction that writes the bill, so
  a number is never used twice or without a bill.
* **Closing:** a block closes when it is used up, when its year ends, or when the device is
  revoked.
* **Gaps:** the unused numbers of closed blocks are the series' only gaps.
  `GET /sync/number-blocks` lists every block (used, unused, highest used) for the GST records.
  ⚖ Confirm with the GST professional.

### Offline policy (`tenants.settings.offline`)

| Setting | Default | |
| --- | --- | --- |
| `maxOfflineHours` | 24 | the counter refuses to bill after this long without reaching the server |
| `maxPendingSales` | 500 | …or with this many bills waiting |
| `blockSize` / `blockLowWater` | 200 / 50 | number reservation |
| `allowOversell` | true | the counter may sell past its cached stock (the server always accepts and flags) |

Offline billing also stops when the cashier's shift session ends (16 h at most). The next cashier
must sign in online.

### Catalogue cache (`GET /sync/catalogue`)

* **What's sent:** products with the price they bill at in the device's branch (`billPrice`, tax
  inclusive), tax, HSN, MRP, barcodes, `version`; and units, tax rates and categories in full.
* **Delta:** with `cursor`, only products whose own row, branch price or tax rate changed since.
  Keyset-paged (`hasMore`); each download overlaps the last by 60 s, which is harmless.
* **Removed branch prices** now bump the product's version, so they show up too.
* **Reset:** if the branch changed after the last download (e.g. it was pointed at another price
  list), the answer is `reset: true`: drop the cache and take the full list.

## The counter (frontend, `src/lib/offline/`)

| File | |
| --- | --- |
| `db.ts` | IndexedDB (Dexie): `outbox`, `products`, `kv` (config, blocks, stock, cursor), `reads` |
| `outbox.ts` | the queue and `flush()` |
| `cache.ts` | config, catalogue, stock, number blocks |
| `sale.ts` | `billOffline()`: limits, pricing from the cache, number + bill + drawer in one transaction |
| `engine.ts` | runs it all on a device session; the read cache for starting offline |
| `device.ts` | register/forget this computer, cashier PIN sign-in |

* **Sending (`outbox.ts`):**
  * in order, 25 per batch;
  * one sender per tab, and Web Locks keep two tabs from sending together;
  * a forced run ("Sync now", reconnect) waits for one already under way;
  * no answer: exponential backoff with full jitter (2 s doubling to 5 min), persisted, so it
    survives a restart;
  * refused bills stay as *refused* and are re-checked every 15 min, which picks up a manager's
    re-run or discard;
  * sent bills are kept for 7 days, then pruned.
* **When the POS bills offline (`sellLive`):** on a registered counter, when the server is
  unreachable, when the online attempt fails with a network error, or **while older bills are
  still waiting** (they must reach the server first, e.g. the drawer they opened).
* **Starting offline:** the screens' GETs are kept in `reads` and served when the server is
  unreachable. The business, branch and catalogue are required; purchasing, movements, dashboard
  and today's bills are skipped if there's no copy.
* **Service worker:** `public/sw.js` lets the POS page open offline in a browser (production
  builds; the desktop app serves its files locally already). It never caches API calls.
* **UI:**
  * a header chip (*Online · 3 to send · 1 refused · Offline*);
  * the *Offline billing & sync* panel: the queue with errors, Sync now, this computer's
    registration;
  * the login page shows the cashier PIN tab on a registered computer.

## Managers (`cash:reconcile`)

| Endpoint | |
| --- | --- |
| `GET /sync/issues` | failed transactions, and accepted ones with warnings, not yet reviewed |
| `POST /sync/events/:id/retry` | run a failed one again after fixing the cause; `renumber: true` records it under the counter's next number (keeps the printed number in a `RENUMBERED` warning) |
| `POST /sync/events/:id/discard` | it will not be recorded (reason required) |
| `POST /sync/events/:id/acknowledge` | warnings looked at |
| `GET /sync/devices` | per device: last seen / synced, queue size and age, failures, numbers left, clock skew. Alerts: `QUEUE_OLD` (> 1 h), `FAILED_SYNC`, `REVIEW_WARNINGS`, `CLOCK_SKEW` (> 5 min), `FEW_NUMBERS_LEFT` |
| `GET /sync/number-blocks` | reserved blocks, used and unused numbers |

All are audited (`sync.rerun_*`, `sync.discarded`, `sync.acknowledged`, `invoice_block.reserved`,
`sale.synced_offline`, `cash_session.opened_offline`).

## Data model (migration `offline_sync`)

| Table | Purpose |
| --- | --- |
| `invoice_blocks` | reserved number ranges per device / counter / FY (checked to stay inside the 5-digit series) |
| `sync_events` | every uploaded transaction: payload, hash, outcome, warnings, error, review (the plan's `sync_events` and `offline_sales`: a failed bill's payload is kept here) |
| `outbox_events` | transactional outbox (`sync.review_needed`, `sync.failed`, `stock.negative`) for Phase 11's background processing |
| `terminal_devices` + | `last_sync_at`, reported queue, clock skew, app version |
| `sales` + / `cash_sessions` + | `offline`, `device_id`, `synced_at` |

* `terminal_sessions` from the plan are the existing PIN `sessions` (bound to `device_id`).
* `idempotency_records` are unchanged.
* All new tables have row-level security.

## Decisions that differ from Phase 0

* **No PIN unlock offline.** §5 suggested checking PINs offline against a cached hash. A 4–6 digit
  PIN hash on the computer can be brute-forced in minutes, so instead the signed-in cashier
  continues offline until their shift session ends, and a change of cashier needs a connection.
* **Returns offline are not supported yet.** A bill made offline can be returned once it has
  synced.
* **Credit (khata) offline:** with credit sales, in Phase 10.

## Not in this phase

* A back-office screen for `/sync/issues` and `/sync/devices`. Managers use the API (Swagger) for
  now; the counter shows its own queue.
* Per-counter stock allocations (reserving shared stock for offline counters). Overselling is
  accepted and flagged instead.
* Processing `outbox_events` (notifications): Phase 11.
* An Android (React Native) client: the same API.
