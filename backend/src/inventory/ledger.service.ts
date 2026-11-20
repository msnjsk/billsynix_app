import { HttpStatus, Injectable } from '@nestjs/common';
import type { Tx } from '../database/prisma.service.js';
import { Decimal } from '../common/decimal.js';
import { AppException } from '../common/errors/app-exception.js';
import type {
  StockMovement,
  StockMovementType,
} from '../generated/prisma/client.js';

export type LedgerLine = {
  productId: string;
  /** Batch-tracked products: required for stock coming in; optional going out (FEFO). */
  batchId?: string | null | undefined;
  /** Signed: + in, − out. */
  qty: Decimal | string;
  type: StockMovementType;
  /** Cost per unit of stock coming in. Defaults to the current average cost. */
  unitCost?: Decimal | string | null | undefined;
  reason?: string | null | undefined;
  note?: string | null | undefined;
};

export type PostInput = {
  tenantId: string;
  storeId: string;
  refType: string;
  refId: string;
  userId?: string | null;
  lines: readonly LedgerLine[];
  /**
   * Offline sales synced later (Phase 9) are accepted even below zero; such movements are flagged
   * `negative` for reconciliation. Everything online is refused instead (STOCK_INSUFFICIENT).
   */
  allowNegative?: boolean;
};

const ZERO = new Decimal(0);

const unprocessable = (code: string, message: string, field?: string) =>
  new AppException(
    code,
    message,
    HttpStatus.UNPROCESSABLE_ENTITY,
    field ? [{ field, issue: message }] : undefined,
  );

type BalanceRow = { product_id: string; qty: Decimal; avg_cost: Decimal };
type BatchRow = {
  batch_id: string;
  product_id: string;
  qty: Decimal;
  expiry_date: Date | null;
  batch_no: string;
};

/** Earliest expiry first; batches without expiry last; then by batch number. */
export const fefo = (a: BatchRow, b: BatchRow) => {
  const ea = a.expiry_date?.getTime() ?? Number.POSITIVE_INFINITY;
  const eb = b.expiry_date?.getTime() ?? Number.POSITIVE_INFINITY;
  return ea - eb || a.batch_no.localeCompare(b.batch_no);
};

/**
 * The only code that changes stock. Each call, inside the caller's transaction:
 *   1. locks the branch balance rows of the products involved (product-id order, so two postings
 *      can't deadlock), then their batch rows;
 *   2. checks quantities against what is really there now — so two counters can't both sell the
 *      last unit;
 *   3. appends the movements and writes the new balances and weighted-average costs.
 * Either all of it commits with the caller's document, or none of it does.
 */
