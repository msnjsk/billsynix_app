# Phase 4 — Product catalogue, pricing and tax

**Exit criterion:** *A business owner can create, import, search and update products without
accessing another tenant's catalogue.* Met. Evidence is in `test/catalogue.e2e-spec.ts` (30
tests): another business's products, categories, units, tax rates, price lists and photos all
answer 404 or are refused as references, and row-level security hides the rows even from a query
that forgets the business filter.

## Endpoints (`/api/v1`)

| Endpoint | Permission | Purpose |
| --- | --- | --- |
| `GET/POST /tax-rates`, `PATCH /tax-rates/:id` | read: `products:read`, write: `products:write` | GST classification: kind, rate %, cess % |
| `GET/POST /units`, `PATCH /units/:id` | same | Units of measure with GST UQC and allowed decimals |
| `GET/POST /categories`, `PATCH/DELETE /categories/:id` | same | Up to 3 levels; each row carries its `path` |
| `GET/POST /brands`, `PATCH/DELETE /brands/:id` | same | |
| `GET /products` | `products:read` | Search and list: `q`, `categoryId` (includes subcategories), `brandId`, `parentId` (variants), `ids`, `status`, `storeId` (adds `storePrice`), `sort` |
| `POST /products`, `GET/PATCH /products/:id` | read / `products:write` | `PATCH` takes an optional `version` → 409 `VERSION_CONFLICT` if stale |
| `POST /products/:id/archive`, `/restore` | `products:write` | Archive instead of delete |
| `POST /products/:id/barcodes`, `DELETE …/barcodes/:barcodeId` | `products:write` | |
| `GET /products/lookup?code=&storeId=` | `products:read` | Scanner lookup: barcode first, then SKU; returns `packQty` |
| `PUT/GET/DELETE /products/:id/image` | write / read | JPEG, PNG or WebP up to 2 MB |
| `POST /products/import?dryRun=` | `products:write` | CSV upload (multipart field `file`) |
| `GET /products/export`, `GET /products/import/template` | `products:write` | CSV download |
| `GET/POST /price-lists`, `GET/PATCH /price-lists/:id` | read / `prices:write` | |
| `GET/PUT /price-lists/:id/prices`, `DELETE …/prices/:productId` | read / `prices:write` | Up to 500 prices per call, all or nothing |
| `PUT /stores/:storeId/price-list` | `prices:write` | Choose a branch's price list, or `null` for none |

## Rules

* **SKU** is upper-cased and unique per business. A **barcode** is unique per business and may
  not equal another product's SKU, because lookups match both.
* **Barcode check digits.** All-digit codes of GS1 length (8, 12, 13 or 14 digits) must have a
  correct check digit, which catches typing mistakes. Shorter or alphanumeric in-house codes are
  free-form.
* **Pack barcodes.** A barcode has a `packQty`, so scanning a case barcode sells, for example, 12
  units. The first barcode is primary unless another is flagged.
* **MRP.** The selling price may not exceed MRP. For tax-exclusive prices the check uses
  price + GST + cess. This applies to products, price-list entries and imports, and an MRP can't
  be lowered below an existing list price (`PRICE_ABOVE_MRP`, `PRICE_LIST_ABOVE_MRP`).
* **Tax kinds.** `TAXABLE` (rate above 0), `NIL_RATED`, `EXEMPT` and `NON_GST` (rate and cess 0).
  The database enforces the same rules with CHECK constraints. Changing a rate affects future
  bills only: Phase 7 sales will store a snapshot of rate, HSN and price on every line, and old
  invoices are never recalculated.
* **Variants** are products with `parentId` and a `variantLabel` (for example "5 kg"), one level
  deep. Each variant has its own SKU, barcodes, price and (from Phase 5) stock.
* **Purchase cost** is returned only to roles that buy or price stock (`products:write`,
  `prices:write`, `purchases:write`, `reports:finance`). Cashiers don't see it.
* **Money** comes back as strings (`"45.00"`) and is accepted as a string or a number. More than
  2 decimal places is rejected, never rounded. Percentages are numbers.

## Branch prices

A branch can be assigned one price list. When it bills, a product listed there uses the list
price and every other product uses its own selling price; the source is shown in
`storePrice.source`. Anyone with `prices:write` may edit a list **only if they manage every
branch that uses it**. In practice:

