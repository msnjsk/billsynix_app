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
import { TaxonomyService } from '../catalogue/taxonomy.service.js';
import { LedgerService } from './ledger.service.js';
import {
  adjustmentLimit,
  assertActive,
  canSelfApprove,
  conflict,
  forbidden,
  notFound,
  showCost,
  storeFilter,
  unprocessable,
  valueStr,
  visibleStore,
} from './inventory.common.js';
import type {
  CreateCountInput,
  ListCountsQuery,
  RecordCountInput,
} from './inventory.schemas.js';

const lineKey = (productId: string, batchId: string | null | undefined) =>
  `${productId}:${batchId ?? ''}`;

/**
 * Physical stock counts. Starting a count lists what the system expects; each line counted
 * records the system quantity at that moment, so sales during the count don't skew it. Posting
 * books counted − system as COUNT_ADJUSTMENT movements. Uncounted lines are left alone.
 *
 * Batch-tracked products are counted per batch held; stock found in a batch not on the sheet is
 * booked with a FOUND adjustment.
 */
@Injectable()
export class CountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  private async load(tx: Tx, auth: AuthContext, id: string) {
    const c = await tx.stockCount.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { store: { select: { code: true, name: true } } },
    });
    if (!c || !canAccessStore(auth, c.storeId)) throw notFound('Stock count');
    return c;
  }

  private async view(
    tx: Tx,
    auth: AuthContext,
    id: string,
    onlyDifferences = false,
  ) {
    const c = await this.load(tx, auth, id);
    const items = await tx.stockCountItem.findMany({
      where: { tenantId: auth.tenantId, countId: c.id },
      include: { product: { select: { sku: true, name: true } } },
      orderBy: { product: { name: 'asc' } },
    });
    const batchIds = items.flatMap((i) => (i.batchId ? [i.batchId] : []));
    const batches = new Map(
      (
        await tx.productBatch.findMany({
          where: { tenantId: auth.tenantId, id: { in: batchIds } },
        })
      ).map((b) => [b.id, b.batchNo]),
    );
    const cost = showCost(auth);
    const avg = cost
      ? new Map(
          (
            await tx.stockBalance.findMany({
              where: {
                tenantId: auth.tenantId,
                storeId: c.storeId,
                productId: { in: items.map((i) => i.productId) },
              },
            })
          ).map((b) => [b.productId, b.avgCost]),
        )
      : new Map<string, Decimal>();
    let counted = 0;
    let differences = 0;
    let variance = new Decimal(0);
    const lines = items.map((i) => {
      const diff = i.countedQty ? i.countedQty.minus(i.systemQty) : null;
      if (i.countedQty) counted++;
      if (diff && !diff.isZero()) {
        differences++;
        variance = variance.plus(diff.times(avg.get(i.productId) ?? 0));
      }
      return {
        id: i.id,
        product: { id: i.productId, sku: i.product.sku, name: i.product.name },
        batchId: i.batchId,
        batchNo: i.batchId ? (batches.get(i.batchId) ?? null) : null,
        systemQty: i.systemQty.toFixed(3),
        countedQty: i.countedQty?.toFixed(3) ?? null,
        difference: diff?.toFixed(3) ?? null,
        countedAt: i.countedAt,
      };
    });
    return {
      id: c.id,
      store: { id: c.storeId, code: c.store.code, name: c.store.name },
      name: c.name,
      status: c.status,
      summary: {
        lines: items.length,
        counted,
        uncounted: items.length - counted,
        differences,
        ...(cost ? { varianceValue: valueStr(variance) } : {}),
      },
      items: onlyDifferences
        ? lines.filter((l) => l.difference && Number(l.difference) !== 0)
        : lines,
      createdByUserId: c.createdByUserId,
      postedByUserId: c.postedByUserId,
      postedAt: c.postedAt,
      createdAt: c.createdAt,
    };
  }

  list(auth: AuthContext, q: ListCountsQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const where = {
        tenantId: auth.tenantId,
        storeId: storeFilter(auth, q.storeId),
        ...(q.status && { status: q.status }),
      };
      const rows = await tx.stockCount.findMany({
        where,
        include: {
          store: { select: { code: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      });
      const total = await tx.stockCount.count({ where });
      return page(
        rows.map((c) => ({
          id: c.id,
          store: { id: c.storeId, code: c.store.code, name: c.store.name },
          name: c.name,
          status: c.status,
          lines: c._count.items,
          createdAt: c.createdAt,
          postedAt: c.postedAt,
        })),
        total,
        q,
      );
    });
  }

  get(auth: AuthContext, id: string, onlyDifferences: boolean) {
    return this.prisma.withTenant(auth.tenantId, (tx) =>
      this.view(tx, auth, id, onlyDifferences),
    );
  }

  create(
    auth: AuthContext,
    storeId: string,
    input: CreateCountInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'inventory:adjust');
    return this.prisma.withTenant(
      auth.tenantId,
      async (tx) => {
        const store = await visibleStore(tx, auth, storeId);
        assertActive(store);
        let categoryIds: string[] | undefined;
        if (input.categoryId) {
          const tree = await this.taxonomy.categoryTree(tx, auth.tenantId);
          if (!tree.byId.has(input.categoryId))
            throw unprocessable(
              'INVALID_REFERENCE',
              'Category not found.',
              'categoryId',
            );
          categoryIds = tree.subtree(input.categoryId);
        }
        const products = await tx.product.findMany({
          where: {
            tenantId: auth.tenantId,
            trackInventory: true,
            status: 'ACTIVE',
            ...(categoryIds && { categoryId: { in: categoryIds } }),
            ...(input.productIds && { id: { in: input.productIds } }),
          },
          select: { id: true, tracksBatches: true },
        });
        if (!products.length)
          throw unprocessable('NOTHING_TO_COUNT', 'No stocked products match.');
        if (products.length > 5000)
          throw unprocessable(
            'COUNT_TOO_LARGE',
            'Count at most 5,000 products at a time — pick a category.',
          );
        const ids = products.map((p) => p.id);
        const [balances, batchStocks] = [
          await tx.stockBalance.findMany({
            where: { tenantId: auth.tenantId, storeId, productId: { in: ids } },
          }),
          await tx.batchStock.findMany({
            where: {
              tenantId: auth.tenantId,
              storeId,
              productId: { in: ids },
              qty: { not: 0 },
            },
          }),
        ];
        const qty = new Map(balances.map((b) => [b.productId, b.qty]));
        const c = await tx.stockCount.create({
          data: {
            tenantId: auth.tenantId,
            storeId,
            name: input.name,
            createdByUserId: auth.userId,
          },
        });
        const lines = products.flatMap(
          (p): Prisma.StockCountItemCreateManyInput[] =>
            p.tracksBatches
              ? batchStocks
                  .filter((s) => s.productId === p.id)
                  .map((s) => ({
                    tenantId: auth.tenantId,
                    countId: c.id,
                    productId: p.id,
                    batchId: s.batchId,
                    systemQty: s.qty,
                  }))
              : [
                  {
                    tenantId: auth.tenantId,
                    countId: c.id,
                    productId: p.id,
                    batchId: null,
                    systemQty: qty.get(p.id) ?? new Decimal(0),
                  },
                ],
        );
        await tx.stockCountItem.createMany({ data: lines });
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'stock.count_started',
            entity: 'stock_count',
            entityId: c.id,
            data: { storeId, lines: lines.length },
            meta,
          },
          tx,
        );
        return this.view(tx, auth, c.id);
      },
      { timeout: 60_000 },
    );
  }

  /** Records counted quantities (again, to correct a recount). */
  record(auth: AuthContext, id: string, input: RecordCountInput) {
    assertPermission(auth, 'inventory:adjust');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const c = await this.load(tx, auth, id);
      if (c.status !== 'OPEN')
        throw conflict(
          'INVALID_STATE',
          `This count is ${c.status.toLowerCase()}.`,
        );
      const items = await tx.stockCountItem.findMany({
        where: { tenantId: auth.tenantId, countId: c.id },
        include: { product: { include: { unit: true } } },
      });
      const byKey = new Map(
        items.map((i) => [lineKey(i.productId, i.batchId), i]),
      );
      const productIds = [...new Set(input.items.map((i) => i.productId))];
      const [balances, batchStocks] = [
        await tx.stockBalance.findMany({
          where: {
            tenantId: auth.tenantId,
            storeId: c.storeId,
            productId: { in: productIds },
          },
        }),
        await tx.batchStock.findMany({
          where: {
            tenantId: auth.tenantId,
            storeId: c.storeId,
            productId: { in: productIds },
          },
        }),
      ];
      const now = new Date();
      for (const [n, it] of input.items.entries()) {
        const line = byKey.get(lineKey(it.productId, it.batchId));
        if (!line)
          throw unprocessable(
            'NOT_ON_COUNT',
            'That product (or batch) is not on this count.',
            `items.${n}.productId`,
          );
        const counted = new Decimal(it.countedQty);
        if (counted.decimalPlaces() > line.product.unit.decimals)
          throw unprocessable(
            'INVALID_QTY',
            `${line.product.name} is counted to ${line.product.unit.decimals} decimal places.`,
            `items.${n}.countedQty`,
          );
        const system = line.batchId
          ? (batchStocks.find((s) => s.batchId === line.batchId)?.qty ??
            new Decimal(0))
          : (balances.find((b) => b.productId === line.productId)?.qty ??
            new Decimal(0));
        await tx.stockCountItem.update({
          where: { id: line.id },
          data: {
            countedQty: counted,
            systemQty: system,
            countedAt: now,
            countedBy: auth.userId,
          },
        });
      }
      return this.view(tx, auth, c.id);
    });
  }

  submit(auth: AuthContext, id: string, meta: RequestMeta) {
    assertPermission(auth, 'inventory:adjust');
    return this.transition(
      auth,
      id,
      ['OPEN'],
      'SUBMITTED',
      'stock.count_submitted',
      meta,
    );
  }

  cancel(auth: AuthContext, id: string, meta: RequestMeta) {
    assertPermission(auth, 'inventory:adjust');
    return this.transition(
      auth,
      id,
      ['OPEN', 'SUBMITTED'],
      'CANCELLED',
      'stock.count_cancelled',
      meta,
    );
  }

  private transition(
    auth: AuthContext,
    id: string,
    from: ('OPEN' | 'SUBMITTED')[],
    to: 'SUBMITTED' | 'CANCELLED',
    action: string,
    meta: RequestMeta,
  ) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const c = await this.load(tx, auth, id);
      const done = await tx.stockCount.updateMany({
        where: { id: c.id, tenantId: auth.tenantId, status: { in: from } },
        data: { status: to },
      });
      if (!done.count)
        throw conflict(
          'INVALID_STATE',
          `This count is ${c.status.toLowerCase()}.`,
        );
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action,
          entity: 'stock_count',
          entityId: c.id,
          meta,
        },
        tx,
      );
      return this.view(tx, auth, c.id);
    });
  }

  /** Books the differences. Over the approval limit, branch staff need someone else to post. */
  post(auth: AuthContext, id: string, key: string, meta: RequestMeta) {
    assertPermission(auth, 'inventory:approve');
    return this.prisma.withTenant(
      auth.tenantId,
      (tx) =>
        idempotent(
          tx,
          auth.tenantId,
          key,
          { route: `POST stock-counts/${id}/post`, body: {} },
          200,
          async () => {
            const c = await this.load(tx, auth, id);
            if (c.status !== 'OPEN' && c.status !== 'SUBMITTED')
              throw conflict(
                'INVALID_STATE',
                `This count is ${c.status.toLowerCase()}.`,
              );
            const store = await visibleStore(tx, auth, c.storeId);
            assertActive(store);
            const items = await tx.stockCountItem.findMany({
              where: {
                tenantId: auth.tenantId,
                countId: c.id,
                countedQty: { not: null },
              },
            });
            const diffs = items
              .map((i) => ({ i, diff: i.countedQty!.minus(i.systemQty) }))
              .filter((d) => !d.diff.isZero());
            const avg = new Map(
              (
                await tx.stockBalance.findMany({
                  where: {
                    tenantId: auth.tenantId,
                    storeId: c.storeId,
                    productId: { in: diffs.map((d) => d.i.productId) },
                  },
                })
              ).map((b) => [b.productId, b.avgCost]),
            );
            const value = diffs.reduce(
              (v, d) => v.plus(d.diff.abs().times(avg.get(d.i.productId) ?? 0)),
              new Decimal(0),
            );
            if (
              c.createdByUserId === auth.userId &&
              !canSelfApprove(auth) &&
              value.gt(await adjustmentLimit(tx, auth.tenantId))
            )
              throw forbidden(
                'SELF_APPROVAL',
                'The differences are above the approval limit — someone else must post this count.',
              );
            const claimed = await tx.stockCount.updateMany({
              where: {
                id: c.id,
                tenantId: auth.tenantId,
                status: { in: ['OPEN', 'SUBMITTED'] },
              },
              data: {
                status: 'POSTED',
                postedByUserId: auth.userId,
                postedAt: new Date(),
              },
            });
            if (!claimed.count)
              throw conflict('INVALID_STATE', 'This count was just posted.');
            await this.ledger.post(tx, {
              tenantId: auth.tenantId,
              storeId: c.storeId,
              refType: 'COUNT',
              refId: c.id,
              userId: auth.userId,
              lines: diffs.map((d) => ({
                productId: d.i.productId,
                batchId: d.i.batchId,
                qty: d.diff,
                type: 'COUNT_ADJUSTMENT' as const,
                reason: 'COUNT',
                note: c.name,
              })),
            });
            await this.audit.record(
              {
                tenantId: auth.tenantId,
                actorUserId: auth.userId,
                action: 'stock.count_posted',
                entity: 'stock_count',
                entityId: c.id,
                data: { differences: diffs.length, value: value.toFixed(2) },
                meta,
              },
              tx,
            );
            return this.view(tx, auth, c.id);
          },
        ),
      { timeout: 60_000 },
    );
  }
}
