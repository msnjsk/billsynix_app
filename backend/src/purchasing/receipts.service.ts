import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Decimal } from '../common/decimal.js';
import { idempotent } from '../common/idempotency.js';
import { page, skipTake } from '../common/schemas.js';
import {
  assertPermission,
  canAccessStore,
  type AuthContext,
} from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Prisma } from '../generated/prisma/client.js';
import { LedgerService } from '../inventory/ledger.service.js';
import {
  assertActive,
  resolveBatch,
  visibleStore,
} from '../inventory/inventory.common.js';
import {
  docTotals,
  lineAmounts,
  netRate,
  stockUnitCost,
  totalsView,
} from './purchase-math.js';
import {
  addDays,
  canSeePayables,
  conflict,
  dateOnly,
  dateStr,
  nextNumber,
  notFound,
  postSupplierEntry,
  receiptOutstanding,
  todayIn,
  unprocessable,
} from './purchasing.common.js';
import {
  assertQty,
  gstContext,
  loadProducts,
  priceLine,
  supplierCosts,
} from './lines.js';
import type { CreateGrnInput, ListGrnQuery } from './purchasing.schemas.js';

export type MatchIssue = {
  productId: string;
  name: string;
  kind: 'NOT_ORDERED' | 'OVER_RECEIPT' | 'PRICE';
  detail: string;
};

const include = {
  supplier: { select: { name: true, gstin: true } },
  store: { select: { code: true, name: true } },
  po: { select: { number: true } },
  items: {
    include: {
      product: {
        select: { sku: true, name: true, unit: { select: { code: true } } },
      },
      batch: { select: { batchNo: true, expiryDate: true } },
    },
    orderBy: [{ product: { name: 'asc' as const } }, { id: 'asc' as const }],
  },
} satisfies Prisma.GoodsReceiptInclude;
type GrnRow = Prisma.GoodsReceiptGetPayload<{ include: typeof include }>;

