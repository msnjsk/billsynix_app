-- CreateEnum
CREATE TYPE "SyncEventType" AS ENUM ('CASH_SESSION_OPEN', 'SALE');

-- CreateEnum
CREATE TYPE "SyncEventStatus" AS ENUM ('ACCEPTED', 'FAILED', 'DISCARDED');

-- AlterTable
ALTER TABLE "cash_sessions" ADD COLUMN     "offline" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "device_id" UUID,
ADD COLUMN     "offline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "synced_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "terminal_devices" ADD COLUMN     "app_version" TEXT,
ADD COLUMN     "clock_skew_seconds" INTEGER,
ADD COLUMN     "last_sync_at" TIMESTAMPTZ(3),
ADD COLUMN     "queue_failed" INTEGER,
ADD COLUMN     "queue_oldest_at" TIMESTAMPTZ(3),
ADD COLUMN     "queue_pending" INTEGER;

-- CreateTable
CREATE TABLE "invoice_blocks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "counter_id" UUID NOT NULL,
    "fy" CHAR(4) NOT NULL,
    "from_seq" INTEGER NOT NULL,
    "to_seq" INTEGER NOT NULL,
    "highest_used" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "closed_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "counter_id" UUID NOT NULL,
    "type" "SyncEventType" NOT NULL,
    "status" "SyncEventStatus" NOT NULL,
    "request_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "cashier_user_id" UUID NOT NULL,
    "sale_id" UUID,
    "cash_session_id" UUID,
    "result" JSONB,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "error_code" TEXT,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "reviewed_at" TIMESTAMPTZ(3),
    "reviewed_by_user_id" UUID,
    "review_note" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "sync_events_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "seq" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_blocks_tenant_id_device_id_idx" ON "invoice_blocks"("tenant_id", "device_id");

-- CreateIndex
CREATE INDEX "invoice_blocks_counter_id_fy_idx" ON "invoice_blocks"("counter_id", "fy");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_blocks_tenant_id_id_key" ON "invoice_blocks"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "sync_events_tenant_id_store_id_needs_review_idx" ON "sync_events"("tenant_id", "store_id", "needs_review");

-- CreateIndex
CREATE INDEX "sync_events_tenant_id_device_id_status_idx" ON "sync_events"("tenant_id", "device_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_seq_key" ON "outbox_events"("seq");

-- CreateIndex
CREATE INDEX "outbox_events_processed_at_seq_idx" ON "outbox_events"("processed_at", "seq");

-- CreateIndex
CREATE INDEX "outbox_events_tenant_id_topic_created_at_idx" ON "outbox_events"("tenant_id", "topic", "created_at");

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_device_id_fkey" FOREIGN KEY ("tenant_id", "device_id") REFERENCES "terminal_devices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_blocks" ADD CONSTRAINT "invoice_blocks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_blocks" ADD CONSTRAINT "invoice_blocks_tenant_id_device_id_fkey" FOREIGN KEY ("tenant_id", "device_id") REFERENCES "terminal_devices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_blocks" ADD CONSTRAINT "invoice_blocks_tenant_id_counter_id_fkey" FOREIGN KEY ("tenant_id", "counter_id") REFERENCES "counters"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_tenant_id_device_id_fkey" FOREIGN KEY ("tenant_id", "device_id") REFERENCES "terminal_devices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- Hand-written part
-- =====================================================================

-- A reserved range sits inside one year's 5-digit series.
ALTER TABLE "invoice_blocks" ADD CONSTRAINT "invoice_blocks_range_check"
  CHECK ("from_seq" >= 1 AND "to_seq" >= "from_seq" AND "to_seq" <= 99999
         AND "used_count" >= 0 AND "used_count" <= "to_seq" - "from_seq" + 1
         AND ("highest_used" IS NULL OR "highest_used" BETWEEN "from_seq" AND "to_seq"));
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_attempts_check" CHECK ("attempts" >= 1);
-- An offline sale names the device that billed it.
ALTER TABLE "sales" ADD CONSTRAINT "sales_offline_device_check" CHECK (NOT "offline" OR "device_id" IS NOT NULL);
CREATE INDEX "sales_tenant_id_device_id_idx" ON "sales" ("tenant_id", "device_id") WHERE "device_id" IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice_blocks', 'sync_events', 'outbox_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
