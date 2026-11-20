-- CreateEnum
CREATE TYPE "CustomerOrderStatus" AS ENUM ('NEW', 'PACKING', 'READY', 'DISPATCHED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderFulfilment" AS ENUM ('DELIVERY', 'PICKUP');

-- CreateEnum
CREATE TYPE "OrderPayment" AS ENUM ('CASH_ON_DELIVERY', 'PREPAID_UPI', 'KHATA');

-- CreateTable
CREATE TABLE "customer_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "customer_id" UUID,
    "customer_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "fulfilment" "OrderFulfilment" NOT NULL,
    "slot" TEXT NOT NULL,
    "payment" "OrderPayment" NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "collected_by" TEXT,
    "rider" TEXT,
    "items" JSONB NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "delivery_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "status" "CustomerOrderStatus" NOT NULL DEFAULT 'NEW',
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_orders_tenant_id_store_id_status_idx" ON "customer_orders"("tenant_id", "store_id", "status");

-- CreateIndex
CREATE INDEX "customer_orders_tenant_id_store_id_created_at_idx" ON "customer_orders"("tenant_id", "store_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_orders_tenant_id_number_key" ON "customer_orders"("tenant_id", "number");

-- AddForeignKey
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_tenant_id_store_id_fkey" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- Hand-written part
-- =====================================================================

ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_amounts_check"
  CHECK ("subtotal" >= 0 AND "delivery_fee" >= 0 AND "total" = "subtotal" + "delivery_fee");

ALTER TABLE "customer_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_orders"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