/**
 * Goods receipts (GRN). One receipt is the delivery plus the supplier's invoice, and posting it is
 * a single transaction that:
 *   • adds the accepted quantity (received − damaged) to stock as PURCHASE_RECEIPT, at cost;
 *   • adds the invoice value (received quantity) to what we owe the supplier;
 *   • moves the PO's received quantities and status (PARTIAL / RECEIVED);
 *   • records the supplier's latest price and the product's last purchase cost.
 * Mismatches with the PO (not ordered, more than outstanding, price above PO + 0.5%) are recorded
 * on the receipt as `matchIssues` — they don't block it. Damaged goods are returned with a
 * purchase return (`fromDamaged`), which issues the debit note.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  view(auth: AuthContext, g: GrnRow, outstanding?: Decimal) {
    return {
      id: g.id,
      number: g.number,
      supplier: {
        id: g.supplierId,
        name: g.supplier.name,
        gstin: g.supplier.gstin,
      },
      store: { id: g.storeId, code: g.store.code, name: g.store.name },
      po: g.poId ? { id: g.poId, number: g.po?.number ?? null } : null,
      receivedDate: dateStr(g.receivedDate),
      supplierInvoiceNo: g.supplierInvoiceNo,
      supplierInvoiceDate: dateStr(g.supplierInvoiceDate),
      dueDate: dateStr(g.dueDate),
      gstApplies: g.gstApplies,
      interState: g.interState,
      totals: totalsView(g),
      ...(canSeePayables(auth) && outstanding
        ? { outstanding: outstanding.toFixed(2) }
        : {}),
      matchIssues: g.matchIssues as MatchIssue[],
      notes: g.notes,
      items: g.items.map((i) => ({
        id: i.id,
        product: {
          id: i.productId,
          sku: i.product.sku,
          name: i.product.name,
          unit: i.product.unit.code,
        },
        poItemId: i.poItemId,
        orderedQty: i.orderedQty?.toFixed(3) ?? null,
        receivedQty: i.receivedQty.toFixed(3),
        damagedQty: i.damagedQty.toFixed(3),
        acceptedQty: i.acceptedQty.toFixed(3),
        rate: i.rate.toFixed(2),
        discountPct: Number(i.discountPct),
        gstRate: Number(i.gstRate),
        cessRate: Number(i.cessRate),
        hsnCode: i.hsnCode,
        batch: i.batchId
          ? {
              id: i.batchId,
              batchNo: i.batch?.batchNo ?? null,
              expiryDate: dateStr(i.batch?.expiryDate),
            }
          : null,
        unitCost: i.unitCost.toFixed(4),
        taxable: i.taxable.toFixed(2),
        tax: i.tax.toFixed(2),
      })),
      createdByUserId: g.createdByUserId,
      createdAt: g.createdAt,
    };
  }

  async load(tx: Tx, auth: AuthContext, id: string) {
    const g = await tx.goodsReceipt.findFirst({
      where: { id, tenantId: auth.tenantId },
      include,
    });
    if (!g || !canAccessStore(auth, g.storeId)) throw notFound('Goods receipt');
    return g;
  }

  list(auth: AuthContext, q: ListGrnQuery) {
    assertPermission(auth, 'purchases:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (q.storeId && !canAccessStore(auth, q.storeId))
        throw notFound('Branch');
      const where: Prisma.GoodsReceiptWhereInput = {
        tenantId: auth.tenantId,
        ...(q.supplierId && { supplierId: q.supplierId }),
        ...(q.poId && { poId: q.poId }),
        ...(q.storeId
          ? { storeId: q.storeId }
          : auth.storeIds === 'ALL'
            ? {}
            : { storeId: { in: [...auth.storeIds] } }),
      };
      if (q.unpaid) {
        const all = await tx.goodsReceipt.findMany({
          where,
          select: { id: true },
        });
        const out = await receiptOutstanding(
          tx,
          auth.tenantId,
          all.map((g) => g.id),
        );
        where.id = { in: [...out].filter(([, v]) => v.gt(0)).map(([k]) => k) };
      }
      const rows = await tx.goodsReceipt.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      });
      const total = await tx.goodsReceipt.count({ where });
      const out = await receiptOutstanding(
        tx,
        auth.tenantId,
        rows.map((r) => r.id),
      );
      return page(
        rows.map((g) => this.view(auth, g, out.get(g.id))),
        total,
        q,
      );
    });
  }

  get(auth: AuthContext, id: string) {
    assertPermission(auth, 'purchases:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const g = await this.load(tx, auth, id);
      const out = await receiptOutstanding(tx, auth.tenantId, [g.id]);
      return this.view(auth, g, out.get(g.id));
    });
  }

  create(
    auth: AuthContext,
    input: CreateGrnInput,
    key: string,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'purchases:write');
    return this.prisma.withTenant(
      auth.tenantId,
      (tx) =>
        idempotent(
          tx,
          auth.tenantId,
          key,
          { route: 'POST goods-receipts', body: input },
          201,
          async () => {
            const store = await visibleStore(tx, auth, input.storeId);
            assertActive(store);
            const supplier = await tx.supplier.findFirst({
              where: { id: input.supplierId, tenantId: auth.tenantId },
            });
            if (!supplier)
              throw unprocessable(
                'INVALID_REFERENCE',
                'Supplier not found.',
                'supplierId',
              );
            const tenant = await tx.tenant.findUniqueOrThrow({
              where: { id: auth.tenantId },
              select: { registration: true, timezone: true },
            });

            // The PO, locked so two receipts against it can't both count the same outstanding qty.
            let po: {
              id: string;
              status: string;
              items: {
                id: string;
                productId: string;
                qty: Decimal;
                receivedQty: Decimal;
                rate: Decimal;
                discountPct: Decimal;
                gstRate: Decimal;
                cessRate: Decimal;
              }[];
            } | null = null;
            if (input.poId) {
              const locked = await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM purchase_orders WHERE id = ${input.poId}::uuid AND tenant_id = ${auth.tenantId}::uuid FOR UPDATE`;
              const found = locked.length
                ? await tx.purchaseOrder.findFirst({
                    where: { id: input.poId, tenantId: auth.tenantId },
                    include: { items: true },
                  })
                : null;
              if (!found)
                throw unprocessable(
                  'INVALID_REFERENCE',
                  'Purchase order not found.',
                  'poId',
                );
              if (
                found.supplierId !== supplier.id ||
                found.storeId !== store.id
              )
                throw unprocessable(
                  'PO_MISMATCH',
                  'That purchase order is for another supplier or branch.',
                  'poId',
                );
              if (found.status !== 'SENT' && found.status !== 'PARTIAL')
                throw conflict(
                  'PO_NOT_OPEN',
                  `Purchase order ${found.number} is ${found.status.toLowerCase().replace('_', ' ')}.`,
                );
              po = found;
            }

            if (input.supplierInvoiceNo) {
              const dup = await tx.goodsReceipt.findFirst({
                where: {
                  tenantId: auth.tenantId,
                  supplierId: supplier.id,
                  supplierInvoiceNo: {
                    equals: input.supplierInvoiceNo,
                    mode: 'insensitive',
                  },
                },
                select: { number: true },
              });
              if (dup)
                throw conflict(
                  'DUPLICATE_INVOICE',
                  `Invoice ${input.supplierInvoiceNo} of ${supplier.name} was already entered on ${dup.number}.`,
                );
            }

            const ctx = gstContext(supplier, store, tenant.registration);
            const products = await loadProducts(
              tx,
              auth.tenantId,
              input.items.map((i) => i.productId),
            );
            const costs = await supplierCosts(
              tx,
              auth.tenantId,
              supplier.id,
              input.items.map((i) => i.productId),
            );
            const issues: MatchIssue[] = [];
            const poProgress = new Map<string, Decimal>();
            const rows: (Omit<
              Prisma.GoodsReceiptItemCreateManyInput,
              'tenantId' | 'grnId'
            > & { accepted: Decimal; tracked: boolean })[] = [];

            for (const [n, it] of input.items.entries()) {
              const f = `items.${n}`;
              const p = products.get(it.productId);
              if (!p)
                throw unprocessable(
                  'INVALID_REFERENCE',
                  'Product not found.',
                  `${f}.productId`,
                );
              const received = new Decimal(it.receivedQty);
              const damaged = new Decimal(it.damagedQty);
              assertQty(p, received, `${f}.receivedQty`);
              assertQty(p, damaged, `${f}.damagedQty`);
              if (damaged.gt(received))
                throw unprocessable(
                  'INVALID_QTY',
                  'Damaged is more than received.',
                  `${f}.damagedQty`,
                );
              const accepted = received.minus(damaged);

              let poItem: NonNullable<typeof po>['items'][number] | undefined;
              if (po) {
                poItem = it.poItemId
                  ? po.items.find((x) => x.id === it.poItemId)
                  : po.items.find((x) => x.productId === p.id);
                if (it.poItemId && (!poItem || poItem.productId !== p.id))
                  throw unprocessable(
                    'INVALID_REFERENCE',
                    'That PO line is for another product.',
                    `${f}.poItemId`,
                  );
              } else if (it.poItemId) {
                throw unprocessable(
                  'INVALID_REFERENCE',
                  'poItemId needs poId.',
                  `${f}.poItemId`,
                );
              }
              const priced = priceLine(p, it, f, costs.get(p.id), poItem);
              let orderedQty: Decimal | null = null;
              if (po && !poItem) {
                issues.push({
                  productId: p.id,
                  name: p.name,
                  kind: 'NOT_ORDERED',
                  detail: 'Received but not on the purchase order',
                });
              } else if (poItem) {
                const already = poProgress.get(poItem.id) ?? poItem.receivedQty;
                orderedQty = Decimal.max(0, poItem.qty.minus(already));
                if (accepted.gt(orderedQty))
                  issues.push({
                    productId: p.id,
                    name: p.name,
                    kind: 'OVER_RECEIPT',
                    detail: `Accepted ${accepted.toFixed(3)}, outstanding on PO ${orderedQty.toFixed(3)}`,
                  });
                poProgress.set(poItem.id, already.plus(accepted));
                const poNet = netRate(poItem);
                if (netRate(priced).gt(poNet.times(1.005)))
                  issues.push({
                    productId: p.id,
                    name: p.name,
                    kind: 'PRICE',
                    detail: `Billed ₹${netRate(priced).toFixed(2)}, PO ₹${poNet.toFixed(2)}`,
                  });
              }

              let batchId: string | null = null;
              if (p.tracksBatches && p.trackInventory) {
                if (!it.batchNo && accepted.gt(0))
                  throw unprocessable(
                    'BATCH_REQUIRED',
                    `Give the batch number of ${p.name}.`,
                    `${f}.batchNo`,
                  );
                if (it.batchNo)
                  batchId =
                    (await resolveBatch(
                      tx,
                      auth.tenantId,
                      p.id,
                      { batchNo: it.batchNo, expiryDate: it.expiryDate },
                      `${f}.batchNo`,
                      true,
                    )) ?? null;
                if (batchId && it.mfgDate)
                  await tx.productBatch.updateMany({
                    where: { id: batchId, mfgDate: null },
                    data: { mfgDate: dateOnly(it.mfgDate) },
                  });
              } else if (it.batchNo) {
                throw unprocessable(
                  'NOT_BATCH_TRACKED',
                  `${p.name} isn't tracked by batch.`,
                  `${f}.batchNo`,
                );
              }

              const a = lineAmounts(
                { qty: received, ...priced },
                ctx.gstApplies,
              );
              rows.push({
                productId: p.id,
                poItemId: poItem?.id ?? null,
                orderedQty,
                receivedQty: received,
                damagedQty: damaged,
                acceptedQty: accepted,
                rate: priced.rate,
                discountPct: priced.discountPct,
                gstRate: priced.gstRate,
                cessRate: priced.cessRate,
                hsnCode: priced.hsnCode,
                batchId,
                unitCost: stockUnitCost(
                  { qty: received, ...priced },
                  ctx.gstApplies,
                  ctx.creditClaimable,
                ),
                taxable: a.taxable,
                tax: a.gst.plus(a.cess),
                accepted,
                tracked: p.trackInventory,
              });
            }

            const totals = docTotals(
              rows.map((r) => ({
                qty: r.receivedQty as Decimal,
                rate: r.rate as Decimal,
                discountPct: r.discountPct as Decimal,
                gstRate: r.gstRate as Decimal,
                cessRate: r.cessRate as Decimal,
              })),
              ctx.gstApplies,
              ctx.interState,
            );
            const receivedDate = input.receivedDate ?? todayIn(tenant.timezone);
            const number = await nextNumber(tx, auth.tenantId, 'GRN');
            const grn = await tx.goodsReceipt.create({
              data: {
                tenantId: auth.tenantId,
                number,
                supplierId: supplier.id,
                storeId: store.id,
                poId: po?.id ?? null,
                receivedDate: dateOnly(receivedDate),
                supplierInvoiceNo: input.supplierInvoiceNo ?? null,
                supplierInvoiceDate: input.supplierInvoiceDate
                  ? dateOnly(input.supplierInvoiceDate)
                  : null,
                dueDate: dateOnly(
                  input.dueDate ??
                    addDays(
                      input.supplierInvoiceDate ?? receivedDate,
                      supplier.creditDays,
                    ),
                ),
                gstApplies: ctx.gstApplies,
                interState: ctx.interState,
                ...totals,
                matchIssues: issues,
                notes: input.notes ?? null,
                createdByUserId: auth.userId,
              },
            });
            await tx.goodsReceiptItem.createMany({
              data: rows.map(({ accepted: _a, tracked: _t, ...r }) => ({
                tenantId: auth.tenantId,
                grnId: grn.id,
                ...r,
              })),
            });

            // 1. Stock.
            await this.ledger.post(tx, {
              tenantId: auth.tenantId,
              storeId: store.id,
              refType: 'GRN',
              refId: grn.id,
              userId: auth.userId,
              lines: rows
                .filter((r) => r.tracked && r.accepted.gt(0))
                .map((r) => ({
                  productId: r.productId,
                  batchId: r.batchId,
                  qty: r.accepted,
                  type: 'PURCHASE_RECEIPT' as const,
                  unitCost: r.unitCost as Decimal,
                  note: number,
                })),
            });

            // 2. The PO.
            if (po) {
              for (const [itemId, qty] of poProgress)
                await tx.purchaseOrderItem.update({
                  where: { id: itemId },
                  data: { receivedQty: qty },
                });
              const items = await tx.purchaseOrderItem.findMany({
                where: { tenantId: auth.tenantId, poId: po.id },
              });
              const done = items.every((i) => i.receivedQty.gte(i.qty));
              const any = items.some((i) => i.receivedQty.gt(0));
              await tx.purchaseOrder.update({
                where: { id: po.id },
                data: { status: done ? 'RECEIVED' : any ? 'PARTIAL' : 'SENT' },
              });
            }

            // 3. Supplier prices and products' last purchase cost.
            const now = new Date();
            for (const r of rows) {
              const net = netRate({
                rate: r.rate as Decimal,
                discountPct: r.discountPct as Decimal,
              }).toDecimalPlaces(2);
              await tx.supplierProduct.upsert({
                where: {
                  supplierId_productId: {
                    supplierId: supplier.id,
                    productId: r.productId,
                  },
                },
                create: {
                  tenantId: auth.tenantId,
                  supplierId: supplier.id,
                  productId: r.productId,
                  cost: net,
                  lastPurchasedAt: now,
                },
                update: { cost: net, lastPurchasedAt: now },
              });
              await tx.product.update({
                where: { id: r.productId },
                data: { purchaseCost: net, version: { increment: 1 } },
              });
            }

            // 4. The payable.
            await postSupplierEntry(tx, {
              tenantId: auth.tenantId,
              supplierId: supplier.id,
              type: 'PURCHASE',
              amount: totals.total,
              date: dateOnly(input.supplierInvoiceDate ?? receivedDate),
              refType: 'GRN',
              refId: grn.id,
              refNo: number,
              note: input.supplierInvoiceNo
                ? `Invoice ${input.supplierInvoiceNo}`
                : null,
              userId: auth.userId,
            });

            await this.audit.record(
              {
                tenantId: auth.tenantId,
                actorUserId: auth.userId,
                action: 'goods_receipt.posted',
                entity: 'goods_receipt',
                entityId: grn.id,
                data: {
                  number,
                  poId: po?.id ?? null,
                  total: totals.total.toFixed(2),
                  lines: rows.length,
                  issues: issues.length,
                },
                meta,
              },
              tx,
            );
            return this.view(
              auth,
              await this.load(tx, auth, grn.id),
              totals.total,
            );
          },
        ),
      { timeout: 60_000 },
    );
  }
}
