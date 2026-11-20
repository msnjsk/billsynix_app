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
import type { LedgerLine } from './ledger.service.js';
import { LedgerService } from './ledger.service.js';
import {
  assertActive,
  conflict,
  costStr,
  dateStr,
  notFound,
  showCost,
  unprocessable,
  valueStr,
} from './inventory.common.js';
import type {
  CreateTransferInput,
  DispatchInput,
  ListTransfersQuery,
  ReceiveInput,
} from './inventory.schemas.js';

const include = {
  fromStore: { select: { code: true, name: true, gstin: true } },
  toStore: { select: { code: true, name: true, gstin: true } },
  items: {
    include: { product: { select: { sku: true, name: true } } },
    orderBy: { id: 'asc' as const },
  },
};

/**
 * Stock moving between branches: REQUESTED → (dispatch) IN_TRANSIT → (receive) RECEIVED,
 * or REQUESTED → CANCELLED.
 *
 * Dispatch posts TRANSFER_OUT at the source (at its average cost). Until receipt the stock is in
 * transit: in neither branch's sellable stock, shown as `inTransitIn` / `inTransitOut`. Receipt
 * posts TRANSFER_IN at the destination for what was sent and TRANSFER_LOSS for any shortfall, both
 * at the dispatch cost, so the loss is visible and valued. Batches travel with the stock.
 *
 * The GST document (delivery challan between same-GSTIN branches, tax invoice between different
 * GSTINs) is issued with the invoice series in Phase 7; `crossGstin` says which one applies.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  private async load(tx: Tx, auth: AuthContext, id: string) {
    const t = await tx.stockTransfer.findFirst({
      where: { id, tenantId: auth.tenantId },
      include,
    });
    if (
      !t ||
      !(
        canAccessStore(auth, t.fromStoreId) || canAccessStore(auth, t.toStoreId)
      )
    )
      throw notFound('Transfer');
    return t;
  }

  private async view(
    tx: Tx,
    auth: AuthContext,
    t: Awaited<ReturnType<TransfersService['load']>>,
  ) {
    const cost = showCost(auth);
    const batchIds = t.items.flatMap((i) => (i.batchId ? [i.batchId] : []));
    const batches = new Map(
      (
        await tx.productBatch.findMany({
          where: { tenantId: auth.tenantId, id: { in: batchIds } },
        })
      ).map((b) => [b.id, b]),
    );
    let value = new Decimal(0);
    const items = t.items.map((i) => {
      if (i.dispatchedQty && i.unitCost)
        value = value.plus(i.dispatchedQty.times(i.unitCost));
      const b = i.batchId ? batches.get(i.batchId) : undefined;
      const lost =
        i.receivedQty && i.dispatchedQty
          ? i.dispatchedQty.minus(i.receivedQty)
          : null;
      return {
        id: i.id,
        product: { id: i.productId, sku: i.product.sku, name: i.product.name },
        batch: b
          ? { id: b.id, batchNo: b.batchNo, expiryDate: dateStr(b.expiryDate) }
          : null,
        requestedQty: i.requestedQty.toFixed(3),
        dispatchedQty: i.dispatchedQty?.toFixed(3) ?? null,
        receivedQty: i.receivedQty?.toFixed(3) ?? null,
        lostQty: lost?.toFixed(3) ?? null,
        ...(cost ? { unitCost: costStr(i.unitCost) } : {}),
      };
    });
    return {
      id: t.id,
      fromStore: {
        id: t.fromStoreId,
        code: t.fromStore.code,
        name: t.fromStore.name,
      },
      toStore: { id: t.toStoreId, code: t.toStore.code, name: t.toStore.name },
      status: t.status,
      crossGstin: (t.fromStore.gstin ?? '') !== (t.toStore.gstin ?? ''),
      note: t.note,
      items,
      ...(cost && t.dispatchedAt ? { dispatchedValue: valueStr(value) } : {}),
      requestedByUserId: t.requestedByUserId,
      dispatchedByUserId: t.dispatchedByUserId,
      dispatchedAt: t.dispatchedAt,
      receivedByUserId: t.receivedByUserId,
      receivedAt: t.receivedAt,
      createdAt: t.createdAt,
    };
  }

  list(auth: AuthContext, q: ListTransfersQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (q.storeId && !canAccessStore(auth, q.storeId))
        throw notFound('Branch');
      const mine = q.storeId
        ? [q.storeId]
        : auth.storeIds === 'ALL'
          ? null
          : [...auth.storeIds];
      const side = (field: 'fromStoreId' | 'toStoreId') =>
        mine ? { [field]: { in: mine } } : {};
      const where = {
        tenantId: auth.tenantId,
        ...(q.status && { status: q.status }),
        ...(q.direction === 'OUT'
          ? side('fromStoreId')
          : q.direction === 'IN'
            ? side('toStoreId')
            : mine
              ? { OR: [side('fromStoreId'), side('toStoreId')] }
              : {}),
      };
      const rows = await tx.stockTransfer.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      });
      const total = await tx.stockTransfer.count({ where });
      const data = [];
      for (const t of rows) data.push(await this.view(tx, auth, t));
      return page(data, total, q);
    });
  }

  get(auth: AuthContext, id: string) {
    return this.prisma.withTenant(auth.tenantId, async (tx) =>
      this.view(tx, auth, await this.load(tx, auth, id)),
    );
  }

  create(auth: AuthContext, input: CreateTransferInput, meta: RequestMeta) {
    assertPermission(auth, 'transfers:request');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const [from, to] = [
        await tx.store.findFirst({
          where: { id: input.fromStoreId, tenantId: auth.tenantId },
        }),
        await tx.store.findFirst({
          where: { id: input.toStoreId, tenantId: auth.tenantId },
        }),
      ];
      if (!from)
        throw unprocessable(
          'INVALID_REFERENCE',
          'Source branch not found.',
          'fromStoreId',
        );
      if (!to)
        throw unprocessable(
          'INVALID_REFERENCE',
          'Destination branch not found.',
          'toStoreId',
        );
      if (!canAccessStore(auth, from.id) && !canAccessStore(auth, to.id))
        throw notFound('Branch');
      assertActive(from);
      assertActive(to);
      const products = new Map(
        (
          await tx.product.findMany({
            where: {
              tenantId: auth.tenantId,
              id: { in: input.items.map((i) => i.productId) },
            },
            include: { unit: true },
          })
        ).map((p) => [p.id, p]),
      );
      input.items.forEach((it, i) => {
        const p = products.get(it.productId);
        if (!p)
          throw unprocessable(
            'INVALID_REFERENCE',
            'Product not found.',
            `items.${i}.productId`,
          );
        if (!p.trackInventory)
          throw unprocessable(
            'NOT_STOCKED',
            `${p.name} doesn't keep stock.`,
            `items.${i}.productId`,
          );
        if (new Decimal(it.qty).decimalPlaces() > p.unit.decimals)
          throw unprocessable(
            'INVALID_QTY',
            `${p.name} is counted to ${p.unit.decimals} decimal places.`,
            `items.${i}.qty`,
          );
      });
      const t = await tx.stockTransfer.create({
        data: {
          tenantId: auth.tenantId,
          fromStoreId: from.id,
          toStoreId: to.id,
          note: input.note ?? null,
          requestedByUserId: auth.userId,
        },
      });
      await tx.stockTransferItem.createMany({
        data: input.items.map((i) => ({
          tenantId: auth.tenantId,
          transferId: t.id,
          productId: i.productId,
          requestedQty: i.qty,
        })),
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'transfer.requested',
          entity: 'stock_transfer',
          entityId: t.id,
          data: { from: from.id, to: to.id, lines: input.items.length },
          meta,
        },
        tx,
      );
      return this.view(tx, auth, await this.load(tx, auth, t.id));
    });
  }

  dispatch(
    auth: AuthContext,
    id: string,
    input: DispatchInput,
    key: string,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'transfers:dispatch');
    return this.prisma.withTenant(auth.tenantId, (tx) =>
      idempotent(
        tx,
        auth.tenantId,
        key,
        { route: `POST stock-transfers/${id}/dispatch`, body: input },
        200,
        async () => {
          const t = await this.load(tx, auth, id);
          if (!canAccessStore(auth, t.fromStoreId)) throw notFound('Transfer');
          if (t.status !== 'REQUESTED')
            throw conflict(
              'INVALID_STATE',
              `This transfer is ${t.status.toLowerCase().replace('_', ' ')}.`,
            );
          const claimed = await tx.stockTransfer.updateMany({
            where: { id: t.id, tenantId: auth.tenantId, status: 'REQUESTED' },
            data: {
              status: 'IN_TRANSIT',
              dispatchedByUserId: auth.userId,
              dispatchedAt: new Date(),
            },
          });
          if (!claimed.count)
            throw conflict(
              'INVALID_STATE',
              'This transfer was just dispatched.',
            );
          const plan = new Map(
            t.items.map((i) => [
              i.id,
              {
                qty: i.requestedQty,
                batches: undefined as
                  { batchId: string; qty: string }[] | undefined,
              },
            ]),
          );
          if (input.items) {
            for (const v of plan.values()) v.qty = new Decimal(0);
            input.items.forEach((it, n) => {
              const item = t.items.find((x) => x.id === it.itemId);
              if (!item)
                throw unprocessable(
                  'INVALID_REFERENCE',
                  'Not an item of this transfer.',
                  `items.${n}.itemId`,
                );
              const qty = new Decimal(it.qty);
              if (qty.gt(item.requestedQty))
                throw unprocessable(
                  'OVER_DISPATCH',
                  `More than the ${item.requestedQty.toFixed(3)} requested of ${item.product.name}.`,
                  `items.${n}.qty`,
                );
              if (
                it.batches &&
                !it.batches
                  .reduce((s, b) => s.plus(b.qty), new Decimal(0))
                  .eq(qty)
              )
                throw unprocessable(
                  'BATCH_TOTAL',
                  'Batch quantities must add up to the quantity sent.',
                  `items.${n}.batches`,
                );
              plan.set(item.id, { qty, batches: it.batches });
            });
          }
          const lines: (LedgerLine & { itemId: string })[] = [];
          for (const item of t.items) {
            const p = plan.get(item.id)!;
            if (p.qty.isZero()) continue;
            if (p.batches)
              for (const b of p.batches)
                lines.push({
                  itemId: item.id,
                  productId: item.productId,
                  batchId: b.batchId,
                  qty: new Decimal(b.qty).negated(),
                  type: 'TRANSFER_OUT',
                });
            else
              lines.push({
                itemId: item.id,
                productId: item.productId,
                qty: p.qty.negated(),
                type: 'TRANSFER_OUT',
              });
          }
          if (!lines.length)
            throw unprocessable(
              'NOTHING_TO_DISPATCH',
              'Send at least one item.',
            );
          const movements = await this.ledger.post(tx, {
            tenantId: auth.tenantId,
            storeId: t.fromStoreId,
            refType: 'TRANSFER',
            refId: t.id,
            userId: auth.userId,
            lines,
          });
          // Record what left, per batch: the first batch takes the item row, others get new rows.
          for (const item of t.items) {
            const out = movements.filter((m) => m.productId === item.productId);
            if (!out.length) {
              await tx.stockTransferItem.update({
                where: { id: item.id },
                data: { dispatchedQty: 0 },
              });
              continue;
            }
            const byBatch = new Map<
              string,
              { qty: Decimal; cost: Decimal; batchId: string | null }
            >();
            for (const m of out) {
              const k = m.batchId ?? '';
              const cur = byBatch.get(k) ?? {
                qty: new Decimal(0),
                cost: m.unitCost,
                batchId: m.batchId,
              };
              cur.qty = cur.qty.plus(m.qty.negated());
              byBatch.set(k, cur);
            }
            const [first, ...rest] = [...byBatch.values()];
            await tx.stockTransferItem.update({
              where: { id: item.id },
              data: {
                batchId: first!.batchId,
                dispatchedQty: first!.qty,
                unitCost: first!.cost,
              },
            });
            if (rest.length)
              await tx.stockTransferItem.createMany({
                data: rest.map((r) => ({
                  tenantId: auth.tenantId,
                  transferId: t.id,
                  productId: item.productId,
                  batchId: r.batchId,
                  requestedQty: 0,
                  dispatchedQty: r.qty,
                  unitCost: r.cost,
                })),
              });
          }
          await this.audit.record(
            {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: 'transfer.dispatched',
              entity: 'stock_transfer',
              entityId: t.id,
              data: { lines: lines.length },
              meta,
            },
            tx,
          );
          return this.view(tx, auth, await this.load(tx, auth, t.id));
        },
      ),
    );
  }

  receive(
    auth: AuthContext,
    id: string,
    input: ReceiveInput,
    key: string,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'transfers:receive');
    return this.prisma.withTenant(auth.tenantId, (tx) =>
      idempotent(
        tx,
        auth.tenantId,
        key,
        { route: `POST stock-transfers/${id}/receive`, body: input },
        200,
        async () => {
          const t = await this.load(tx, auth, id);
          if (!canAccessStore(auth, t.toStoreId)) throw notFound('Transfer');
          if (t.status !== 'IN_TRANSIT')
            throw conflict(
              'INVALID_STATE',
              `This transfer is ${t.status.toLowerCase().replace('_', ' ')}.`,
            );
          const sent = t.items.filter((i) => i.dispatchedQty?.gt(0));
          const received = new Map(sent.map((i) => [i.id, i.dispatchedQty!]));
          input.items?.forEach((it, n) => {
            const item = sent.find((x) => x.id === it.itemId);
            if (!item)
              throw unprocessable(
                'INVALID_REFERENCE',
                'Not a dispatched item of this transfer.',
                `items.${n}.itemId`,
              );
            const qty = new Decimal(it.receivedQty);
            if (qty.gt(item.dispatchedQty!))
              throw unprocessable(
                'OVER_RECEIPT',
                `Only ${item.dispatchedQty!.toFixed(3)} of ${item.product.name} was sent.`,
                `items.${n}.receivedQty`,
              );
            received.set(item.id, qty);
          });
          const claimed = await tx.stockTransfer.updateMany({
            where: { id: t.id, tenantId: auth.tenantId, status: 'IN_TRANSIT' },
            data: {
              status: 'RECEIVED',
              receivedByUserId: auth.userId,
              receivedAt: new Date(),
            },
          });
          if (!claimed.count)
            throw conflict('INVALID_STATE', 'This transfer was just received.');
          const lines: LedgerLine[] = [];
          for (const item of sent) {
            const got = received.get(item.id)!;
            const lost = item.dispatchedQty!.minus(got);
            lines.push({
              productId: item.productId,
              batchId: item.batchId,
              qty: item.dispatchedQty!,
              type: 'TRANSFER_IN',
              unitCost: item.unitCost,
            });
            if (lost.gt(0))
              lines.push({
                productId: item.productId,
                batchId: item.batchId,
                qty: lost.negated(),
                type: 'TRANSFER_LOSS',
                unitCost: item.unitCost,
                reason: 'SHORT_RECEIPT',
              });
            await tx.stockTransferItem.update({
              where: { id: item.id },
              data: { receivedQty: got },
            });
          }
          await this.ledger.post(tx, {
            tenantId: auth.tenantId,
            storeId: t.toStoreId,
            refType: 'TRANSFER',
            refId: t.id,
            userId: auth.userId,
            lines,
          });
          await this.audit.record(
            {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: 'transfer.received',
              entity: 'stock_transfer',
              entityId: t.id,
              data: {
                lossLines: lines.filter((l) => l.type === 'TRANSFER_LOSS')
                  .length,
              },
              meta,
            },
            tx,
          );
          return this.view(tx, auth, await this.load(tx, auth, t.id));
        },
      ),
    );
  }

  /** Only before dispatch. Stock in transit is settled by receiving it (short, if need be). */
  cancel(auth: AuthContext, id: string, meta: RequestMeta) {
    assertPermission(auth, 'transfers:request');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const t = await this.load(tx, auth, id);
      const done = await tx.stockTransfer.updateMany({
        where: { id: t.id, tenantId: auth.tenantId, status: 'REQUESTED' },
        data: { status: 'CANCELLED' },
      });
      if (!done.count)
        throw conflict(
          'INVALID_STATE',
          'Only a transfer that has not been dispatched can be cancelled.',
        );
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'transfer.cancelled',
          entity: 'stock_transfer',
          entityId: t.id,
          meta,
        },
        tx,
      );
      return this.view(tx, auth, await this.load(tx, auth, t.id));
    });
  }
}