@Injectable()
export class LedgerService {
  async post(tx: Tx, input: PostInput): Promise<StockMovement[]> {
    const { tenantId, storeId } = input;
    if (!input.lines.length) return [];
    const store = await tx.store.findFirst({
      where: { id: storeId, tenantId },
      select: { status: true, name: true },
    });
    if (!store) throw unprocessable('INVALID_REFERENCE', 'Branch not found.');
    if (store.status !== 'ACTIVE')
      throw unprocessable('STORE_CLOSED', `${store.name} is closed.`);

    const lines = input.lines.map((l) => ({ ...l, qty: new Decimal(l.qty) }));
    const productIds = [...new Set(lines.map((l) => l.productId))].sort();
    const products = new Map(
      (
        await tx.product.findMany({
          where: { tenantId, id: { in: productIds } },
          include: { unit: true },
        })
      ).map((p) => [p.id, p]),
    );
    const batchIds = [
      ...new Set(lines.flatMap((l) => (l.batchId ? [l.batchId] : []))),
    ];
    const batches = new Map(
      (
        await tx.productBatch.findMany({
          where: { tenantId, id: { in: batchIds } },
        })
      ).map((b) => [b.id, b]),
    );

    lines.forEach((l, i) => {
      const f = `lines.${i}`;
      const p = products.get(l.productId);
      if (!p)
        throw unprocessable(
          'INVALID_REFERENCE',
          'Product not found.',
          `${f}.productId`,
        );
      if (!p.trackInventory)
        throw unprocessable(
          'NOT_STOCKED',
          `${p.name} doesn't keep stock.`,
          `${f}.productId`,
        );
      if (l.qty.isZero())
        throw unprocessable('INVALID_QTY', 'Quantity cannot be 0.', `${f}.qty`);
      if (l.qty.decimalPlaces() > p.unit.decimals)
        throw unprocessable(
          'INVALID_QTY',
          p.unit.decimals
            ? `${p.name} is counted to ${p.unit.decimals} decimal places.`
            : `${p.name} is counted in whole ${p.unit.code}.`,
          `${f}.qty`,
        );
      if (l.batchId) {
        const b = batches.get(l.batchId);
        if (!p.tracksBatches)
          throw unprocessable(
            'NOT_BATCH_TRACKED',
            `${p.name} isn't tracked by batch.`,
            `${f}.batchId`,
          );
        if (!b || b.productId !== p.id)
          throw unprocessable(
            'INVALID_REFERENCE',
            'Batch not found for this product.',
            `${f}.batchId`,
          );
      } else if (p.tracksBatches && l.qty.gt(0)) {
        throw unprocessable(
          'BATCH_REQUIRED',
          `Say which batch of ${p.name} this is.`,
          `${f}.batchId`,
        );
      }
    });

    // 1. Lock balances (creating missing rows first), in product-id order.
    await tx.$executeRaw`
      INSERT INTO stock_balances (tenant_id, store_id, product_id, updated_at)
      SELECT ${tenantId}::uuid, ${storeId}::uuid, p, now()
      FROM unnest(${productIds}::uuid[]) AS p ORDER BY p
      ON CONFLICT DO NOTHING`;
    const locked = await tx.$queryRaw<BalanceRow[]>`
      SELECT product_id::text AS product_id, qty, avg_cost FROM stock_balances
      WHERE store_id = ${storeId}::uuid AND product_id = ANY(${productIds}::uuid[])
      ORDER BY product_id FOR UPDATE`;
    const bal = new Map(
      locked.map((r) => [
        r.product_id,
        {
          qty: new Decimal(r.qty),
          avg: new Decimal(r.avg_cost),
          touched: false,
        },
      ]),
    );

    // 2. Lock batch rows of batch-tracked products, in batch-id order.
    const tracked = productIds.filter((id) => products.get(id)?.tracksBatches);
    const batchState = new Map<string, BatchRow & { touched: boolean }>();
    if (tracked.length) {
      if (batchIds.length) {
        const owners = batchIds.map((b) => batches.get(b)?.productId ?? '');
        await tx.$executeRaw`
          INSERT INTO batch_stocks (tenant_id, store_id, batch_id, product_id, updated_at)
          SELECT ${tenantId}::uuid, ${storeId}::uuid, b, p, now()
          FROM unnest(${batchIds}::uuid[], ${owners}::uuid[]) AS x(b, p) ORDER BY b
          ON CONFLICT DO NOTHING`;
      }
      const rows = await tx.$queryRaw<BatchRow[]>`
        SELECT bs.batch_id::text AS batch_id, bs.product_id::text AS product_id, bs.qty,
               pb.expiry_date, pb.batch_no
        FROM batch_stocks bs JOIN product_batches pb ON pb.id = bs.batch_id
        WHERE bs.store_id = ${storeId}::uuid AND bs.product_id = ANY(${tracked}::uuid[])
        ORDER BY bs.batch_id FOR UPDATE OF bs`;
      for (const r of rows)
        batchState.set(r.batch_id, {
          ...r,
          qty: new Decimal(r.qty),
          touched: false,
        });
    }

    // 3. Work out the movements.
    type Draft = {
      productId: string;
      batchId: string | null;
      qty: Decimal;
      unitCost: Decimal;
      balanceAfter: Decimal;
      negative: boolean;
      line: (typeof lines)[number];
    };
    const drafts: Draft[] = [];
    lines.forEach((l, i) => {
      const p = products.get(l.productId)!;
      const b = bal.get(l.productId)!;
      b.touched = true;
      if (l.qty.gt(0)) {
        const cost = l.unitCost != null ? new Decimal(l.unitCost) : b.avg;
        if (cost.lt(0))
          throw unprocessable(
            'INVALID_COST',
            'Cost cannot be negative.',
            `lines.${i}.unitCost`,
          );
        const after = b.qty.plus(l.qty);
        b.avg = b.qty.lte(0)
          ? cost
          : b.qty
              .times(b.avg)
              .plus(l.qty.times(cost))
              .dividedBy(after)
              .toDecimalPlaces(4);
        b.qty = after;
        if (l.batchId) {
          const s = batchState.get(l.batchId)!;
          s.qty = s.qty.plus(l.qty);
          s.touched = true;
        }
        drafts.push({
          productId: p.id,
          batchId: l.batchId ?? null,
          qty: l.qty,
          unitCost: cost,
          balanceAfter: after,
          negative: after.lt(0),
          line: l,
        });
        return;
      }
      // Going out, at the average cost.
      const out = l.qty.negated();
      if (b.qty.lt(out) && !input.allowNegative)
        throw new AppException(
          'STOCK_INSUFFICIENT',
          `Only ${b.qty.toFixed(p.unit.decimals)} ${p.unit.code} of ${p.name} in stock here.`,
          HttpStatus.CONFLICT,
          [{ field: `lines.${i}.qty`, issue: 'exceeds_stock' }],
        );
      const parts: { batchId: string | null; qty: Decimal }[] = [];
      if (!p.tracksBatches) parts.push({ batchId: null, qty: out });
      else if (l.batchId) {
        const s = batchState.get(l.batchId)!;
        if (s.qty.lt(out) && !input.allowNegative)
          throw new AppException(
            'STOCK_INSUFFICIENT',
            `Only ${s.qty.toFixed(p.unit.decimals)} of batch ${s.batch_no} of ${p.name} in stock here.`,
            HttpStatus.CONFLICT,
            [{ field: `lines.${i}.qty`, issue: 'exceeds_batch_stock' }],
          );
        parts.push({ batchId: l.batchId, qty: out });
      } else {
        let left = out;
        const available = [...batchState.values()]
          .filter((s) => s.product_id === p.id && s.qty.gt(0))
          .sort(fefo);
        for (const s of available) {
          if (left.isZero()) break;
          const take = Decimal.min(left, s.qty);
          parts.push({ batchId: s.batch_id, qty: take });
          left = left.minus(take);
        }
        // Only reachable with allowNegative: the shortfall has no batch to come from.
        if (left.gt(0)) parts.push({ batchId: null, qty: left });
      }
      // Normally stock leaves at the average cost. A caller may name the cost (a transfer loss is
      // valued at the transfer's cost); the remaining stock's average is then re-derived.
      const outCost = l.unitCost != null ? new Decimal(l.unitCost) : null;
      for (const part of parts) {
        if (part.batchId) {
          const s = batchState.get(part.batchId)!;
          s.qty = Decimal.max(ZERO, s.qty.minus(part.qty));
          s.touched = true;
        }
        const cost = outCost ?? b.avg;
        const after = b.qty.minus(part.qty);
        if (outCost && after.gt(0)) {
          const value = b.qty.times(b.avg).minus(part.qty.times(outCost));
          b.avg = Decimal.max(ZERO, value.dividedBy(after)).toDecimalPlaces(4);
        }
        b.qty = after;
        drafts.push({
          productId: p.id,
          batchId: part.batchId,
          qty: part.qty.negated(),
          unitCost: cost,
          balanceAfter: b.qty,
          negative: b.qty.lt(0),
          line: l,
        });
      }
    });

    // 4. Write ledger and balances.
    const movements = await tx.stockMovement.createManyAndReturn({
      data: drafts.map((d) => ({
        tenantId,
        storeId,
        productId: d.productId,
        batchId: d.batchId,
        type: d.line.type,
        qty: d.qty,
        unitCost: d.unitCost,
        balanceAfter: d.balanceAfter,
        refType: input.refType,
        refId: input.refId,
        reason: d.line.reason ?? null,
        note: d.line.note ?? null,
        negative: d.negative,
        userId: input.userId ?? null,
      })),
    });
    for (const [productId, b] of bal)
      if (b.touched)
        await tx.stockBalance.update({
          where: { storeId_productId: { storeId, productId } },
          data: { qty: b.qty, avgCost: b.avg, version: { increment: 1 } },
        });
    for (const s of batchState.values())
      if (s.touched)
        await tx.batchStock.update({
          where: { storeId_batchId: { storeId, batchId: s.batch_id } },
          data: { qty: s.qty },
        });
    return movements.sort((a, b) => (a.seq < b.seq ? -1 : 1));
  }

  /** Current quantity and average cost (no lock) — for estimates and count sheets. */
  async snapshot(
    tx: Tx,
    tenantId: string,
    storeId: string,
    productIds: string[],
  ) {
    const rows = await tx.stockBalance.findMany({
      where: { tenantId, storeId, productId: { in: productIds } },
    });
    return new Map(rows.map((r) => [r.productId, r]));
  }
}
