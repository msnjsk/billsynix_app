import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Decimal } from '../common/decimal.js';
import { idempotent } from '../common/idempotency.js';
import { page, skipTake } from '../common/schemas.js';
import {
  assertPermission,
  can,
  canAccessStore,
  type AuthContext,
} from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { StockMovementType } from '../generated/prisma/client.js';
import { LedgerService } from './ledger.service.js';
import {
  adjustmentLimit,
  assertActive,
  canSelfApprove,
  conflict,
  costStr,
  forbidden,
  notFound,
  resolveBatch,
  showCost,
  storeFilter,
  unprocessable,
  valueStr,
  visibleStore,
} from './inventory.common.js';
import type {
  AdjustmentReasonKey,
  CreateAdjustmentInput,
  ListAdjustmentsQuery,
  RejectInput,
} from './inventory.schemas.js';

const WRITE_OFF: AdjustmentReasonKey[] = [
  'DAMAGE',
  'EXPIRY',
  'WASTAGE',
  'THEFT',
];

/** How each reason appears in the ledger. */
export const movementTypeFor = (
  reason: AdjustmentReasonKey,
): StockMovementType =>
  reason === 'OPENING'
    ? 'OPENING'
    : WRITE_OFF.includes(reason)
      ? 'WRITE_OFF'
      : 'ADJUSTMENT';

const include = {
  items: { include: { product: { select: { sku: true, name: true } } } },
  store: { select: { code: true, name: true } },
} as const;

/**
 * Opening stock, write-offs (damage, expiry, wastage, theft) and other corrections.
 *
 * Value ≤ the business's limit (settings.approvalLimits.adjustmentValue, ₹5,000 by default) posts
 * straight away. Above it, branch staff's adjustments wait for someone else with
 * `inventory:approve`; owners and admins post their own. Stock only moves when posted.
 */
