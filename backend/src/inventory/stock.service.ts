import { Injectable } from '@nestjs/common';
import { PrismaService, inOrder } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Decimal } from '../common/decimal.js';
import { page, skipTake } from '../common/schemas.js';
import { assertPermission, type AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Prisma } from '../generated/prisma/client.js';
import { TaxonomyService } from '../catalogue/taxonomy.service.js';
import { alreadyExists } from '../catalogue/catalogue.errors.js';
import {
  costStr,
  dateStr,
  movementView,
  notFound,
  qtyStr,
  showCost,
  storeFilter,
  unprocessable,
  valueStr,
  visibleStore,
} from './inventory.common.js';
import type {
  AlertsQuery,
  CreateBatchInput,
  MovementsQuery,
  ReorderInput,
  StockListQuery,
} from './inventory.schemas.js';

/** Branch stock views, reorder levels, batches, alerts and the ledger check. */
@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  /** Quantity on its way into a branch, per product (dispatched, not yet received). */
  private async inTransitTo(
    tx: Prisma.TransactionClient,
    tenantId: string,
    storeId: string,
    productIds?: string[],
  ) {
    const rows = await tx.stockTransferItem.groupBy({
      by: ['productId'],
      where: {
        tenantId,
        transfer: { toStoreId: storeId, status: 'IN_TRANSIT' },
        ...(productIds ? { productId: { in: productIds } } : {}),
      },
      _sum: { dispatchedQty: true },
    });
    return new Map(
      rows.map((r) => [r.productId, r._sum.dispatchedQty ?? new Decimal(0)]),
    );
  }

  list(auth: AuthContext, storeId: string, q: StockListQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const store = await visibleStore(tx, auth, storeId);
      const where: Prisma.ProductWhereInput = {
        tenantId: auth.tenantId,
        trackInventory: true,
        status: 'ACTIVE',
      };
      if (q.categoryId) {
        const tree = await this.taxonomy.categoryTree(tx, auth.tenantId);
        where.categoryId = tree.byId.has(q.categoryId)
          ? { in: tree.subtree(q.categoryId) }
          : q.categoryId;
      }
      const words = (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 8);
      if (words.length)
        where.AND = words.map((w) => ({
          OR: [
            { name: { contains: w, mode: 'insensitive' as const } },
            { sku: { startsWith: w.toUpperCase() } },
            { barcodes: { some: { code: w.toUpperCase() } } },
          ],
        }));
      const here = { storeId: store.id };
      if (q.status === 'IN_STOCK')
        where.stockBalances = { some: { ...here, qty: { gt: 0 } } };
      if (q.status === 'OUT')
        where.NOT = { stockBalances: { some: { ...here, qty: { gt: 0 } } } };
      if (q.status === 'LOW')
        where.stockBalances = {
          some: {
            ...here,
            reorderLevel: { not: null },
            qty: { lte: this.prisma.stockBalance.fields.reorderLevel },
          },
        };
      const [rows, total] = await inOrder(
        () =>
          tx.product.findMany({
            where,
            include: { unit: true, stockBalances: { where: here } },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            ...skipTake(q),
          }),
        () => tx.product.count({ where }),
      );
      const transit = await this.inTransitTo(
        tx,
        auth.tenantId,
        store.id,
        rows.map((r) => r.id),
      );
      const cost = showCost(auth);
      return page(
        rows.map((p) => {
          const b = p.stockBalances[0];
          const qty = b?.qty ?? new Decimal(0);
          const low = b?.reorderLevel != null && qty.lte(b.reorderLevel);
          return {
            product: {
              id: p.id,
              sku: p.sku,
              name: p.name,
              unit: p.unit.code,
              tracksBatches: p.tracksBatches,
            },
            qty: qty.toFixed(3),
            status: qty.lte(0) ? 'OUT' : low ? 'LOW' : 'OK',
            reorderLevel: qtyStr(b?.reorderLevel),
            reorderQty: qtyStr(b?.reorderQty),
            inTransitIn: (transit.get(p.id) ?? new Decimal(0)).toFixed(3),
            ...(cost
              ? {
                  avgCost: costStr(b?.avgCost ?? new Decimal(0)),
                  value: valueStr(qty.times(b?.avgCost ?? 0)),
                }
              : {}),
          };
        }),
        total,
        q,
      );
    });
  }

  detail(auth: AuthContext, storeId: string, productId: string) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const store = await visibleStore(tx, auth, storeId);
      const p = await tx.product.findFirst({
        where: { id: productId, tenantId: auth.tenantId },
        include: { unit: true },
      });
      if (!p) throw notFound('Product');
      const [b, batches, outgoing] = await inOrder(
        () =>
          tx.stockBalance.findUnique({
            where: { storeId_productId: { storeId: store.id, productId } },
          }),
        () =>
          tx.batchStock.findMany({
            where: {
              tenantId: auth.tenantId,
              storeId: store.id,
              productId,
              qty: { gt: 0 },
            },
            include: { batch: true },
          }),
        () =>
          tx.stockTransferItem.aggregate({
            where: {
              tenantId: auth.tenantId,
              productId,
              transfer: { fromStoreId: store.id, status: 'IN_TRANSIT' },
            },
            _sum: { dispatchedQty: true },
          }),
      );
      const transit = await this.inTransitTo(tx, auth.tenantId, store.id, [
        productId,
      ]);
      const cost = showCost(auth);
      return {
        storeId: store.id,
        product: {
          id: p.id,
          sku: p.sku,
          name: p.name,
          unit: p.unit.code,
          tracksBatches: p.tracksBatches,
        },
        qty: (b?.qty ?? new Decimal(0)).toFixed(3),
        reorderLevel: qtyStr(b?.reorderLevel),
        reorderQty: qtyStr(b?.reorderQty),
        inTransitIn: (transit.get(productId) ?? new Decimal(0)).toFixed(3),
        inTransitOut: (outgoing._sum.dispatchedQty ?? new Decimal(0)).toFixed(
          3,
        ),
        ...(cost ? { avgCost: costStr(b?.avgCost ?? new Decimal(0)) } : {}),
        batches: batches
          .sort(
            (x, y) =>
              (x.batch.expiryDate?.getTime() ?? Infinity) -
              (y.batch.expiryDate?.getTime() ?? Infinity),
          )
          .map((s) => ({
            batchId: s.batchId,
            batchNo: s.batch.batchNo,
            expiryDate: dateStr(s.batch.expiryDate),
            qty: s.qty.toFixed(3),
          })),
      };
    });
  }

  /** The ledger, newest first, with cursor pagination. */
  movements(auth: AuthContext, storeId: string, q: MovementsQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const store = await visibleStore(tx, auth, storeId);
      const rows = await tx.stockMovement.findMany({
        where: {
          tenantId: auth.tenantId,
          storeId: store.id,
          ...(q.productId && { productId: q.productId }),
          ...(q.type && { type: q.type }),
          ...((q.from || q.to) && {
            createdAt: {
              ...(q.from && { gte: new Date(q.from) }),
              ...(q.to && { lt: new Date(q.to) }),
            },
          }),
          ...(q.cursor && { seq: { lt: BigInt(q.cursor) } }),
        },
        orderBy: { seq: 'desc' },
        take: q.limit,
      });
      const cost = showCost(auth);
      return {
        data: rows.map((m) => movementView(m, cost)),
        meta: {
          limit: q.limit,
          nextCursor:
            rows.length === q.limit
              ? rows[rows.length - 1]!.seq.toString()
              : null,
        },
      };
    });
  }

  setReorder(
    auth: AuthContext,
    storeId: string,
    productId: string,
    input: ReorderInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'inventory:adjust');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const store = await visibleStore(tx, auth, storeId);
      const p = await tx.product.findFirst({
        where: { id: productId, tenantId: auth.tenantId },
      });
      if (!p) throw notFound('Product');
      if (!p.trackInventory)
        throw unprocessable('NOT_STOCKED', `${p.name} doesn't keep stock.`);
      const data = {
        ...(input.reorderLevel !== undefined && {
          reorderLevel: input.reorderLevel,
        }),
        ...(input.reorderQty !== undefined && { reorderQty: input.reorderQty }),
      };
      const b = await tx.stockBalance.upsert({
        where: { storeId_productId: { storeId: store.id, productId } },
        create: {
          tenantId: auth.tenantId,
          storeId: store.id,
          productId,
          ...data,
        },
        update: data,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'stock.reorder_set',
          entity: 'product',
          entityId: productId,
          data: { storeId: store.id, ...input },
          meta,
        },
        tx,
      );
      return {
        storeId: store.id,
        productId,
        reorderLevel: qtyStr(b.reorderLevel),
        reorderQty: qtyStr(b.reorderQty),
      };
    });
  }

  /* ---------- batches ---------- */

  listBatches(auth: AuthContext, productId: string) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const p = await tx.product.findFirst({
        where: { id: productId, tenantId: auth.tenantId },
      });
      if (!p) throw notFound('Product');
      const rows = await tx.productBatch.findMany({
        where: { tenantId: auth.tenantId, productId },
        include: {
          stocks: {
            where: {
              qty: { gt: 0 },
              ...(auth.storeIds === 'ALL'
                ? {}
                : { storeId: { in: [...auth.storeIds] } }),
            },
          },
        },
        orderBy: [
          { expiryDate: { sort: 'asc', nulls: 'last' } },
          { batchNo: 'asc' },
        ],
      });
      return {
        data: rows.map((b) => ({
          id: b.id,
          batchNo: b.batchNo,
          expiryDate: dateStr(b.expiryDate),
          mfgDate: dateStr(b.mfgDate),
          stock: b.stocks.map((s) => ({
            storeId: s.storeId,
            qty: s.qty.toFixed(3),
          })),
        })),
      };
    });
  }

  createBatch(
    auth: AuthContext,
    productId: string,
    input: CreateBatchInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'inventory:adjust');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const p = await tx.product.findFirst({
        where: { id: productId, tenantId: auth.tenantId },
      });
      if (!p) throw notFound('Product');
      if (!p.tracksBatches)
        throw unprocessable(
          'NOT_BATCH_TRACKED',
          `${p.name} isn't tracked by batch — turn on tracksBatches first.`,
        );
      if (input.mfgDate && input.expiryDate && input.mfgDate > input.expiryDate)
        throw unprocessable(
          'INVALID_DATES',
          'Manufacture date is after expiry.',
          'mfgDate',
        );
      const clash = await tx.productBatch.findFirst({
        where: { tenantId: auth.tenantId, productId, batchNo: input.batchNo },
      });
      if (clash)
        throw alreadyExists(`Batch ${input.batchNo} exists.`, 'batchNo');
      const b = await tx.productBatch.create({
        data: {
          tenantId: auth.tenantId,
          productId,
          batchNo: input.batchNo,
          expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
          mfgDate: input.mfgDate ? new Date(input.mfgDate) : null,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'batch.created',
          entity: 'product',
          entityId: productId,
          data: { batchNo: b.batchNo },
          meta,
        },
        tx,
      );
      return {
        id: b.id,
        batchNo: b.batchNo,
        expiryDate: dateStr(b.expiryDate),
        mfgDate: dateStr(b.mfgDate),
        stock: [],
      };
    });
  }

  /* ---------- alerts ---------- */

  lowStock(auth: AuthContext, q: AlertsQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.stockBalance.findMany({
        where: {
          tenantId: auth.tenantId,
          storeId: storeFilter(auth, q.storeId),
          reorderLevel: { not: null },
          qty: { lte: this.prisma.stockBalance.fields.reorderLevel },
          product: { status: 'ACTIVE', trackInventory: true },
        },
        include: {
          product: { include: { unit: true } },
          store: { select: { name: true, code: true } },
        },
        orderBy: [{ storeId: 'asc' }, { qty: 'asc' }],
        take: 1000,
      });
      return {
        data: rows.map((b) => ({
          store: { id: b.storeId, code: b.store.code, name: b.store.name },
          product: {
            id: b.productId,
            sku: b.product.sku,
            name: b.product.name,
            unit: b.product.unit.code,
          },
          qty: b.qty.toFixed(3),
          reorderLevel: qtyStr(b.reorderLevel),
          /** reorderQty when set, else enough to get back to twice the reorder level. */
          suggestedOrderQty: (
            b.reorderQty ??
            Decimal.max(new Decimal(0), b.reorderLevel!.times(2).minus(b.qty))
          ).toFixed(3),
        })),
      };
    });
  }

  expiring(auth: AuthContext, q: AlertsQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const today = new Date(new Date().toISOString().slice(0, 10));
      const until = new Date(today.getTime() + q.days * 86_400_000);
      const rows = await tx.batchStock.findMany({
        where: {
          tenantId: auth.tenantId,
          storeId: storeFilter(auth, q.storeId),
          qty: { gt: 0 },
          batch: { expiryDate: { lte: until } },
        },
        include: {
          batch: {
            include: {
              product: { select: { id: true, sku: true, name: true } },
            },
          },
          store: { select: { name: true, code: true } },
        },
        take: 1000,
      });
      const cost = showCost(auth);
      const balances = cost
        ? await tx.stockBalance.findMany({
            where: {
              tenantId: auth.tenantId,
              OR: rows.map((r) => ({
                storeId: r.storeId,
                productId: r.productId,
              })),
            },
          })
        : [];
      const avg = new Map(
        balances.map((b) => [`${b.storeId}:${b.productId}`, b.avgCost]),
      );
      return {
        data: rows
          .map((s) => {
            const exp = s.batch.expiryDate!;
            return {
              store: { id: s.storeId, code: s.store.code, name: s.store.name },
              product: s.batch.product,
              batch: {
                id: s.batchId,
                batchNo: s.batch.batchNo,
                expiryDate: dateStr(exp),
              },
              qty: s.qty.toFixed(3),
              daysLeft: Math.round(
                (exp.getTime() - today.getTime()) / 86_400_000,
              ),
              ...(cost
                ? {
                    value: valueStr(
                      s.qty.times(avg.get(`${s.storeId}:${s.productId}`) ?? 0),
                    ),
                  }
                : {}),
            };
          })
          .sort((a, b) => a.daysLeft - b.daysLeft),
      };
    });
  }

  /**
   * The Phase 5 invariant, checked on live data: every balance equals the sum of its movements,
   * every batch quantity equals the sum of that batch's movements, and batch quantities add up to
   * the balance of batch-tracked products. Returns what doesn't match (normally nothing).
   */
  reconcile(auth: AuthContext, storeId?: string) {
    assertPermission(auth, 'inventory:approve');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (storeId) await visibleStore(tx, auth, storeId);
      const scope = storeFilter(auth, storeId);
      const stores = scope?.in ?? null;
      const t = auth.tenantId;
      const balances = await tx.$queryRaw<
        {
          store_id: string;
          product_id: string;
          qty: Decimal;
          ledger: Decimal;
        }[]
      >`
        SELECT b.store_id::text, b.product_id::text, b.qty, COALESCE(m.total, 0) AS ledger
        FROM stock_balances b
        LEFT JOIN (SELECT store_id, product_id, SUM(qty) AS total FROM stock_movements
                   WHERE tenant_id = ${t}::uuid GROUP BY store_id, product_id) m
          USING (store_id, product_id)
        WHERE b.tenant_id = ${t}::uuid
          AND (${stores}::uuid[] IS NULL OR b.store_id = ANY(${stores}::uuid[]))
          AND b.qty <> COALESCE(m.total, 0)`;
      const batches = await tx.$queryRaw<
        { store_id: string; batch_id: string; qty: Decimal; ledger: Decimal }[]
      >`
        SELECT s.store_id::text, s.batch_id::text, s.qty, COALESCE(m.total, 0) AS ledger
        FROM batch_stocks s
        LEFT JOIN (SELECT store_id, batch_id, SUM(qty) AS total FROM stock_movements
                   WHERE tenant_id = ${t}::uuid AND batch_id IS NOT NULL GROUP BY store_id, batch_id) m
          USING (store_id, batch_id)
        WHERE s.tenant_id = ${t}::uuid
          AND (${stores}::uuid[] IS NULL OR s.store_id = ANY(${stores}::uuid[]))
          AND s.qty <> COALESCE(m.total, 0)`;
      const split = await tx.$queryRaw<
        {
          store_id: string;
          product_id: string;
          qty: Decimal;
          batches: Decimal;
        }[]
      >`
        SELECT b.store_id::text, b.product_id::text, b.qty, COALESCE(s.total, 0) AS batches
        FROM stock_balances b
        JOIN products p ON p.id = b.product_id AND p.tracks_batches
        LEFT JOIN (SELECT store_id, product_id, SUM(qty) AS total FROM batch_stocks
                   WHERE tenant_id = ${t}::uuid GROUP BY store_id, product_id) s
          USING (store_id, product_id)
        WHERE b.tenant_id = ${t}::uuid
          AND (${stores}::uuid[] IS NULL OR b.store_id = ANY(${stores}::uuid[]))
          AND b.qty >= 0 AND b.qty <> COALESCE(s.total, 0)`;
      const checked = await tx.stockBalance.count({
        where: { tenantId: t, ...(scope ? { storeId: scope } : {}) },
      });
      const q = (d: Decimal) => new Decimal(d).toFixed(3);
      return {
        balancesChecked: checked,
        ok: !balances.length && !batches.length && !split.length,
        balanceMismatches: balances.map((r) => ({
          storeId: r.store_id,
          productId: r.product_id,
          balance: q(r.qty),
          ledger: q(r.ledger),
        })),
        batchMismatches: batches.map((r) => ({
          storeId: r.store_id,
          batchId: r.batch_id,
          balance: q(r.qty),
          ledger: q(r.ledger),
        })),
        batchSplitMismatches: split.map((r) => ({
          storeId: r.store_id,
          productId: r.product_id,
          balance: q(r.qty),
          batches: q(r.batches),
        })),
      };
    });
  }
}