* A branch manager can price their own branch.
* A branch manager can never change prices at another branch.
* A branch manager can't attach a list that another branch uses.

## CSV import

* **Columns:** `sku, name, receipt_name, category, brand, unit, tax, hsn, mrp, selling_price,
  purchase_cost, price_includes_tax, barcodes, parent_sku, variant_label, track_inventory,
  allow_open_price, status, description`. Only `sku` is required as a column. New products also
  need `name`, `selling_price` and `tax`; `unit` defaults to PCS.
* **Matching:** rows are matched by SKU and updated, or created when the SKU is new. On update,
  an absent column or an empty cell leaves that field unchanged.
* **Cell formats:**
  * `category` takes a path: `Grocery > Rice`.
  * `tax` takes a rate's name (`GST 5%`), a number (`5`), `nil`, `exempt` or `non-gst`.
  * `barcodes` takes codes separated by `|`, with `*qty` for packs: `8901234100011|8901234100028*6`.
  * Yes/no columns accept `yes/no/true/false/1/0`.
* **All or nothing:** every row is checked first. If any row has a problem, nothing is written,
  and `errors[]` gives the spreadsheet row number, the column and a message. `?dryRun=true` only
  checks, and also reports the categories and brands it would create.
* **Spreadsheet damage it handles:**
  * HSN codes that lost a leading zero (`401` becomes `0401`).
  * Barcodes Excel turned into `8.90123E+12` (reported with how to fix them).
  * Files not saved as UTF-8 (refused with how to fix them).
* **Limits:** 2 MB and 5,000 rows per file, run in one transaction.
* **Export** writes the same columns, so export → edit → import round-trips. Cells that would run
  as a spreadsheet formula (`=`, `+`, `-`, `@`) get a leading `'`, and import removes it.

## Product photos

* **Upload:** multipart field `image`. The type is read from the file's bytes, not from its name
  or declared type. JPEG, PNG and WebP are accepted; anything else, including SVG, gets 415.
  Files over 2 MB get 413.
* **Reading:** `imageUrl` points at the authenticated API endpoint (`?v=<version>` busts caches).
* **Storage** (`STORAGE_DRIVER`):
  * `local` writes under `STORAGE_LOCAL_DIR`. The Docker image has `/app/storage` on the
    `uploads` volume.
  * `s3` works with AWS S3, Cloudflare R2 or MinIO. The bucket stays private, and reads are
    5-minute pre-signed redirects.
  * Use `s3` as soon as more than one API instance runs.

## Data

New tables: `tax_rates`, `units`, `categories`, `brands`, `products`, `product_barcodes`,
`price_lists`, `product_prices`, plus `stores.price_list_id`.

* **Isolation:** all are tenant-owned, with composite foreign keys and the same row-level security
  policy as Phase 2.
* **Uniqueness:** names are unique ignoring case (sibling categories, brands, tax rates, price
  lists), and a product has at most one primary barcode.
* **Search:** a trigram index (`pg_trgm`) serves name search.
* **Defaults:** new businesses get tax rates (nil, exempt, 5%, 18%, 40%) and units (PCS, KG, G,
  L, ML, PKT, BOX, DOZ, M). The migration gave existing businesses the same.

## Seed data

`npm run db:seed` creates **Sri Lakshmi Supermarket** with two branches:

* **Anna Nagar** (head office).
* **T. Nagar**, on a price list with 5 cheaper fast movers.

The catalogue has 60 products (fictional brands) across 11 departments, with:

* loose vegetables sold by the kilogram;
* case barcodes on soft drinks, biscuits, soap, oil and water;
* an atta 1 kg / 5 kg variant pair.

Sign in as `owner@demo.test` / `demo-password-123`. Re-running the seed updates the data; it
never duplicates it, and it refuses to run with `NODE_ENV=production`.

⚠ **GST rates and HSN codes** in the defaults and the seed follow the September 2025 rate changes
as far as known. Have an accountant confirm them before issuing real invoices.

## Not in this phase

* **Stock levels, reorder points, batches and expiry:** Phase 5.
* **Price and tax snapshots on sale lines:** Phase 7, when sales exist.
* **A catalogue change feed for offline POS** (cursor on `products.updated_at`, which is already
  indexed, and `version`): Phase 8 sync.
* **Image resizing and thumbnails.** Photos are stored as uploaded, which the 2 MB cap keeps
  manageable.