@Injectable()
export class AdjustmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  private view(
    auth: AuthContext,
    a: Awaited<ReturnType<AdjustmentsService['load']>>,
  ) {
    const cost = showCost(auth);
    return {
      id: a.id,
      store: { id: a.storeId, code: a.store.code, name: a.store.name },
      reason: a.reason,
      note: a.note,
      status: a.status,
      ...(cost ? { value: valueStr(a.value) } : {}),
      items: a.items.map((i) => ({
        id: i.id,
        product: { id: i.productId, sku: i.product.sku, name: i.product.name },
        batchId: i.batchId,
        qty: i.qty.toFixed(3),
        ...(cost ? { unitCost: costStr(i.unitCost) } : {}),
      })),
      createdByUserId: a.createdByUserId,
      decidedByUserId: a.decidedByUserId,
      decidedAt: a.decidedAt,
      rejectionReason: a.rejectionReason,
      postedAt: a.postedAt,
      createdAt: a.createdAt,
    };
  }

  private async load(tx: Tx, auth: AuthContext, id: string) {
    const a = await tx.stockAdjustment.findFirst({
      where: { id, tenantId: auth.tenantId },
      include,
    });
    if (!a || !canAccessStore(auth, a.storeId)) throw notFound('Adjustment');
    return a;
  }

  /** Opening stock must be the first thing that happens to a product in a branch. */
  private async assertNoHistory(
    tx: Tx,
    tenantId: string,
    storeId: string,
    productIds: string[],
  ) {
    const seen = await tx.stockMovement.findFirst({
      where: { tenantId, storeId, productId: { in: productIds } },
      include: { product: { select: { name: true } } },
    });
    if (seen)
      throw unprocessable(
        'OPENING_NOT_FIRST',
        `${seen.product.name} already has stock history here — use FOUND or COUNT_CORRECTION instead.`,
      );
  }

  private async postItems(
    tx: Tx,
    auth: AuthContext,
    a: {
      id: string;
      storeId: string;
      reason: AdjustmentReasonKey;
      note: string | null;
    },
  ) {
    const items = await tx.stockAdjustmentItem.findMany({
      where: { tenantId: auth.tenantId, adjustmentId: a.id },
    });
    if (a.reason === 'OPENING')
      await this.assertNoHistory(
        tx,
        auth.tenantId,
        a.storeId,
        items.map((i) => i.productId),
      );
    await this.ledger.post(tx, {
      tenantId: auth.tenantId,
      storeId: a.storeId,
      refType: 'ADJUSTMENT',
      refId: a.id,
      userId: auth.userId,
      lines: items.map((i) => ({
        productId: i.productId,
        batchId: i.batchId,
        qty: i.qty,
        type: movementTypeFor(a.reason),
        unitCost: i.qty.gt(0) ? i.unitCost : null,
        reason: a.reason,
        note: a.note,
      })),
    });
  }

  list(auth: AuthContext, q: ListAdjustmentsQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const where = {
        tenantId: auth.tenantId,
        storeId: storeFilter(auth, q.storeId),
        ...(q.status && { status: q.status }),
      };
      const rows = await tx.stockAdjustment.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      });
      const total = await tx.stockAdjustment.count({ where });
      return page(
        rows.map((a) => this.view(auth, a)),
        total,
        q,
      );
    });
  }

  get(auth: AuthContext, id: string) {
    return this.prisma.withTenant(auth.tenantId, async (tx) =>
      this.view(auth, await this.load(tx, auth, id)),
    );
  }

  create(
    auth: AuthContext,
    storeId: string,
    input: CreateAdjustmentInput,
    key: string,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'inventory:adjust');
    return this.prisma.withTenant(auth.tenantId, (tx) =>
      idempotent(
        tx,
        auth.tenantId,
        key,
        { route: `POST stores/${storeId}/stock-adjustments`, body: input },
        201,
        async () => {
          const store = await visibleStore(tx, auth, storeId);
          assertActive(store);
          const productIds = [...new Set(input.items.map((i) => i.productId))];
          const products = new Map(
            (
              await tx.product.findMany({
                where: { tenantId: auth.tenantId, id: { in: productIds } },
                include: { unit: true },
              })
            ).map((p) => [p.id, p]),
          );
          const balances = new Map(
            (
              await tx.stockBalance.findMany({
                where: {
                  tenantId: auth.tenantId,
                  storeId,
                  productId: { in: productIds },
                },
              })
            ).map((b) => [b.productId, b]),
          );
          if (input.reason === 'OPENING')
            await this.assertNoHistory(tx, auth.tenantId, storeId, productIds);

          const items: {
            productId: string;
            batchId: string | null;
            qty: Decimal;
            unitCost: Decimal | null;
          }[] = [];
          let value = new Decimal(0);
          for (const [i, it] of input.items.entries()) {
            const f = `items.${i}`;
            const p = products.get(it.productId);
            if (!p)
              throw unprocessable(
                'INVALID_REFERENCE',
                'Product not found.',
                `${f}.productId`,
              );
            const qty = new Decimal(it.qty);
            if (!p.trackInventory)
              throw unprocessable(
                'NOT_STOCKED',
                `${p.name} doesn't keep stock.`,
                `${f}.productId`,
              );
            if (qty.decimalPlaces() > p.unit.decimals)
              throw unprocessable(
                'INVALID_QTY',
                `${p.name} is counted to ${p.unit.decimals} decimal places.`,
                `${f}.qty`,
              );
            if (WRITE_OFF.includes(input.reason) && qty.gt(0))
              throw unprocessable(
                'INVALID_QTY',
                `A ${input.reason.toLowerCase()} write-off takes stock out — use a negative quantity.`,
                `${f}.qty`,
              );
            if (
              (input.reason === 'OPENING' || input.reason === 'FOUND') &&
              qty.lt(0)
            )
              throw unprocessable(
                'INVALID_QTY',
                `${input.reason} adds stock — use a positive quantity.`,
                `${f}.qty`,
              );
            if (input.reason === 'OPENING' && it.unitCost === undefined)
              throw unprocessable(
                'COST_REQUIRED',
                'Opening stock needs its cost per unit (for stock valuation).',
                `${f}.unitCost`,
              );
            if (qty.lt(0) && it.unitCost !== undefined)
              throw unprocessable(
                'INVALID_COST',
                'Stock going out leaves at the average cost; leave unitCost out.',
                `${f}.unitCost`,
              );
            let batchId: string | null = null;
            if (p.tracksBatches) {
              batchId =
                (await resolveBatch(
                  tx,
                  auth.tenantId,
                  p.id,
                  it,
                  `${f}.batchNo`,
                  qty.gt(0),
                )) ?? null;
              if (!batchId && qty.gt(0))
                throw unprocessable(
                  'BATCH_REQUIRED',
                  `Give the batch number of the ${p.name} coming in.`,
                  `${f}.batchNo`,
                );
            } else if (it.batchId || it.batchNo) {
              throw unprocessable(
                'NOT_BATCH_TRACKED',
                `${p.name} isn't tracked by batch.`,
                `${f}.batchNo`,
              );
            }
            const unitCost =
              it.unitCost !== undefined ? new Decimal(it.unitCost) : null;
            value = value.plus(
              qty.abs().times(unitCost ?? balances.get(p.id)?.avgCost ?? 0),
            );
            items.push({ productId: p.id, batchId, qty, unitCost });
          }

          const limit = await adjustmentLimit(tx, auth.tenantId);
          const postNow = value.lte(limit) || canSelfApprove(auth);
          const a = await tx.stockAdjustment.create({
            data: {
              tenantId: auth.tenantId,
              storeId,
              reason: input.reason,
              note: input.note ?? null,
              status: postNow ? 'POSTED' : 'PENDING_APPROVAL',
              value: value.toDecimalPlaces(2),
              createdByUserId: auth.userId,
              ...(postNow && { postedAt: new Date() }),
              ...(postNow &&
                value.gt(limit) && {
                  decidedByUserId: auth.userId,
                  decidedAt: new Date(),
                }),
            },
          });
          await tx.stockAdjustmentItem.createMany({
            data: items.map((i) => ({
              tenantId: auth.tenantId,
              adjustmentId: a.id,
              ...i,
            })),
          });
          if (postNow) await this.postItems(tx, auth, a);
          await this.audit.record(
            {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: postNow
                ? 'stock.adjustment_posted'
                : 'stock.adjustment_requested',
              entity: 'stock_adjustment',
              entityId: a.id,
              data: {
                storeId,
                reason: input.reason,
                value: value.toFixed(2),
                lines: items.length,
              },
              meta,
            },
            tx,
          );
          return this.view(auth, await this.load(tx, auth, a.id));
        },
      ),
    );
  }

  approve(auth: AuthContext, id: string, key: string, meta: RequestMeta) {
    assertPermission(auth, 'inventory:approve');
    return this.prisma.withTenant(auth.tenantId, (tx) =>
      idempotent(
        tx,
        auth.tenantId,
        key,
        { route: `POST stock-adjustments/${id}/approve`, body: {} },
        200,
        async () => {
          const a = await this.load(tx, auth, id);
          if (a.status !== 'PENDING_APPROVAL')
            throw conflict(
              'INVALID_STATE',
              `This adjustment is ${a.status.toLowerCase()}.`,
            );
          if (a.createdByUserId === auth.userId && !canSelfApprove(auth))
            throw forbidden(
              'SELF_APPROVAL',
              'Someone else must approve an adjustment you raised.',
            );
          const store = await visibleStore(tx, auth, a.storeId);
          assertActive(store);
          // Lock the row so two approvers can't both post it.
          const claimed = await tx.stockAdjustment.updateMany({
            where: {
              id: a.id,
              tenantId: auth.tenantId,
              status: 'PENDING_APPROVAL',
            },
            data: {
              status: 'POSTED',
              decidedByUserId: auth.userId,
              decidedAt: new Date(),
              postedAt: new Date(),
            },
          });
          if (!claimed.count)
            throw conflict(
              'INVALID_STATE',
              'This adjustment was just decided.',
            );
          await this.postItems(tx, auth, a);
          await this.audit.record(
            {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: 'stock.adjustment_approved',
              entity: 'stock_adjustment',
              entityId: a.id,
              data: { value: a.value.toFixed(2) },
              meta,
            },
            tx,
          );
          return this.view(auth, await this.load(tx, auth, a.id));
        },
      ),
    );
  }

  reject(auth: AuthContext, id: string, input: RejectInput, meta: RequestMeta) {
    assertPermission(auth, 'inventory:approve');
    return this.decide(auth, id, 'REJECTED', meta, input.reason);
  }

  /** The author withdraws it, or an approver drops it. */
  cancel(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.decide(auth, id, 'CANCELLED', meta);
  }

  private decide(
    auth: AuthContext,
    id: string,
    status: 'REJECTED' | 'CANCELLED',
    meta: RequestMeta,
    reason?: string,
  ) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const a = await this.load(tx, auth, id);
      if (
        status === 'CANCELLED' &&
        a.createdByUserId !== auth.userId &&
        !can(auth, 'inventory:approve')
      )
        throw forbidden(
          'FORBIDDEN',
          'Only its author or an approver can cancel this adjustment.',
        );
      const done = await tx.stockAdjustment.updateMany({
        where: {
          id: a.id,
          tenantId: auth.tenantId,
          status: 'PENDING_APPROVAL',
        },
        data: {
          status,
          decidedByUserId: auth.userId,
          decidedAt: new Date(),
          rejectionReason: reason ?? null,
        },
      });
      if (!done.count)
        throw conflict(
          'INVALID_STATE',
          `This adjustment is ${a.status.toLowerCase()}.`,
        );
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: `stock.adjustment_${status.toLowerCase()}`,
          entity: 'stock_adjustment',
          entityId: a.id,
          data: reason ? { reason } : {},
          meta,
        },
        tx,
      );
      return this.view(auth, await this.load(tx, auth, a.id));
    });
  }
}
