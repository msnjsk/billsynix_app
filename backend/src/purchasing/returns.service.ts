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
import { assertActive, visibleStore } from '../inventory/inventory.common.js';
import { docTotals, lineAmounts, totalsView } from './purchase-math.js';
import {
  dateOnly,
  dateStr,
  nextNumber,
  notFound,
  postSupplierEntry,
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
import type {
  CreateReturnInput,
  ListReturnsQuery,
} from './purchasing.schemas.js';

const include = {
  supplier: { select: { name: true, gstin: true } },
  store: { select: { code: true, name: true } },
  grn: { select: { number: true } },
  items: {
    include: { product: { select: { sku: true, name: true } } },
    orderBy: [{ product: { name: 'asc' as const } }, { id: 'asc' as const }],
  },
} satisfies Prisma.PurchaseReturnInclude;
type ReturnRow = Prisma.PurchaseReturnGetPayload<{ include: typeof include }>;

/**
 * Purchase returns with a debit note. Goods taken from stock post PURCHASE_RETURN (at the receipt's
 * cost when returned against a receipt line, else at the average); goods that arrived damaged never
 * entered stock, so only the debit note is issued. Either way the debit note reduces what we owe.
 * A receipt line can't be returned beyond what it brought (accepted, or damaged for fromDamaged).
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  view(r: ReturnRow) {
    return {
      id: r.id,
      number: r.number,
      supplier: {
        id: r.supplierId,
        name: r.supplier.name,
        gstin: r.supplier.gstin,
      },
      store: { id: r.storeId, code: r.store.code, name: r.store.name },
      grn: r.grnId ? { id: r.grnId, number: r.grn?.number ?? null } : null,
      returnDate: dateStr(r.returnDate),
      reason: r.reason,
      notes: r.notes,
      gstApplies: r.gstApplies,
      interState: r.interState,
      totals: totalsView(r),
      items: r.items.map((i) => ({
        id: i.id,
        product: { id: i.productId, sku: i.product.sku, name: i.product.name },
        grnItemId: i.grnItemId,
        fromDamaged: i.fromDamaged,
        batchId: i.batchId,
        qty: i.qty.toFixed(3),
        rate: i.rate.toFixed(2),
        discountPct: Number(i.discountPct),
        gstRate: Number(i.gstRate),
        cessRate: Number(i.cessRate),
        taxable: i.taxable.toFixed(2),
        tax: i.tax.toFixed(2),
      })),
      createdByUserId: r.createdByUserId,
      createdAt: r.createdAt,
    };
  }

  private async load(tx: Tx, auth: AuthContext, id: string) {
    const r = await tx.purchaseReturn.findFirst({
      where: { id, tenantId: auth.tenantId },
      include,
    });
    if (!r || !canAccessStore(auth, r.storeId))
      throw notFound('Purchase return');
    return r;
  }

  list(auth: AuthContext, q: ListReturnsQuery) {
    assertPermission(auth, 'purchases:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (q.storeId && !canAccessStore(auth, q.storeId))
        throw notFound('Branch');
      const where: Prisma.PurchaseReturnWhereInput = {
        tenantId: auth.tenantId,
        ...(q.supplierId && { supplierId: q.supplierId }),
        ...(q.storeId
          ? { storeId: q.storeId }
          : auth.storeIds === 'ALL'
            ? {}
            : { storeId: { in: [...auth.storeIds] } }),
      };
      const rows = await tx.purchaseReturn.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      });
      const total = await tx.purchaseReturn.count({ where });
      return page(
        rows.map((r) => this.view(r)),
        total,
        q,
      );
    });
  }

  get(auth: AuthContext, id: string) {
    assertPermission(auth, 'purchases:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) =>
      this.view(await this.load(tx, auth, id)),
    );
  }

  create(
    auth: AuthContext,
    input: CreateReturnInput,
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
          { route: 'POST purchase-returns', body: input },
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

            const grnItemIds = input.items.flatMap((i) =>
              i.grnItemId ? [i.grnItemId] : [],
            );
            const grnItems = new Map(
              (
                await tx.goodsReceiptItem.findMany({
                  where: { tenantId: auth.tenantId, id: { in: grnItemIds } },
                  include: {
                    grn: {
                      select: {
                        id: true,
                        supplierId: true,
                        storeId: true,
                        gstApplies: true,
                        interState: true,
                      },
                    },
                  },
                })
              ).map((g) => [g.id, g]),
            );
            // Already returned per receipt line, split into damaged / from stock.
            const prior = await tx.purchaseReturnItem.groupBy({
              by: ['grnItemId', 'fromDamaged'],
              where: { tenantId: auth.tenantId, grnItemId: { in: grnItemIds } },
              _sum: { qty: true },
            });
            const returned = (id: string, damaged: boolean) =>
              prior.find((p) => p.grnItemId === id && p.fromDamaged === damaged)
                ?._sum.qty ?? new Decimal(0);

            let grnId = input.grnId ?? null;
            if (grnId) {
              const g = await tx.goodsReceipt.findFirst({
                where: { id: grnId, tenantId: auth.tenantId },
              });
              if (!g || g.supplierId !== supplier.id || g.storeId !== store.id)
                throw unprocessable(
                  'INVALID_REFERENCE',
                  'That receipt is for another supplier or branch.',
                  'grnId',
                );
            } else {
              const grns = new Set([...grnItems.values()].map((g) => g.grnId));
              if (grns.size === 1 && grnItemIds.length === input.items.length)
                grnId = [...grns][0]!;
            }

            // GST follows the original receipt when there is one, else today's supplier/branch.
            const firstGrn = [...grnItems.values()][0]?.grn;
            const ctx = firstGrn
              ? {
                  gstApplies: firstGrn.gstApplies,
                  interState: firstGrn.interState,
                }
              : gstContext(supplier, store, tenant.registration);
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
            const using = new Map<string, Decimal>();

            const rows = input.items.map((it, n) => {
              const f = `items.${n}`;
              const p = products.get(it.productId);
              if (!p)
                throw unprocessable(
                  'INVALID_REFERENCE',
                  'Product not found.',
                  `${f}.productId`,
                );
              const qty = new Decimal(it.qty);
              assertQty(p, qty, `${f}.qty`);
              const gi = it.grnItemId ? grnItems.get(it.grnItemId) : undefined;
              if (it.grnItemId) {
                if (
                  !gi ||
                  gi.productId !== p.id ||
                  gi.grn.supplierId !== supplier.id ||
                  gi.grn.storeId !== store.id
                )
                  throw unprocessable(
                    'INVALID_REFERENCE',
                    'That receipt line is not this product from this supplier and branch.',
                    `${f}.grnItemId`,
                  );
                if (grnId && gi.grnId !== grnId)
                  throw unprocessable(
                    'INVALID_REFERENCE',
                    'That receipt line is on another receipt.',
                    `${f}.grnItemId`,
                  );
                const k = `${gi.id}:${it.fromDamaged}`;
                const taken = (using.get(k) ?? new Decimal(0)).plus(qty);
                using.set(k, taken);
                const cap = (
                  it.fromDamaged ? gi.damagedQty : gi.acceptedQty
                ).minus(returned(gi.id, it.fromDamaged));
                if (taken.gt(cap))
                  throw unprocessable(
                    'OVER_RETURN',
                    `Only ${Decimal.max(0, cap).toFixed(3)} ${it.fromDamaged ? 'damaged ' : ''}of ${p.name} from that receipt can still be returned.`,
                    `${f}.qty`,
                  );
              } else if (it.fromDamaged) {
                throw unprocessable(
                  'GRN_ITEM_REQUIRED',
                  'Damaged goods are returned against their receipt line.',
                  `${f}.grnItemId`,
                );
              }
              const priced = priceLine(p, it, f, costs.get(p.id), gi);
              const a = lineAmounts({ qty, ...priced }, ctx.gstApplies);
              return {
                productId: p.id,
                grnItemId: gi?.id ?? null,
                fromDamaged: it.fromDamaged,
                batchId: it.batchId ?? gi?.batchId ?? null,
                qty,
                rate: priced.rate,
                discountPct: priced.discountPct,
                gstRate: priced.gstRate,
                cessRate: priced.cessRate,
                taxable: a.taxable,
                tax: a.gst.plus(a.cess),
                unitCost: gi?.unitCost ?? null,
                stocked: p.trackInventory,
              };
            });

            const totals = docTotals(rows, ctx.gstApplies, ctx.interState);
            const returnDate = input.returnDate ?? todayIn(tenant.timezone);
            const number = await nextNumber(tx, auth.tenantId, 'DN');
            const ret = await tx.purchaseReturn.create({
              data: {
                tenantId: auth.tenantId,
                number,
                supplierId: supplier.id,
                storeId: store.id,
                grnId,
                returnDate: dateOnly(returnDate),
                reason: input.reason,
                notes: input.notes ?? null,
                gstApplies: ctx.gstApplies,
                interState: ctx.interState,
                ...totals,
                createdByUserId: auth.userId,
              },
            });
            await tx.purchaseReturnItem.createMany({
              data: rows.map(({ unitCost: _u, stocked: _s, ...r }) => ({
                tenantId: auth.tenantId,
                returnId: ret.id,
                ...r,
              })),
            });
            await this.ledger.post(tx, {
              tenantId: auth.tenantId,
              storeId: store.id,
              refType: 'PURCHASE_RETURN',
              refId: ret.id,
              userId: auth.userId,
              lines: rows
                .filter((r) => !r.fromDamaged && r.stocked)
                .map((r) => ({
                  productId: r.productId,
                  batchId: r.batchId,
                  qty: r.qty.negated(),
                  type: 'PURCHASE_RETURN' as const,
                  unitCost: r.unitCost,
                  reason: input.reason,
                  note: number,
                })),
            });
            await postSupplierEntry(tx, {
              tenantId: auth.tenantId,
              supplierId: supplier.id,
              type: 'RETURN',
              amount: totals.total.negated(),
              date: dateOnly(returnDate),
              refType: 'PURCHASE_RETURN',
              refId: ret.id,
              refNo: number,
              note: `Debit note — ${input.reason.toLowerCase().replace('_', ' ')}`,
              userId: auth.userId,
            });
            await this.audit.record(
              {
                tenantId: auth.tenantId,
                actorUserId: auth.userId,
                action: 'purchase_return.posted',
                entity: 'purchase_return',
                entityId: ret.id,
                data: { number, total: totals.total.toFixed(2), grnId },
                meta,
              },
              tx,
            );
            return this.view(await this.load(tx, auth, ret.id));
          },
        ),
      { timeout: 60_000 },
    );
  }
}
