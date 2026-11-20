-- An order and the bill made for it at the POS (one bill per order).
ALTER TABLE "customer_orders" ADD COLUMN     "sale_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "customer_orders_sale_id_key" ON "customer_orders"("sale_id");

-- AddForeignKey
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_tenant_id_sale_id_fkey" FOREIGN KEY ("tenant_id", "sale_id") REFERENCES "sales"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;