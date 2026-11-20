-- CreateEnum
CREATE TYPE "TaxKind" AS ENUM ('TAXABLE', 'NIL_RATED', 'EXEMPT', 'NON_GST');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "price_list_id" UUID;

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TaxKind" NOT NULL DEFAULT 'TAXABLE',
    "rate" DECIMAL(5,2) NOT NULL,
    "cess_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" SMALLINT NOT NULL DEFAULT 0,
    "uqc" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "receipt_name" TEXT,
    "description" TEXT,
    "category_id" UUID,
    "brand_id" UUID,
    "unit_id" UUID NOT NULL,
    "tax_rate_id" UUID NOT NULL,
    "hsn_code" TEXT,
    "mrp" DECIMAL(12,2),
    "selling_price" DECIMAL(12,2) NOT NULL,
    "purchase_cost" DECIMAL(12,2),
    "price_includes_tax" BOOLEAN NOT NULL DEFAULT true,
    "allow_open_price" BOOLEAN NOT NULL DEFAULT false,
    "track_inventory" BOOLEAN NOT NULL DEFAULT true,
    "parent_id" UUID,
    "variant_label" TEXT,
    "image_key" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_barcodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "pack_qty" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "label" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_lists" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_prices" (
    "tenant_id" UUID NOT NULL,
    "price_list_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "selling_price" DECIMAL(12,2) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("price_list_id","product_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_tenant_id_id_key" ON "tax_rates"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "units_tenant_id_code_key" ON "units"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "units_tenant_id_id_key" ON "units"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "categories_tenant_id_parent_id_idx" ON "categories"("tenant_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenant_id_id_key" ON "categories"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "brands_tenant_id_id_key" ON "brands"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "products_tenant_id_category_id_idx" ON "products"("tenant_id", "category_id");

-- CreateIndex
CREATE INDEX "products_tenant_id_brand_id_idx" ON "products"("tenant_id", "brand_id");

-- CreateIndex
CREATE INDEX "products_tenant_id_parent_id_idx" ON "products"("tenant_id", "parent_id");

-- CreateIndex
CREATE INDEX "products_tenant_id_updated_at_idx" ON "products"("tenant_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_sku_key" ON "products"("tenant_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_id_key" ON "products"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "product_barcodes_tenant_id_product_id_idx" ON "product_barcodes"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_barcodes_tenant_id_code_key" ON "product_barcodes"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_tenant_id_id_key" ON "price_lists"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "product_prices_tenant_id_product_id_idx" ON "product_prices"("tenant_id", "product_id");

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "stores_tenant_id_price_list_id_fkey" FOREIGN KEY ("tenant_id", "price_list_id") REFERENCES "price_lists"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_parent_id_fkey" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_brand_id_fkey" FOREIGN KEY ("tenant_id", "brand_id") REFERENCES "brands"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_unit_id_fkey" FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tax_rate_id_fkey" FOREIGN KEY ("tenant_id", "tax_rate_id") REFERENCES "tax_rates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_parent_id_fkey" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_tenant_id_price_list_id_fkey" FOREIGN KEY ("tenant_id", "price_list_id") REFERENCES "price_lists"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- Hand-written part (not expressible in schema.prisma)
-- =====================================================================

-- Names unique ignoring case (categories: among siblings; NULLS NOT DISTINCT so two top-level
-- categories can't share a name either).
CREATE UNIQUE INDEX "categories_sibling_name_key" ON "categories" ("tenant_id", "parent_id", lower("name")) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "brands_name_key" ON "brands" ("tenant_id", lower("name"));
CREATE UNIQUE INDEX "tax_rates_name_key" ON "tax_rates" ("tenant_id", lower("name"));
CREATE UNIQUE INDEX "price_lists_name_key" ON "price_lists" ("tenant_id", lower("name"));

-- At most one primary barcode per product.
CREATE UNIQUE INDEX "product_barcodes_one_primary_key" ON "product_barcodes" ("product_id") WHERE "is_primary";

-- Product name search (ILIKE '%word%') uses a trigram index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "products_name_trgm_idx" ON "products" USING gin ("name" gin_trgm_ops);

-- Business rules the database enforces as well as the API.
ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_rate_check" CHECK ("rate" >= 0 AND "rate" <= 100 AND "cess_rate" >= 0 AND "cess_rate" <= 400),
  ADD CONSTRAINT "tax_rates_untaxed_zero_check" CHECK ("kind" = 'TAXABLE' OR ("rate" = 0 AND "cess_rate" = 0));
ALTER TABLE "units" ADD CONSTRAINT "units_decimals_check" CHECK ("decimals" BETWEEN 0 AND 3);
ALTER TABLE "products"
  ADD CONSTRAINT "products_prices_check" CHECK ("selling_price" >= 0 AND ("purchase_cost" IS NULL OR "purchase_cost" >= 0) AND ("mrp" IS NULL OR "mrp" > 0)),
  ADD CONSTRAINT "products_price_within_mrp_check" CHECK ("mrp" IS NULL OR "selling_price" <= "mrp"),
  ADD CONSTRAINT "products_not_own_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_pack_qty_check" CHECK ("pack_qty" > 0);
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_price_check" CHECK ("selling_price" >= 0);

-- Default tax rates and units for businesses that already exist (new businesses get them at
-- registration — keep in step with src/catalogue/defaults.ts). Done before RLS is enabled.
INSERT INTO "tax_rates" ("tenant_id", "name", "kind", "rate", "updated_at")
SELECT t.id, d.name, d.kind::"TaxKind", d.rate, now()
FROM "tenants" t
CROSS JOIN (VALUES
  ('GST 0% (nil-rated)', 'NIL_RATED', 0),
  ('Exempt', 'EXEMPT', 0),
  ('GST 5%', 'TAXABLE', 5),
  ('GST 18%', 'TAXABLE', 18),
  ('GST 40%', 'TAXABLE', 40)
) AS d(name, kind, rate);

INSERT INTO "units" ("tenant_id", "code", "name", "decimals", "uqc")
SELECT t.id, d.code, d.name, d.decimals, d.uqc
FROM "tenants" t
CROSS JOIN (VALUES
  ('PCS', 'Pieces', 0, 'NOS'),
  ('KG', 'Kilogram', 3, 'KGS'),
  ('G', 'Gram', 0, 'GMS'),
  ('L', 'Litre', 3, 'LTR'),
  ('ML', 'Millilitre', 0, 'MLT'),
  ('PKT', 'Packet', 0, 'PAC'),
  ('BOX', 'Box', 0, 'BOX'),
  ('DOZ', 'Dozen', 0, 'DOZ'),
  ('M', 'Metre', 2, 'MTR')
) AS d(code, name, decimals, uqc);

-- Row-level security, same policy as the Phase 2 tables (ADR-004).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_rates', 'units', 'categories', 'brands', 'products', 'product_barcodes', 'price_lists', 'product_prices']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
