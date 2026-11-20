-- CreateEnum
CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'PENDING_REVIEW', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('PAY_IN', 'PAY_OUT');

-- CreateEnum
CREATE TYPE "SaleDocumentType" AS ENUM ('TAX_INVOICE', 'BILL_OF_SUPPLY');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "SalePaymentStatus" AS ENUM ('PAID', 'PENDING', 'DUE', 'REFUNDED');

-- CreateEnum
CREATE TYPE "TenderMethod" AS ENUM ('CASH', 'UPI', 'CARD');

-- CreateEnum
CREATE TYPE "TenderStatus" AS ENUM ('SUCCEEDED', 'PENDING_VERIFICATION', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SaleReturnReason" AS ENUM ('CHANGED_MIND', 'WRONG_ITEM', 'DAMAGED', 'EXPIRED', 'QUALITY', 'OTHER');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('COMPLETED', 'PENDING');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('TAX_INVOICE', 'BILL_OF_SUPPLY', 'CREDIT_NOTE');

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "tenant_id" UUID NOT NULL,
    "counter_id" UUID NOT NULL,
    "fy" CHAR(4) NOT NULL,
    "kind" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("counter_id","fy","kind")
);

-- CreateTable
CREATE TABLE "cash_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "counter_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "opening_float" DECIMAL(12,2) NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "expected_cash" DECIMAL(12,2),
    "counted_cash" DECIMAL(12,2),
    "variance" DECIMAL(12,2),
    "denominations" JSONB,
    "closing_note" TEXT,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "counter_id" UUID NOT NULL,
    "cash_session_id" UUID NOT NULL,
    "cashier_user_id" UUID NOT NULL,
    "invoice_no" TEXT NOT NULL,
    "document_type" "SaleDocumentType" NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "payment_status" "SalePaymentStatus" NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "business_date" DATE NOT NULL,
    "buyer_name" TEXT,
    "buyer_phone" TEXT,
    "buyer_gstin" TEXT,
    "place_of_supply" CHAR(2) NOT NULL,
    "inter_state" BOOLEAN NOT NULL,
    "bill_discount_kind" TEXT,
    "bill_discount_value" DECIMAL(12,2),
    "gross" DECIMAL(14,2) NOT NULL,
    "line_discounts" DECIMAL(14,2) NOT NULL,
    "bill_discount" DECIMAL(14,2) NOT NULL,
    "taxable" DECIMAL(14,2) NOT NULL,
    "cgst" DECIMAL(14,2) NOT NULL,
    "sgst" DECIMAL(14,2) NOT NULL,
    "igst" DECIMAL(14,2) NOT NULL,
    "cess" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "round_off" DECIMAL(6,2) NOT NULL,
    "payable" DECIMAL(14,2) NOT NULL,
    "change_given" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refunded" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount_approved_by" UUID,
    "client_ref" TEXT,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_user_id" UUID,
    "void_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "line_no" SMALLINT NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hsn_code" TEXT,
    "unit_code" TEXT NOT NULL,
    "qty" DECIMAL(12,3) NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "mrp" DECIMAL(12,2),
    "price_source" TEXT NOT NULL,
    "discount_kind" TEXT,
    "discount_value" DECIMAL(12,2),
    "gross" DECIMAL(14,2) NOT NULL,
    "line_discount" DECIMAL(14,2) NOT NULL,
    "bill_share" DECIMAL(14,2) NOT NULL,
    "final" DECIMAL(14,2) NOT NULL,
    "taxable" DECIMAL(14,2) NOT NULL,
    "gst_rate" DECIMAL(5,2) NOT NULL,
    "cess_rate" DECIMAL(5,2) NOT NULL,
    "cgst" DECIMAL(14,2) NOT NULL,
    "sgst" DECIMAL(14,2) NOT NULL,
    "igst" DECIMAL(14,2) NOT NULL,
    "cess" DECIMAL(14,2) NOT NULL,
    "unit_cost" DECIMAL(14,4) NOT NULL,
    "returned_qty" DECIMAL(12,3) NOT NULL DEFAULT 0,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "method" "TenderMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "TenderStatus" NOT NULL,
    "tendered" DECIMAL(12,2),
    "reference" TEXT,
    "verified_by_user_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'USER',
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_returns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "counter_id" UUID NOT NULL,
    "cash_session_id" UUID,
    "credit_note_no" TEXT NOT NULL,
    "reason" "SaleReturnReason" NOT NULL,
    "note" TEXT,
    "taxable" DECIMAL(14,2) NOT NULL,
    "cgst" DECIMAL(14,2) NOT NULL,
    "sgst" DECIMAL(14,2) NOT NULL,
    "igst" DECIMAL(14,2) NOT NULL,
    "cess" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "refund_method" "TenderMethod" NOT NULL,
    "refund_amount" DECIMAL(14,2) NOT NULL,
    "refund_status" "RefundStatus" NOT NULL,
    "refund_reference" TEXT,
    "approved_by_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_return_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "sale_item_id" UUID NOT NULL,
    "qty" DECIMAL(12,3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "taxable" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL,
    "resaleable" BOOLEAN NOT NULL,

    CONSTRAINT "sale_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "number" TEXT NOT NULL,
    "sale_id" UUID NOT NULL,
    "return_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "document" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_sequences_tenant_id_idx" ON "invoice_sequences"("tenant_id");

-- CreateIndex
CREATE INDEX "cash_sessions_tenant_id_store_id_opened_at_idx" ON "cash_sessions"("tenant_id", "store_id", "opened_at");

-- CreateIndex
CREATE INDEX "cash_sessions_tenant_id_user_id_status_idx" ON "cash_sessions"("tenant_id", "user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cash_sessions_tenant_id_id_key" ON "cash_sessions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "cash_movements_tenant_id_session_id_idx" ON "cash_movements"("tenant_id", "session_id");

-- CreateIndex
CREATE INDEX "sales_tenant_id_store_id_business_date_idx" ON "sales"("tenant_id", "store_id", "business_date");

-- CreateIndex
CREATE INDEX "sales_tenant_id_cash_session_id_idx" ON "sales"("tenant_id", "cash_session_id");

-- CreateIndex
CREATE INDEX "sales_tenant_id_cashier_user_id_business_date_idx" ON "sales"("tenant_id", "cashier_user_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenant_id_invoice_no_key" ON "sales"("tenant_id", "invoice_no");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenant_id_id_key" ON "sales"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "sale_items_tenant_id_product_id_idx" ON "sale_items"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_items_tenant_id_id_key" ON "sale_items"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_items_sale_id_line_no_key" ON "sale_items"("sale_id", "line_no");

-- CreateIndex
CREATE INDEX "sale_payments_tenant_id_sale_id_idx" ON "sale_payments"("tenant_id", "sale_id");

-- CreateIndex
CREATE INDEX "sale_payments_tenant_id_status_idx" ON "sale_payments"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sale_payments_tenant_id_id_key" ON "sale_payments"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "payment_transactions_tenant_id_payment_id_idx" ON "payment_transactions"("tenant_id", "payment_id");

-- CreateIndex
CREATE INDEX "sale_returns_tenant_id_sale_id_idx" ON "sale_returns"("tenant_id", "sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_tenant_id_credit_note_no_key" ON "sale_returns"("tenant_id", "credit_note_no");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_tenant_id_id_key" ON "sale_returns"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "sale_return_items_tenant_id_return_id_idx" ON "sale_return_items"("tenant_id", "return_id");

-- CreateIndex
CREATE INDEX "sale_return_items_tenant_id_sale_item_id_idx" ON "sale_return_items"("tenant_id", "sale_item_id");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_sale_id_idx" ON "invoices"("tenant_id", "sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenant_id_number_key" ON "invoices"("tenant_id", "number");

-- AddForeignKey
ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_tenant_id_counter_id_fkey" FOREIGN KEY ("tenant_id", "counter_id") REFERENCES "counters"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenant_id_store_id_fkey" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenant_id_counter_id_fkey" FOREIGN KEY ("tenant_id", "counter_id") REFERENCES "counters"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_session_id_fkey" FOREIGN KEY ("tenant_id", "session_id") REFERENCES "cash_sessions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_store_id_fkey" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_counter_id_fkey" FOREIGN KEY ("tenant_id", "counter_id") REFERENCES "counters"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_cash_session_id_fkey" FOREIGN KEY ("tenant_id", "cash_session_id") REFERENCES "cash_sessions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenant_id_sale_id_fkey" FOREIGN KEY ("tenant_id", "sale_id") REFERENCES "sales"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_tenant_id_sale_id_fkey" FOREIGN KEY ("tenant_id", "sale_id") REFERENCES "sales"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_tenant_id_payment_id_fkey" FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "sale_payments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenant_id_sale_id_fkey" FOREIGN KEY ("tenant_id", "sale_id") REFERENCES "sales"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenant_id_cash_session_id_fkey" FOREIGN KEY ("tenant_id", "cash_session_id") REFERENCES "cash_sessions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_tenant_id_return_id_fkey" FOREIGN KEY ("tenant_id", "return_id") REFERENCES "sale_returns"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_tenant_id_sale_item_id_fkey" FOREIGN KEY ("tenant_id", "sale_item_id") REFERENCES "sale_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_sale_id_fkey" FOREIGN KEY ("tenant_id", "sale_id") REFERENCES "sales"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_return_id_fkey" FOREIGN KEY ("tenant_id", "return_id") REFERENCES "sale_returns"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- Hand-written part
-- =====================================================================

-- One open drawer per counter, and a cashier works one drawer at a time.
CREATE UNIQUE INDEX "cash_sessions_one_open_per_counter" ON "cash_sessions" ("counter_id") WHERE "status" = 'OPEN';
CREATE UNIQUE INDEX "cash_sessions_one_open_per_user" ON "cash_sessions" ("tenant_id", "user_id") WHERE "status" = 'OPEN';
-- The POS's own bill id is unique per counter (offline retries, Phase 9).
CREATE UNIQUE INDEX "sales_client_ref_key" ON "sales" ("counter_id", "client_ref") WHERE "client_ref" IS NOT NULL;

-- Payment history is append-only.
CREATE FUNCTION payment_transactions_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'payment_transactions is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$fn$;
CREATE TRIGGER payment_transactions_no_update BEFORE UPDATE OR DELETE ON "payment_transactions"
  FOR EACH ROW EXECUTE FUNCTION payment_transactions_append_only();

ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_float_check" CHECK ("opening_float" >= 0 AND ("counted_cash" IS NULL OR "counted_cash" >= 0));
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_amount_check" CHECK ("amount" > 0);
ALTER TABLE "sales" ADD CONSTRAINT "sales_amounts_check"
  CHECK ("payable" >= 0 AND "total" >= 0 AND "change_given" >= 0 AND "refunded" >= 0 AND "refunded" <= "payable");
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_check"
  CHECK ("qty" > 0 AND "unit_price" >= 0 AND "final" >= 0 AND "returned_qty" >= 0 AND "returned_qty" <= "qty"
         AND ("mrp" IS NULL OR "unit_price" <= "mrp"));
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_amount_check" CHECK ("amount" > 0 AND ("tendered" IS NULL OR "tendered" >= "amount"));
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_qty_check" CHECK ("qty" > 0 AND "amount" >= 0);
ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_next_check" CHECK ("next" >= 1);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice_sequences', 'cash_sessions', 'cash_movements', 'sales', 'sale_items', 'sale_payments', 'payment_transactions', 'sale_returns', 'sale_return_items', 'invoices']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
