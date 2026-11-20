import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { Decimal } from '../common/decimal.js';
import { AppException } from '../common/errors/app-exception.js';
import {
  assertPermission,
  can,
  canAccessStore,
  type AuthContext,
} from '../auth/auth-context.js';
import type { PermissionKey } from '../access/permissions.js';
import { todayIn } from '../sales/sales.common.js';

/* ---------- queries ---------- */

export const rangeQuery = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  storeId: z.uuid().optional(),
});
export type RangeQuery = z.infer<typeof rangeQuery>;

export const periodQuery = rangeQuery.extend({
  groupBy: z.enum(['day', 'week', 'month']).default('day'),
});
export const productQuery = rangeQuery.extend({
  categoryId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});
export const storeOnlyQuery = z.object({ storeId: z.uuid().optional() });
export const expiryQuery = storeOnlyQuery.extend({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

/* ---------- helpers ---------- */

const ZERO = new Decimal(0);
const dec = (v: unknown) =>
  new Decimal((v as Decimal | string | number | null) ?? 0);
const m2 = (v: unknown) =>
  dec(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const q3 = (v: unknown) => dec(v).toFixed(3);
const pct = (part: Decimal, whole: Decimal) =>
  whole.isZero() ? null : Number(part.times(100).dividedBy(whole).toFixed(2));
const n = (v: unknown) => Number(v ?? 0);
const day = (d: Date | null | undefined) =>
  d ? d.toISOString().slice(0, 10) : null;

type Scope = { t: string; from: string; to: string; stores: string[] | null };

const bad = (message: string) =>
  new AppException('VALIDATION_FAILED', message, HttpStatus.BAD_REQUEST);

function scoped(
  auth: AuthContext,
  q: { storeId?: string | undefined; from?: string; to?: string },
) {
  if (q.storeId && !canAccessStore(auth, q.storeId))
    throw new AppException(
      'NOT_FOUND',
      'Branch not found.',
      HttpStatus.NOT_FOUND,
    );
  if (q.from && q.to) {
    if (q.from > q.to) throw bad('`from` is after `to`.');
    if ((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 > 400)
      throw bad('At most 400 days at a time.');
  }
  return {
    t: auth.tenantId,
    from: q.from ?? '1970-01-01',
    to: q.to ?? '2999-12-31',
    stores: q.storeId
      ? [q.storeId]
      : auth.storeIds === 'ALL'
        ? null
        : [...auth.storeIds],
  } satisfies Scope;
}

function assertAny(auth: AuthContext, keys: PermissionKey[]) {
  if (!keys.some((k) => can(auth, k))) assertPermission(auth, keys[0]!);
}

/**
 * Reports (Phase 10). One definition of the money everywhere:
 *
 *  - **net sales** = Σ payable of completed sales by their business date − Σ refunds of returns by
 *    the return's business date (what the customer was charged, net of what was given back);
 *  - **taxable / tax** likewise, from the stored snapshots (never today's rates);
 *  - **cost of goods** = Σ qty × the cost each line left stock at, less the same for returned
 *    units; **gross profit** = net taxable value − cost of goods;
 *  - per-product and per-category revenue is the lines' value before rupee round-off, so those
 *    reports carry the round-off to add back up to net sales (`reconciliation`).
 *
 * Aggregations run directly on the transaction tables with their (tenant, store, date) indexes;
 * summary tables can come later if real volumes need them.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private run<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>) {
    return this.prisma.withTenant(auth.tenantId, fn, { timeout: 30_000 });
  }

  /* ---------- sales ---------- */

  private async salesTotals(tx: Tx, s: Scope) {
    const [sales] = await tx.$queryRaw<
      {
        bills: bigint;
        payable: Decimal;
        taxable: Decimal;
        tax: Decimal;
        discounts: Decimal;
        round_off: Decimal;
        gross: Decimal;
        cost: Decimal;
      }[]
    >`
      SELECT COUNT(*) AS bills, COALESCE(SUM(s.payable), 0) AS payable, COALESCE(SUM(s.taxable), 0) AS taxable,
             COALESCE(SUM(s.cgst + s.sgst + s.igst + s.cess), 0) AS tax,
             COALESCE(SUM(s.line_discounts + s.bill_discount), 0) AS discounts,
             COALESCE(SUM(s.round_off), 0) AS round_off, COALESCE(SUM(s.gross), 0) AS gross,
             COALESCE(SUM(c.cost), 0) AS cost
      FROM sales s
      LEFT JOIN (SELECT sale_id, SUM(qty * unit_cost) AS cost FROM sale_items GROUP BY sale_id) c ON c.sale_id = s.id
      WHERE s.tenant_id = ${s.t}::uuid AND s.status = 'COMPLETED'
        AND s.business_date BETWEEN ${s.from}::date AND ${s.to}::date
        AND (${s.stores}::uuid[] IS NULL OR s.store_id = ANY(${s.stores}::uuid[]))`;
    const [ret] = await tx.$queryRaw<
      {
        count: bigint;
        refund: Decimal;
        taxable: Decimal;
        tax: Decimal;
        lines: Decimal;
        cost: Decimal;
      }[]
    >`
      SELECT COUNT(*) AS count, COALESCE(SUM(r.refund_amount), 0) AS refund, COALESCE(SUM(r.taxable), 0) AS taxable,
             COALESCE(SUM(r.cgst + r.sgst + r.igst + r.cess), 0) AS tax,
             COALESCE(SUM(i.amount), 0) AS lines, COALESCE(SUM(i.cost), 0) AS cost
      FROM sale_returns r
      LEFT JOIN (SELECT ri.return_id, SUM(ri.amount) AS amount, SUM(ri.qty * si.unit_cost) AS cost
                 FROM sale_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id GROUP BY ri.return_id) i ON i.return_id = r.id
      WHERE r.tenant_id = ${s.t}::uuid AND r.business_date BETWEEN ${s.from}::date AND ${s.to}::date
        AND (${s.stores}::uuid[] IS NULL OR r.store_id = ANY(${s.stores}::uuid[]))`;
    const net = dec(sales!.payable).minus(ret!.refund);
    const taxable = dec(sales!.taxable).minus(ret!.taxable);
    const cost = dec(sales!.cost).minus(ret!.cost);
    return {
      bills: n(sales!.bills),
      grossSales: dec(sales!.payable),
      discounts: dec(sales!.discounts),
      returns: n(ret!.count),
      refunds: dec(ret!.refund),
      netSales: net,
      taxable,
      tax: dec(sales!.tax).minus(ret!.tax),
      cost,
      grossProfit: taxable.minus(cost),
      saleRoundOff: dec(sales!.round_off),
      /** Refunds rounded to the rupee vs the returned lines' value. */
      returnRoundOff: dec(ret!.refund).minus(ret!.lines),
    };
  }

  /** Sales by day, ISO week (from Monday) or month, net of returns. */
  sales(auth: AuthContext, q: z.infer<typeof periodQuery>) {
    assertPermission(auth, 'reports:sales');
    const s = scoped(auth, q);
    const finance = can(auth, 'reports:finance');
    return this.run(auth, async (tx) => {
      const unit = q.groupBy;
      const sales = await tx.$queryRaw<
        {
          period: Date;
          bills: bigint;
          payable: Decimal;
          taxable: Decimal;
          tax: Decimal;
          discounts: Decimal;
          cost: Decimal;
        }[]
      >`
        SELECT date_trunc(${unit}, s.business_date::timestamp)::date AS period, COUNT(*) AS bills, SUM(s.payable) AS payable,
               SUM(s.taxable) AS taxable, SUM(s.cgst + s.sgst + s.igst + s.cess) AS tax,
               SUM(s.line_discounts + s.bill_discount) AS discounts, COALESCE(SUM(c.cost), 0) AS cost
        FROM sales s
        LEFT JOIN (SELECT sale_id, SUM(qty * unit_cost) AS cost FROM sale_items GROUP BY sale_id) c ON c.sale_id = s.id
        WHERE s.tenant_id = ${s.t}::uuid AND s.status = 'COMPLETED'
          AND s.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR s.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1 ORDER BY 1`;
      const rets = await tx.$queryRaw<
        {
          period: Date;
          count: bigint;
          refund: Decimal;
          taxable: Decimal;
          tax: Decimal;
          cost: Decimal;
        }[]
      >`
        SELECT date_trunc(${unit}, r.business_date::timestamp)::date AS period, COUNT(*) AS count, SUM(r.refund_amount) AS refund,
               SUM(r.taxable) AS taxable, SUM(r.cgst + r.sgst + r.igst + r.cess) AS tax, COALESCE(SUM(c.cost), 0) AS cost
        FROM sale_returns r
        LEFT JOIN (SELECT ri.return_id, SUM(ri.qty * si.unit_cost) AS cost
                   FROM sale_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id GROUP BY ri.return_id) c ON c.return_id = r.id
        WHERE r.tenant_id = ${s.t}::uuid AND r.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR r.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1`;
      const keys = [
        ...new Set([...sales, ...rets].map((r) => day(r.period)!)),
      ].sort();
      const periods = keys.map((k) => {
        const a = sales.find((x) => day(x.period) === k);
        const r = rets.find((x) => day(x.period) === k);
        const net = dec(a?.payable).minus(r?.refund ?? 0);
        const taxable = dec(a?.taxable).minus(r?.taxable ?? 0);
        const bills = n(a?.bills);
        return {
          period: k,
          bills,
          grossSales: m2(a?.payable),
          discounts: m2(a?.discounts),
          returns: n(r?.count),
          refunds: m2(r?.refund),
          netSales: m2(net),
          taxable: m2(taxable),
          tax: m2(dec(a?.tax).minus(r?.tax ?? 0)),
          averageBill: bills ? m2(dec(a?.payable).dividedBy(bills)) : '0.00',
          ...(finance
            ? {
                grossProfit: m2(
                  taxable.minus(dec(a?.cost).minus(r?.cost ?? 0)),
                ),
              }
            : {}),
        };
      });
      const t = await this.salesTotals(tx, s);
      return {
        from: q.from,
        to: q.to,
        storeId: q.storeId ?? null,
        groupBy: unit,
        totals: {
          bills: t.bills,
          grossSales: m2(t.grossSales),
          discounts: m2(t.discounts),
          returns: t.returns,
          refunds: m2(t.refunds),
          netSales: m2(t.netSales),
          taxable: m2(t.taxable),
          tax: m2(t.tax),
          averageBill: t.bills ? m2(t.grossSales.dividedBy(t.bills)) : '0.00',
          ...(finance
            ? {
                costOfGoods: m2(t.cost),
                grossProfit: m2(t.grossProfit),
                grossMarginPct: pct(t.grossProfit, t.taxable),
              }
            : {}),
        },
        periods,
      };
    });
  }

  /** Each branch and counter. Returns count where they were taken. */
  byLocation(auth: AuthContext, q: RangeQuery) {
    assertPermission(auth, 'reports:sales');
    const s = scoped(auth, q);
    return this.run(auth, async (tx) => {
      const sales = await tx.$queryRaw<
        {
          store_id: string;
          counter_id: string;
          bills: bigint;
          payable: Decimal;
          taxable: Decimal;
        }[]
      >`
        SELECT s.store_id::text, s.counter_id::text, COUNT(*) AS bills, SUM(s.payable) AS payable, SUM(s.taxable) AS taxable
        FROM sales s
        WHERE s.tenant_id = ${s.t}::uuid AND s.status = 'COMPLETED'
          AND s.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR s.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1, 2`;
      const rets = await tx.$queryRaw<
        {
          store_id: string;
          counter_id: string;
          count: bigint;
          refund: Decimal;
        }[]
      >`
        SELECT r.store_id::text, r.counter_id::text, COUNT(*) AS count, SUM(r.refund_amount) AS refund
        FROM sale_returns r
        WHERE r.tenant_id = ${s.t}::uuid AND r.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR r.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1, 2`;
      const counters = await tx.counter.findMany({
        where: {
          tenantId: s.t,
          id: {
            in: [...new Set([...sales, ...rets].map((x) => x.counter_id))],
          },
        },
        include: { store: { select: { id: true, code: true, name: true } } },
      });
      const byCounter = counters.map((c) => {
        const a = sales.filter((x) => x.counter_id === c.id);
        const r = rets.filter((x) => x.counter_id === c.id);
        const payable = a.reduce((x, y) => x.plus(y.payable), ZERO);
        const refund = r.reduce((x, y) => x.plus(y.refund), ZERO);
        return {
          store: c.store,
          counter: { id: c.id, number: c.number, name: c.name },
          bills: a.reduce((x, y) => x + n(y.bills), 0),
          grossSales: payable,
          returns: r.reduce((x, y) => x + n(y.count), 0),
          refunds: refund,
          netSales: payable.minus(refund),
        };
      });
      const stores = [
        ...new Map(byCounter.map((c) => [c.store.id, c.store])).values(),
      ].map((st) => {
        const cs = byCounter.filter((c) => c.store.id === st.id);
        const sum = (f: (c: (typeof cs)[number]) => Decimal) =>
          cs.reduce((x, c) => x.plus(f(c)), ZERO);
        return {
          store: st,
          bills: cs.reduce((x, c) => x + c.bills, 0),
          grossSales: m2(sum((c) => c.grossSales)),
          returns: cs.reduce((x, c) => x + c.returns, 0),
          refunds: m2(sum((c) => c.refunds)),
          netSales: m2(sum((c) => c.netSales)),
          counters: cs
            .sort((a, b) => a.counter.number - b.counter.number)
            .map((c) => ({
              counter: c.counter,
              bills: c.bills,
              grossSales: m2(c.grossSales),
              returns: c.returns,
              refunds: m2(c.refunds),
              netSales: m2(c.netSales),
            })),
        };
      });
      const net = byCounter.reduce((x, c) => x.plus(c.netSales), ZERO);
      return {
        from: q.from,
        to: q.to,
        totals: {
          bills: byCounter.reduce((x, c) => x + c.bills, 0),
          netSales: m2(net),
        },
        stores: stores.sort((a, b) => Number(b.netSales) - Number(a.netSales)),
      };
    });
  }

  /** Product lines sold in the period and returned in it (by date), with margin for finance. */
  private async productRows(tx: Tx, s: Scope) {
    return tx.$queryRaw<
      {
        product_id: string;
        sku: string;
        name: string;
        root_id: string | null;
        root_name: string | null;
        units: Decimal;
        ret_units: Decimal;
        revenue: Decimal;
        ret_revenue: Decimal;
        taxable: Decimal;
        ret_taxable: Decimal;
        cost: Decimal;
        ret_cost: Decimal;
        bills: bigint;
      }[]
    >`
      WITH RECURSIVE tree AS (
        SELECT id, id AS root_id, name AS root_name FROM categories WHERE tenant_id = ${s.t}::uuid AND parent_id IS NULL
        UNION ALL
        SELECT c.id, t.root_id, t.root_name FROM categories c JOIN tree t ON c.parent_id = t.id
      ),
      sold AS (
        SELECT i.product_id, SUM(i.qty) AS units, SUM(i.final) AS revenue, SUM(i.taxable) AS taxable,
               SUM(i.qty * i.unit_cost) AS cost, COUNT(DISTINCT i.sale_id) AS bills
        FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.tenant_id = ${s.t}::uuid AND s.status = 'COMPLETED'
          AND s.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR s.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY i.product_id
      ),
      back AS (
        SELECT si.product_id, SUM(ri.qty) AS units, SUM(ri.amount) AS revenue, SUM(ri.taxable) AS taxable,
               SUM(ri.qty * si.unit_cost) AS cost
        FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id JOIN sale_items si ON si.id = ri.sale_item_id
        WHERE r.tenant_id = ${s.t}::uuid AND r.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR r.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY si.product_id
      )
      SELECT p.id::text AS product_id, p.sku, p.name, tree.root_id::text, tree.root_name,
             COALESCE(sold.units, 0) AS units, COALESCE(back.units, 0) AS ret_units,
             COALESCE(sold.revenue, 0) AS revenue, COALESCE(back.revenue, 0) AS ret_revenue,
             COALESCE(sold.taxable, 0) AS taxable, COALESCE(back.taxable, 0) AS ret_taxable,
             COALESCE(sold.cost, 0) AS cost, COALESCE(back.cost, 0) AS ret_cost, COALESCE(sold.bills, 0) AS bills
      FROM products p
      LEFT JOIN sold ON sold.product_id = p.id
      LEFT JOIN back ON back.product_id = p.id
      LEFT JOIN tree ON tree.id = p.category_id
      WHERE p.tenant_id = ${s.t}::uuid AND (sold.product_id IS NOT NULL OR back.product_id IS NOT NULL)`;
  }

  private line(
    r: Awaited<ReturnType<AnalyticsService['productRows']>>[number],
    finance: boolean,
  ) {
    const revenue = dec(r.revenue).minus(r.ret_revenue);
    const taxable = dec(r.taxable).minus(r.ret_taxable);
    const cost = dec(r.cost).minus(r.ret_cost);
    return {
      units: dec(r.units).minus(r.ret_units),
      unitsReturned: dec(r.ret_units),
      revenue,
      taxable,
      ...(finance ? { cost, profit: taxable.minus(cost) } : {}),
    };
  }

  private async reconciliation(tx: Tx, s: Scope, linesTotal: Decimal) {
    const t = await this.salesTotals(tx, s);
    // Σ lines + sales' round-off − (refunds − returned lines) = net sales.
    const rebuilt = linesTotal.plus(t.saleRoundOff).minus(t.returnRoundOff);
    return {
      linesTotal: m2(linesTotal),
      saleRoundOff: m2(t.saleRoundOff),
      returnRoundOff: m2(t.returnRoundOff),
      netSales: m2(t.netSales),
      matches: rebuilt.eq(t.netSales),
    };
  }

  products(auth: AuthContext, q: z.infer<typeof productQuery>) {
    assertPermission(auth, 'reports:sales');
    const s = scoped(auth, q);
    const finance = can(auth, 'reports:finance');
    return this.run(auth, async (tx) => {
      const rows = (await this.productRows(tx, s)).filter(
        (r) => !q.categoryId || r.root_id === q.categoryId,
      );
      const lines = rows
        .map((r) => ({ r, l: this.line(r, finance) }))
        .sort((a, b) => b.l.revenue.comparedTo(a.l.revenue));
      const total = lines.reduce((x, y) => x.plus(y.l.revenue), ZERO);
      return {
        from: q.from,
        to: q.to,
        totals: {
          products: lines.length,
          revenue: m2(total),
          ...(finance
            ? {
                cost: m2(lines.reduce((x, y) => x.plus(y.l.cost!), ZERO)),
                profit: m2(lines.reduce((x, y) => x.plus(y.l.profit!), ZERO)),
              }
            : {}),
        },
        ...(q.categoryId
          ? {}
          : { reconciliation: await this.reconciliation(tx, s, total) }),
        data: lines.slice(0, q.limit).map(({ r, l }) => ({
          productId: r.product_id,
          sku: r.sku,
          name: r.name,
          category: r.root_id ? { id: r.root_id, name: r.root_name } : null,
          bills: n(r.bills),
          units: q3(l.units),
          unitsReturned: q3(l.unitsReturned),
          revenue: m2(l.revenue),
          sharePct: pct(l.revenue, total),
          ...(finance
            ? {
                cost: m2(l.cost),
                profit: m2(l.profit),
                marginPct: pct(l.profit!, l.taxable),
              }
            : {}),
        })),
      };
    });
  }

  /** Top-level categories (departments); uncategorised products together. */
  categories(auth: AuthContext, q: RangeQuery) {
    assertPermission(auth, 'reports:sales');
    const s = scoped(auth, q);
    const finance = can(auth, 'reports:finance');
    return this.run(auth, async (tx) => {
      const rows = await this.productRows(tx, s);
      const groups = new Map<
        string,
        {
          id: string | null;
          name: string;
          products: number;
          units: Decimal;
          revenue: Decimal;
          taxable: Decimal;
          cost: Decimal;
        }
      >();
      for (const r of rows) {
        const k = r.root_id ?? '-';
        const g = groups.get(k) ?? {
          id: r.root_id,
          name: r.root_name ?? 'Uncategorised',
          products: 0,
          units: ZERO,
          revenue: ZERO,
          taxable: ZERO,
          cost: ZERO,
        };
        const l = this.line(r, true);
        g.products++;
        g.units = g.units.plus(l.units);
        g.revenue = g.revenue.plus(l.revenue);
        g.taxable = g.taxable.plus(l.taxable);
        g.cost = g.cost.plus(l.cost!);
        groups.set(k, g);
      }
      const total = [...groups.values()].reduce(
        (x, g) => x.plus(g.revenue),
        ZERO,
      );
      return {
        from: q.from,
        to: q.to,
        totals: { revenue: m2(total) },
        reconciliation: await this.reconciliation(tx, s, total),
        data: [...groups.values()]
          .sort((a, b) => b.revenue.comparedTo(a.revenue))
          .map((g) => ({
            category: g.id ? { id: g.id, name: g.name } : null,
            name: g.name,
            products: g.products,
            units: q3(g.units),
            revenue: m2(g.revenue),
            sharePct: pct(g.revenue, total),
            ...(finance
              ? {
                  cost: m2(g.cost),
                  profit: m2(g.taxable.minus(g.cost)),
                  marginPct: pct(g.taxable.minus(g.cost), g.taxable),
                }
              : {}),
          })),
      };
    });
  }

  /* ---------- stock ---------- */

  /** Stock on hand at average cost, at today's branch selling price and at MRP. */
  inventoryValuation(auth: AuthContext, q: z.infer<typeof storeOnlyQuery>) {
    assertPermission(auth, 'reports:finance');
    const s = scoped(auth, q);
    return this.run(auth, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          store_id: string;
          root_name: string | null;
          lines: bigint;
          qty: Decimal;
          cost_value: Decimal;
          sell_value: Decimal;
          mrp_value: Decimal;
          negative_lines: bigint;
          negative_value: Decimal;
        }[]
      >`
        WITH RECURSIVE tree AS (
          SELECT id, name AS root_name FROM categories WHERE tenant_id = ${s.t}::uuid AND parent_id IS NULL
          UNION ALL SELECT c.id, t.root_name FROM categories c JOIN tree t ON c.parent_id = t.id
        )
        SELECT b.store_id::text, tree.root_name,
               COUNT(*) FILTER (WHERE b.qty > 0) AS lines,
               COALESCE(SUM(b.qty) FILTER (WHERE b.qty > 0), 0) AS qty,
               COALESCE(SUM(b.qty * b.avg_cost) FILTER (WHERE b.qty > 0), 0) AS cost_value,
               COALESCE(SUM(b.qty * COALESCE(pp.selling_price, p.selling_price)) FILTER (WHERE b.qty > 0), 0) AS sell_value,
               COALESCE(SUM(b.qty * p.mrp) FILTER (WHERE b.qty > 0 AND p.mrp IS NOT NULL), 0) AS mrp_value,
               COUNT(*) FILTER (WHERE b.qty < 0) AS negative_lines,
               COALESCE(SUM(b.qty * b.avg_cost) FILTER (WHERE b.qty < 0), 0) AS negative_value
        FROM stock_balances b
        JOIN products p ON p.id = b.product_id
        JOIN stores st ON st.id = b.store_id
        LEFT JOIN price_lists pl ON pl.id = st.price_list_id AND pl.is_active
        LEFT JOIN product_prices pp ON pp.price_list_id = pl.id AND pp.product_id = p.id
        LEFT JOIN tree ON tree.id = p.category_id
        WHERE b.tenant_id = ${s.t}::uuid AND b.qty <> 0
          AND (${s.stores}::uuid[] IS NULL OR b.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1, 2`;
      const stores = await tx.store.findMany({
        where: {
          tenantId: s.t,
          id: { in: [...new Set(rows.map((r) => r.store_id))] },
        },
        select: { id: true, code: true, name: true },
      });
      const agg = (rs: typeof rows) => ({
        lines: rs.reduce((x, r) => x + n(r.lines), 0),
        qty: q3(rs.reduce((x, r) => x.plus(r.qty), ZERO)),
        atCost: m2(rs.reduce((x, r) => x.plus(r.cost_value), ZERO)),
        atSellingPrice: m2(rs.reduce((x, r) => x.plus(r.sell_value), ZERO)),
        atMrp: m2(rs.reduce((x, r) => x.plus(r.mrp_value), ZERO)),
        negativeLines: rs.reduce((x, r) => x + n(r.negative_lines), 0),
        negativeAtCost: m2(rs.reduce((x, r) => x.plus(r.negative_value), ZERO)),
      });
      return {
        asOf: new Date(),
        basis:
          'Weighted average cost per branch (ADR-006); selling price = the branch price today.',
        totals: agg(rows),
        stores: stores.map((st) => {
          const rs = rows.filter((r) => r.store_id === st.id);
          return {
            store: st,
            ...agg(rs),
            categories: [
              ...new Set(rs.map((r) => r.root_name ?? 'Uncategorised')),
            ]
              .sort()
              .map((name) => ({
                name,
                ...agg(
                  rs.filter((r) => (r.root_name ?? 'Uncategorised') === name),
                ),
              })),
          };
        }),
      };
    });
  }

  /** What moved stock, by movement type and (adjustments, write-offs) reason, with value. */
  stockMovements(auth: AuthContext, q: RangeQuery) {
    assertPermission(auth, 'inventory:read');
    const s = scoped(auth, q);
    return this.run(auth, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          type: string;
          reason: string | null;
          movements: bigint;
          qty_in: Decimal;
          qty_out: Decimal;
          value_in: Decimal;
          value_out: Decimal;
          negative: bigint;
        }[]
      >`
        SELECT m.type::text, CASE WHEN m.type IN ('ADJUSTMENT', 'WRITE_OFF', 'COUNT_ADJUSTMENT') THEN m.reason END AS reason,
               COUNT(*) AS movements,
               COALESCE(SUM(m.qty) FILTER (WHERE m.qty > 0), 0) AS qty_in,
               COALESCE(-SUM(m.qty) FILTER (WHERE m.qty < 0), 0) AS qty_out,
               COALESCE(SUM(m.qty * m.unit_cost) FILTER (WHERE m.qty > 0), 0) AS value_in,
               COALESCE(-SUM(m.qty * m.unit_cost) FILTER (WHERE m.qty < 0), 0) AS value_out,
               COUNT(*) FILTER (WHERE m.negative) AS negative
        FROM stock_movements m
        WHERE m.tenant_id = ${s.t}::uuid
          AND m.created_at >= (${s.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
          AND m.created_at < (${s.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
          AND (${s.stores}::uuid[] IS NULL OR m.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1, 2 ORDER BY 1, 2`;
      const data = rows.map((r) => ({
        type: r.type,
        reason: r.reason,
        movements: n(r.movements),
        qtyIn: q3(r.qty_in),
        qtyOut: q3(r.qty_out),
        valueIn: m2(r.value_in),
        valueOut: m2(r.value_out),
        belowZero: n(r.negative),
      }));
      const shrink = rows.filter(
        (r) => r.type === 'WRITE_OFF' || r.type === 'TRANSFER_LOSS',
      );
      return {
        from: q.from,
        to: q.to,
        totals: {
          valueIn: m2(rows.reduce((x, r) => x.plus(r.value_in), ZERO)),
          valueOut: m2(rows.reduce((x, r) => x.plus(r.value_out), ZERO)),
          /** Damaged, expired, wasted, stolen and lost in transit, at cost. */
          shrinkageAtCost: m2(
            shrink.reduce((x, r) => x.plus(r.value_out), ZERO),
          ),
        },
        data,
      };
    });
  }

  /** Batches with stock that have expired or expire within `days`, valued at average cost. */
  expiry(auth: AuthContext, q: z.infer<typeof expiryQuery>) {
    assertPermission(auth, 'inventory:read');
    const s = scoped(auth, q);
    return this.run(auth, async (tx) => {
      const today = todayIn('Asia/Kolkata');
      const rows = await tx.$queryRaw<
        {
          store_id: string;
          product_id: string;
          sku: string;
          name: string;
          batch_no: string;
          expiry_date: Date;
          qty: Decimal;
          avg_cost: Decimal;
          mrp: Decimal | null;
        }[]
      >`
        SELECT bs.store_id::text, p.id::text AS product_id, p.sku, p.name, pb.batch_no, pb.expiry_date, bs.qty,
               COALESCE(b.avg_cost, 0) AS avg_cost, p.mrp
        FROM batch_stocks bs
        JOIN product_batches pb ON pb.id = bs.batch_id
        JOIN products p ON p.id = bs.product_id
        LEFT JOIN stock_balances b ON b.store_id = bs.store_id AND b.product_id = bs.product_id
        WHERE bs.tenant_id = ${s.t}::uuid AND bs.qty > 0 AND pb.expiry_date IS NOT NULL
          AND pb.expiry_date <= ${today}::date + ${q.days}::int
          AND (${s.stores}::uuid[] IS NULL OR bs.store_id = ANY(${s.stores}::uuid[]))
        ORDER BY pb.expiry_date, p.name`;
      const t0 = Date.parse(today);
      const data = rows.map((r) => {
        const daysLeft = Math.round(
          (r.expiry_date.getTime() - t0) / 86_400_000,
        );
        const value = dec(r.qty).times(r.avg_cost);
        return {
          storeId: r.store_id,
          product: { id: r.product_id, sku: r.sku, name: r.name },
          batchNo: r.batch_no,
          expiryDate: day(r.expiry_date),
          daysLeft,
          bucket:
            daysLeft < 0
              ? 'EXPIRED'
              : daysLeft <= 7
                ? 'WITHIN_7_DAYS'
                : daysLeft <= 30
                  ? 'WITHIN_30_DAYS'
                  : 'LATER',
          qty: q3(r.qty),
          valueAtCost: m2(value),
          valueAtMrp: r.mrp ? m2(dec(r.qty).times(r.mrp)) : null,
        };
      });
      const sum = (b?: string) =>
        m2(
          data
            .filter((d) => !b || d.bucket === b)
            .reduce((x, d) => x.plus(d.valueAtCost), ZERO),
        );
      return {
        asOf: today,
        days: q.days,
        totals: {
          atRisk: sum(),
          expired: sum('EXPIRED'),
          within7Days: sum('WITHIN_7_DAYS'),
          within30Days: sum('WITHIN_30_DAYS'),
        },
        data,
      };
    });
  }

  /* ---------- purchases ---------- */

  /** Per supplier: bought, returned and paid in the period; owed now. */
  purchases(auth: AuthContext, q: RangeQuery) {
    assertPermission(auth, 'reports:finance');
    const s = scoped(auth, q);
    return this.run(auth, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          name: string;
          balance: Decimal;
          receipts: bigint;
          purchased: Decimal;
          taxable: Decimal;
          tax: Decimal;
          returned: Decimal;
          paid: Decimal;
          refunded: Decimal;
        }[]
      >`
        SELECT sp.id::text, sp.name, sp.balance,
               COALESCE(g.n, 0) AS receipts, COALESCE(g.total, 0) AS purchased, COALESCE(g.taxable, 0) AS taxable, COALESCE(g.tax, 0) AS tax,
               COALESCE(r.total, 0) AS returned, COALESCE(pay.out_amt, 0) AS paid, COALESCE(pay.in_amt, 0) AS refunded
        FROM suppliers sp
        LEFT JOIN (SELECT supplier_id, COUNT(*) AS n, SUM(total) AS total, SUM(taxable) AS taxable, SUM(cgst + sgst + igst + cess) AS tax
                   FROM goods_receipts WHERE tenant_id = ${s.t}::uuid AND received_date BETWEEN ${s.from}::date AND ${s.to}::date
                     AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[])) GROUP BY 1) g ON g.supplier_id = sp.id
        LEFT JOIN (SELECT supplier_id, SUM(total) AS total
                   FROM purchase_returns WHERE tenant_id = ${s.t}::uuid AND return_date BETWEEN ${s.from}::date AND ${s.to}::date
                     AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[])) GROUP BY 1) r ON r.supplier_id = sp.id
        LEFT JOIN (SELECT supplier_id, SUM(amount) FILTER (WHERE direction = 'OUT') AS out_amt, SUM(amount) FILTER (WHERE direction = 'IN') AS in_amt
                   FROM supplier_payments WHERE tenant_id = ${s.t}::uuid AND paid_on BETWEEN ${s.from}::date AND ${s.to}::date GROUP BY 1) pay ON pay.supplier_id = sp.id
        WHERE sp.tenant_id = ${s.t}::uuid AND (g.n IS NOT NULL OR r.total IS NOT NULL OR pay.out_amt IS NOT NULL OR pay.in_amt IS NOT NULL OR sp.balance <> 0)
        ORDER BY COALESCE(g.total, 0) DESC, sp.name`;
      const sum = (f: (r: (typeof rows)[number]) => unknown) =>
        m2(rows.reduce((x, r) => x.plus(dec(f(r))), ZERO));
      return {
        from: q.from,
        to: q.to,
        note: 'Payments and what is owed are business-wide (they are not per branch).',
        totals: {
          receipts: rows.reduce((x, r) => x + n(r.receipts), 0),
          purchased: sum((r) => r.purchased),
          taxable: sum((r) => r.taxable),
          tax: sum((r) => r.tax),
          returned: sum((r) => r.returned),
          paid: sum((r) => r.paid),
          refunded: sum((r) => r.refunded),
          outstanding: sum((r) => (dec(r.balance).gt(0) ? r.balance : 0)),
        },
        data: rows.map((r) => ({
          supplier: { id: r.id, name: r.name },
          receipts: n(r.receipts),
          purchased: m2(r.purchased),
          taxable: m2(r.taxable),
          tax: m2(r.tax),
          returned: m2(r.returned),
          paid: m2(r.paid),
          refunded: m2(r.refunded),
          outstanding: m2(r.balance),
        })),
      };
    });
  }

  /* ---------- people and money ---------- */

  /** Per cashier over a period: bills, value, discounts, voids, returns and drawer variance. */
  cashiers(auth: AuthContext, q: RangeQuery) {
    assertPermission(auth, 'cash:reconcile');
    const s = scoped(auth, q);
    return this.run(auth, async (tx) => {
      const sales = await tx.$queryRaw<
        {
          user_id: string;
          bills: bigint;
          revenue: Decimal;
          discounts: Decimal;
          approved: bigint;
          items: Decimal;
          voids: bigint;
          voided: Decimal;
        }[]
      >`
        SELECT s.cashier_user_id::text AS user_id,
               COUNT(*) FILTER (WHERE s.status = 'COMPLETED') AS bills,
               COALESCE(SUM(s.payable) FILTER (WHERE s.status = 'COMPLETED'), 0) AS revenue,
               COALESCE(SUM(s.line_discounts + s.bill_discount) FILTER (WHERE s.status = 'COMPLETED'), 0) AS discounts,
               COUNT(*) FILTER (WHERE s.status = 'COMPLETED' AND s.discount_approved_by IS NOT NULL) AS approved,
               COALESCE(SUM(i.lines) FILTER (WHERE s.status = 'COMPLETED'), 0) AS items,
               COUNT(*) FILTER (WHERE s.status = 'VOIDED') AS voids,
               COALESCE(SUM(s.payable) FILTER (WHERE s.status = 'VOIDED'), 0) AS voided
        FROM sales s
        LEFT JOIN (SELECT sale_id, COUNT(*) AS lines FROM sale_items GROUP BY 1) i ON i.sale_id = s.id
        WHERE s.tenant_id = ${s.t}::uuid AND s.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR s.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1`;
      const rets = await tx.$queryRaw<
        { user_id: string; returns: bigint; refunds: Decimal }[]
      >`
        SELECT created_by_user_id::text AS user_id, COUNT(*) AS returns, SUM(refund_amount) AS refunds
        FROM sale_returns
        WHERE tenant_id = ${s.t}::uuid AND business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1`;
      const drawers = await tx.$queryRaw<
        {
          user_id: string;
          sessions: bigint;
          variance: Decimal;
          short: Decimal;
          review: bigint;
        }[]
      >`
        SELECT user_id::text, COUNT(*) AS sessions, COALESCE(SUM(variance), 0) AS variance,
               COALESCE(SUM(variance) FILTER (WHERE variance < 0), 0) AS short,
               COUNT(*) FILTER (WHERE status = 'PENDING_REVIEW') AS review
        FROM cash_sessions
        WHERE tenant_id = ${s.t}::uuid AND status <> 'OPEN'
          AND closed_at >= (${s.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
          AND closed_at < (${s.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
          AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1`;
      const ids = [
        ...new Set([...sales, ...rets, ...drawers].map((r) => r.user_id)),
      ];
      const users = new Map(
        (
          await tx.user.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          })
        ).map((u) => [u.id, u.name]),
      );
      return {
        from: q.from,
        to: q.to,
        data: ids
          .map((id) => {
            const a = sales.find((x) => x.user_id === id);
            const r = rets.find((x) => x.user_id === id);
            const d = drawers.find((x) => x.user_id === id);
            const bills = n(a?.bills);
            return {
              cashier: { id, name: users.get(id) ?? null },
              bills,
              revenue: m2(a?.revenue),
              averageBill: bills
                ? m2(dec(a?.revenue).dividedBy(bills))
                : '0.00',
              linesPerBill: bills
                ? Number(dec(a?.items).dividedBy(bills).toFixed(1))
                : 0,
              discounts: m2(a?.discounts),
              discountsApproved: n(a?.approved),
              voids: n(a?.voids),
              voidedValue: m2(a?.voided),
              returns: n(r?.returns),
              refunds: m2(r?.refunds),
              drawers: n(d?.sessions),
              drawerVariance: m2(d?.variance),
              drawerShort: m2(d?.short),
              drawersAwaitingReview: n(d?.review),
            };
          })
          .sort((x, y) => Number(y.revenue) - Number(x.revenue)),
      };
    });
  }

  expenses(auth: AuthContext, q: RangeQuery) {
    assertAny(auth, ['reports:finance', 'expenses:write']);
    const s = scoped(auth, q);
    return this.run(auth, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          category: string;
          mode: string;
          month: Date;
          store_id: string;
          count: bigint;
          amount: Decimal;
          gst: Decimal;
        }[]
      >`
        SELECT c.name AS category, e.mode::text, date_trunc('month', e.spent_on::timestamp)::date AS month, e.store_id::text,
               COUNT(*) AS count, SUM(e.amount) AS amount, SUM(e.gst_amount) AS gst
        FROM expenses e JOIN expense_categories c ON c.id = e.category_id
        WHERE e.tenant_id = ${s.t}::uuid AND e.status = 'RECORDED'
          AND e.spent_on BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR e.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1, 2, 3, 4`;
      const group = (key: (r: (typeof rows)[number]) => string) => {
        const m = new Map<
          string,
          { count: number; amount: Decimal; gst: Decimal }
        >();
        for (const r of rows) {
          const g = m.get(key(r)) ?? { count: 0, amount: ZERO, gst: ZERO };
          g.count += n(r.count);
          g.amount = g.amount.plus(r.amount);
          g.gst = g.gst.plus(r.gst);
          m.set(key(r), g);
        }
        return [...m.entries()]
          .sort((a, b) => b[1].amount.comparedTo(a[1].amount))
          .map(([k, g]) => ({
            key: k,
            count: g.count,
            amount: m2(g.amount),
            gst: m2(g.gst),
          }));
      };
      const total = rows.reduce((x, r) => x.plus(r.amount), ZERO);
      return {
        from: q.from,
        to: q.to,
        totals: {
          count: rows.reduce((x, r) => x + n(r.count), 0),
          amount: m2(total),
          gst: m2(rows.reduce((x, r) => x.plus(r.gst), ZERO)),
        },
        byCategory: group((r) => r.category).map(({ key, ...g }) => ({
          category: key,
          ...g,
          sharePct: pct(dec(g.amount), total),
        })),
        byMode: group((r) => r.mode).map(({ key, ...g }) => ({
          mode: key,
          ...g,
        })),
        byMonth: group((r) => day(r.month)!)
          .sort((a, b) => a.key.localeCompare(b.key))
          .map(({ key, ...g }) => ({ month: key, ...g })),
        byStore: group((r) => r.store_id).map(({ key, ...g }) => ({
          storeId: key,
          ...g,
        })),
      };
    });
  }

  /**
   * GST summary for the period: outward supplies by rate (net of credit notes), B2B / B2C, HSN,
   * and input tax on goods received. A working summary for the GST professional — not a return.
   */
  gst(auth: AuthContext, q: RangeQuery) {
    assertPermission(auth, 'reports:finance');
    const s = scoped(auth, q);
    return this.run(auth, async (tx) => {
      const out = await tx.$queryRaw<
        {
          rate: Decimal;
          lines: bigint;
          taxable: Decimal;
          cgst: Decimal;
          sgst: Decimal;
          igst: Decimal;
          cess: Decimal;
        }[]
      >`
        SELECT i.gst_rate AS rate, COUNT(*) AS lines, SUM(i.taxable) AS taxable, SUM(i.cgst) AS cgst, SUM(i.sgst) AS sgst,
               SUM(i.igst) AS igst, SUM(i.cess) AS cess
        FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.tenant_id = ${s.t}::uuid AND s.status = 'COMPLETED' AND s.document_type = 'TAX_INVOICE'
          AND s.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR s.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1 ORDER BY 1`;
      const cn = await tx.$queryRaw<
        {
          rate: Decimal;
          notes: bigint;
          taxable: Decimal;
          gst: Decimal;
          cess: Decimal;
          inter: Decimal;
        }[]
      >`
        SELECT si.gst_rate AS rate, COUNT(DISTINCT r.id) AS notes, SUM(ri.taxable) AS taxable,
               SUM(CASE WHEN si.gst_rate + si.cess_rate > 0 THEN ROUND(ri.tax * si.gst_rate / (si.gst_rate + si.cess_rate), 2) ELSE 0 END) AS gst,
               SUM(CASE WHEN si.gst_rate + si.cess_rate > 0 THEN ri.tax - ROUND(ri.tax * si.gst_rate / (si.gst_rate + si.cess_rate), 2) ELSE 0 END) AS cess,
               SUM(CASE WHEN s.inter_state AND si.gst_rate + si.cess_rate > 0 THEN ROUND(ri.tax * si.gst_rate / (si.gst_rate + si.cess_rate), 2) ELSE 0 END) AS inter
        FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id
        JOIN sale_items si ON si.id = ri.sale_item_id JOIN sales s ON s.id = r.sale_id
        WHERE r.tenant_id = ${s.t}::uuid AND s.document_type = 'TAX_INVOICE'
          AND r.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR r.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1`;
      const b2 = await tx.$queryRaw<
        {
          b2b: boolean;
          invoices: bigint;
          taxable: Decimal;
          tax: Decimal;
          value: Decimal;
        }[]
      >`
        SELECT s.buyer_gstin IS NOT NULL AS b2b, COUNT(*) AS invoices, SUM(s.taxable) AS taxable,
               SUM(s.cgst + s.sgst + s.igst + s.cess) AS tax, SUM(s.payable) AS value
        FROM sales s
        WHERE s.tenant_id = ${s.t}::uuid AND s.status = 'COMPLETED' AND s.document_type = 'TAX_INVOICE'
          AND s.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR s.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1`;
      const b2bList = await tx.$queryRaw<
        {
          invoice_no: string;
          business_date: Date;
          buyer_gstin: string;
          buyer_name: string | null;
          place_of_supply: string;
          taxable: Decimal;
          tax: Decimal;
          payable: Decimal;
        }[]
      >`
        SELECT s.invoice_no, s.business_date, s.buyer_gstin, s.buyer_name, s.place_of_supply, s.taxable,
               s.cgst + s.sgst + s.igst + s.cess AS tax, s.payable
        FROM sales s
        WHERE s.tenant_id = ${s.t}::uuid AND s.status = 'COMPLETED' AND s.document_type = 'TAX_INVOICE' AND s.buyer_gstin IS NOT NULL
          AND s.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR s.store_id = ANY(${s.stores}::uuid[]))
        ORDER BY s.business_date, s.invoice_no LIMIT 2000`;
      const hsn = await tx.$queryRaw<
        {
          hsn: string | null;
          unit: string;
          rate: Decimal;
          qty: Decimal;
          taxable: Decimal;
          tax: Decimal;
          value: Decimal;
        }[]
      >`
        SELECT i.hsn_code AS hsn, i.unit_code AS unit, i.gst_rate AS rate, SUM(i.qty) AS qty, SUM(i.taxable) AS taxable,
               SUM(i.cgst + i.sgst + i.igst + i.cess) AS tax, SUM(i.final) AS value
        FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.tenant_id = ${s.t}::uuid AND s.status = 'COMPLETED' AND s.document_type = 'TAX_INVOICE'
          AND s.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR s.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1, 2, 3 ORDER BY 1 NULLS LAST, 3`;
      const [inward] = await tx.$queryRaw<
        {
          taxable: Decimal;
          cgst: Decimal;
          sgst: Decimal;
          igst: Decimal;
          cess: Decimal;
        }[]
      >`
        SELECT COALESCE(SUM(taxable), 0) AS taxable, COALESCE(SUM(cgst), 0) AS cgst, COALESCE(SUM(sgst), 0) AS sgst,
               COALESCE(SUM(igst), 0) AS igst, COALESCE(SUM(cess), 0) AS cess
        FROM goods_receipts
        WHERE tenant_id = ${s.t}::uuid AND gst_applies AND received_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[]))`;
      const [debit] = await tx.$queryRaw<
        {
          taxable: Decimal;
          cgst: Decimal;
          sgst: Decimal;
          igst: Decimal;
          cess: Decimal;
        }[]
      >`
        SELECT COALESCE(SUM(taxable), 0) AS taxable, COALESCE(SUM(cgst), 0) AS cgst, COALESCE(SUM(sgst), 0) AS sgst,
               COALESCE(SUM(igst), 0) AS igst, COALESCE(SUM(cess), 0) AS cess
        FROM purchase_returns
        WHERE tenant_id = ${s.t}::uuid AND gst_applies AND return_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[]))`;
      const [bos] = await tx.$queryRaw<{ invoices: bigint; value: Decimal }[]>`
        SELECT COUNT(*) AS invoices, COALESCE(SUM(payable), 0) AS value FROM sales s
        WHERE s.tenant_id = ${s.t}::uuid AND s.status = 'COMPLETED' AND s.document_type = 'BILL_OF_SUPPLY'
          AND s.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR s.store_id = ANY(${s.stores}::uuid[]))`;

      const rates = [
        ...new Set([...out, ...cn].map((r) => dec(r.rate).toFixed(2))),
      ].sort((a, b) => Number(a) - Number(b));
      let outputTax = ZERO;
      const slabs = rates.map((k) => {
        const o = out.find((x) => dec(x.rate).toFixed(2) === k);
        const c = cn.find((x) => dec(x.rate).toFixed(2) === k);
        const cnGst = dec(c?.gst);
        const cnIgst = dec(c?.inter);
        const cnCgst = cnGst
          .minus(cnIgst)
          .dividedBy(2)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        const cnSgst = cnGst.minus(cnIgst).minus(cnCgst);
        const net = {
          taxable: dec(o?.taxable).minus(c?.taxable ?? 0),
          cgst: dec(o?.cgst).minus(cnCgst),
          sgst: dec(o?.sgst).minus(cnSgst),
          igst: dec(o?.igst).minus(cnIgst),
          cess: dec(o?.cess).minus(c?.cess ?? 0),
        };
        outputTax = outputTax
          .plus(net.cgst)
          .plus(net.sgst)
          .plus(net.igst)
          .plus(net.cess);
        return {
          rate: Number(k),
          invoiced: {
            taxable: m2(o?.taxable),
            cgst: m2(o?.cgst),
            sgst: m2(o?.sgst),
            igst: m2(o?.igst),
            cess: m2(o?.cess),
          },
          creditNotes: {
            count: n(c?.notes),
            taxable: m2(c?.taxable),
            cgst: m2(cnCgst),
            sgst: m2(cnSgst),
            igst: m2(cnIgst),
            cess: m2(c?.cess),
          },
          net: {
            taxable: m2(net.taxable),
            cgst: m2(net.cgst),
            sgst: m2(net.sgst),
            igst: m2(net.igst),
            cess: m2(net.cess),
          },
        };
      });
      const inTax = (x: typeof inward) =>
        dec(x!.cgst).plus(x!.sgst).plus(x!.igst).plus(x!.cess);
      const inputTax = inTax(inward).minus(inTax(debit));
      const split = (b: boolean) => {
        const r = b2.find((x) => x.b2b === b);
        return {
          invoices: n(r?.invoices),
          taxable: m2(r?.taxable),
          tax: m2(r?.tax),
          value: m2(r?.value),
        };
      };
      return {
        from: q.from,
        to: q.to,
        note: 'A working summary for your GST professional, from the invoices and credit notes as issued. It is not a GST return.',
        outward: slabs,
        b2b: {
          ...split(true),
          list: b2bList.map((r) => ({
            invoiceNo: r.invoice_no,
            date: day(r.business_date),
            gstin: r.buyer_gstin,
            name: r.buyer_name,
            placeOfSupply: r.place_of_supply,
            taxable: m2(r.taxable),
            tax: m2(r.tax),
            value: m2(r.payable),
          })),
        },
        b2c: split(false),
        hsn: hsn.map((h) => ({
          hsn: h.hsn,
          unit: h.unit,
          rate: Number(h.rate),
          qty: q3(h.qty),
          taxable: m2(h.taxable),
          tax: m2(h.tax),
          value: m2(h.value),
        })),
        billsOfSupply: { invoices: n(bos!.invoices), value: m2(bos!.value) },
        inward: {
          received: {
            taxable: m2(inward!.taxable),
            cgst: m2(inward!.cgst),
            sgst: m2(inward!.sgst),
            igst: m2(inward!.igst),
            cess: m2(inward!.cess),
          },
          debitNotes: {
            taxable: m2(debit!.taxable),
            cgst: m2(debit!.cgst),
            sgst: m2(debit!.sgst),
            igst: m2(debit!.igst),
            cess: m2(debit!.cess),
          },
        },
        summary: {
          outputTax: m2(outputTax),
          inputTax: m2(inputTax),
          /** Indicative only: eligibility of input tax and other adjustments are for the GST professional. */
          netIndicative: m2(outputTax.minus(inputTax)),
        },
      };
    });
  }

  /** How sales were paid, what is still being verified or refunded, and how the drawers closed. */
  payments(auth: AuthContext, q: RangeQuery) {
    assertPermission(auth, 'cash:reconcile');
    const s = scoped(auth, q);
    return this.run(auth, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          method: string;
          status: string;
          count: bigint;
          amount: Decimal;
          oldest: Date | null;
        }[]
      >`
        SELECT p.method::text, p.status::text, COUNT(*) AS count, SUM(p.amount) AS amount, MIN(p.created_at) AS oldest
        FROM sale_payments p JOIN sales s ON s.id = p.sale_id
        WHERE s.tenant_id = ${s.t}::uuid AND s.business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR s.store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1, 2`;
      const refunds = await tx.$queryRaw<
        { method: string; status: string; count: bigint; amount: Decimal }[]
      >`
        SELECT refund_method::text AS method, refund_status::text AS status, COUNT(*) AS count, SUM(refund_amount) AS amount
        FROM sale_returns
        WHERE tenant_id = ${s.t}::uuid AND business_date BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1, 2`;
      const receipts = await tx.$queryRaw<
        { method: string; count: bigint; amount: Decimal }[]
      >`
        SELECT method::text, COUNT(*) AS count, SUM(amount) AS amount FROM customer_receipts
        WHERE tenant_id = ${s.t}::uuid AND received_on BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[]))
        GROUP BY 1`;
      const [drawers] = await tx.$queryRaw<
        {
          closed: bigint;
          expected: Decimal;
          counted: Decimal;
          variance: Decimal;
          review: bigint;
          open: bigint;
        }[]
      >`
        SELECT COUNT(*) FILTER (WHERE status <> 'OPEN' AND closed_at >= (${s.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
                                AND closed_at < (${s.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata') AS closed,
               COALESCE(SUM(expected_cash) FILTER (WHERE status <> 'OPEN' AND closed_at >= (${s.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
                                AND closed_at < (${s.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'), 0) AS expected,
               COALESCE(SUM(counted_cash) FILTER (WHERE status <> 'OPEN' AND closed_at >= (${s.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
                                AND closed_at < (${s.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'), 0) AS counted,
               COALESCE(SUM(variance) FILTER (WHERE status <> 'OPEN' AND closed_at >= (${s.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
                                AND closed_at < (${s.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'), 0) AS variance,
               COUNT(*) FILTER (WHERE status = 'PENDING_REVIEW') AS review,
               COUNT(*) FILTER (WHERE status = 'OPEN') AS open
        FROM cash_sessions
        WHERE tenant_id = ${s.t}::uuid AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[]))`;
      const methods = [...new Set(rows.map((r) => r.method))].sort();
      const amt = (m: string, st: string) =>
        dec(rows.find((r) => r.method === m && r.status === st)?.amount);
      const pending = rows.filter((r) => r.status === 'PENDING_VERIFICATION');
      return {
        from: q.from,
        to: q.to,
        tenders: methods.map((m) => ({
          method: m,
          recorded: m2(
            rows
              .filter((r) => r.method === m)
              .reduce((x, r) => x.plus(r.amount), ZERO),
          ),
          /** CREDIT: on customers' accounts. */
          settled: m2(amt(m, 'SUCCEEDED')),
          pendingVerification: m2(amt(m, 'PENDING_VERIFICATION')),
          failed: m2(amt(m, 'FAILED')),
          refunded: m2(amt(m, 'REFUNDED')),
        })),
        awaitingVerification: {
          count: pending.reduce((x, r) => x + n(r.count), 0),
          amount: m2(pending.reduce((x, r) => x.plus(r.amount), ZERO)),
          oldest:
            pending
              .map((r) => r.oldest)
              .filter(Boolean)
              .sort((a, b) => a!.getTime() - b!.getTime())[0] ?? null,
        },
        refunds: refunds.map((r) => ({
          method: r.method,
          status: r.status,
          count: n(r.count),
          amount: m2(r.amount),
        })),
        customerReceipts: receipts.map((r) => ({
          method: r.method,
          count: n(r.count),
          amount: m2(r.amount),
        })),
        drawers: {
          closed: n(drawers!.closed),
          expectedCash: m2(drawers!.expected),
          countedCash: m2(drawers!.counted),
          variance: m2(drawers!.variance),
          awaitingReview: n(drawers!.review),
          openNow: n(drawers!.open),
        },
      };
    });
  }

  /**
   * The business at a glance for a period: sales, margin, expenses and the money owed both ways.
   * A management summary built from the operational records — not an accounting ledger (no
   * double entry, no depreciation, no accruals).
   */
  business(auth: AuthContext, q: RangeQuery) {
    assertPermission(auth, 'reports:finance');
    const s = scoped(auth, q);
    return this.run(auth, async (tx) => {
      const t = await this.salesTotals(tx, s);
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: s.t },
        select: { registration: true },
      });
      const [exp] = await tx.$queryRaw<{ amount: Decimal; gst: Decimal }[]>`
        SELECT COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(gst_amount), 0) AS gst FROM expenses
        WHERE tenant_id = ${s.t}::uuid AND status = 'RECORDED' AND spent_on BETWEEN ${s.from}::date AND ${s.to}::date
          AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[]))`;
      // A GST-registered business claims the GST on its bills back, so it isn't a cost.
      const expenses =
        tenant.registration === 'REGULAR'
          ? dec(exp!.amount).minus(exp!.gst)
          : dec(exp!.amount);
      const [buy] = await tx.$queryRaw<
        { purchased: Decimal; returned: Decimal }[]
      >`
        SELECT (SELECT COALESCE(SUM(total), 0) FROM goods_receipts WHERE tenant_id = ${s.t}::uuid AND received_date BETWEEN ${s.from}::date AND ${s.to}::date
                  AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[]))) AS purchased,
               (SELECT COALESCE(SUM(total), 0) FROM purchase_returns WHERE tenant_id = ${s.t}::uuid AND return_date BETWEEN ${s.from}::date AND ${s.to}::date
                  AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[]))) AS returned`;
      const [paid] = await tx.$queryRaw<{ net: Decimal }[]>`
        SELECT COALESCE(SUM(CASE WHEN direction = 'OUT' THEN amount ELSE -amount END), 0) AS net FROM supplier_payments
        WHERE tenant_id = ${s.t}::uuid AND paid_on BETWEEN ${s.from}::date AND ${s.to}::date`;
      const [credit] = await tx.$queryRaw<
        { given: Decimal; collected: Decimal }[]
      >`
        SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'SALE'), 0) AS given,
               COALESCE(-SUM(amount) FILTER (WHERE type = 'RECEIPT'), 0) AS collected
        FROM customer_transactions WHERE tenant_id = ${s.t}::uuid AND date BETWEEN ${s.from}::date AND ${s.to}::date`;
      const [owed] = await tx.$queryRaw<
        { receivable: Decimal; payable: Decimal }[]
      >`
        SELECT (SELECT COALESCE(SUM(balance), 0) FROM customers WHERE tenant_id = ${s.t}::uuid AND balance > 0) AS receivable,
               (SELECT COALESCE(SUM(balance), 0) FROM suppliers WHERE tenant_id = ${s.t}::uuid AND balance > 0) AS payable`;
      const [stock] = await tx.$queryRaw<{ value: Decimal }[]>`
        SELECT COALESCE(SUM(qty * avg_cost), 0) AS value FROM stock_balances
        WHERE tenant_id = ${s.t}::uuid AND qty > 0 AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[]))`;
      const [cash] = await tx.$queryRaw<
        {
          taken: Decimal;
          refunded: Decimal;
          pay_in: Decimal;
          pay_out: Decimal;
        }[]
      >`
        SELECT (SELECT COALESCE(SUM(p.amount), 0) FROM sale_payments p JOIN sales s ON s.id = p.sale_id
                 WHERE s.tenant_id = ${s.t}::uuid AND s.status = 'COMPLETED' AND p.method = 'CASH' AND p.status = 'SUCCEEDED'
                   AND s.business_date BETWEEN ${s.from}::date AND ${s.to}::date
                   AND (${s.stores}::uuid[] IS NULL OR s.store_id = ANY(${s.stores}::uuid[]))) AS taken,
               (SELECT COALESCE(SUM(refund_amount), 0) FROM sale_returns WHERE tenant_id = ${s.t}::uuid AND refund_method = 'CASH'
                   AND business_date BETWEEN ${s.from}::date AND ${s.to}::date
                   AND (${s.stores}::uuid[] IS NULL OR store_id = ANY(${s.stores}::uuid[]))) AS refunded,
               (SELECT COALESCE(SUM(m.amount), 0) FROM cash_movements m JOIN cash_sessions cs ON cs.id = m.session_id
                 WHERE m.tenant_id = ${s.t}::uuid AND m.type = 'PAY_IN'
                   AND m.created_at >= (${s.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata' AND m.created_at < (${s.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
                   AND (${s.stores}::uuid[] IS NULL OR cs.store_id = ANY(${s.stores}::uuid[]))) AS pay_in,
               (SELECT COALESCE(SUM(m.amount), 0) FROM cash_movements m JOIN cash_sessions cs ON cs.id = m.session_id
                 WHERE m.tenant_id = ${s.t}::uuid AND m.type = 'PAY_OUT'
                   AND m.created_at >= (${s.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata' AND m.created_at < (${s.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
                   AND (${s.stores}::uuid[] IS NULL OR cs.store_id = ANY(${s.stores}::uuid[]))) AS pay_out`;
      const operating = t.grossProfit.minus(expenses);
      return {
        from: q.from,
        to: q.to,
        storeId: q.storeId ?? null,
        basis:
          'Management summary from sales, returns, receipts of goods, expenses and payments. It is not an accounting ledger: no double entry, depreciation or accruals.',
        sales: {
          bills: t.bills,
          grossSales: m2(t.grossSales),
          refunds: m2(t.refunds),
          netSales: m2(t.netSales),
          outputTax: m2(t.tax),
          netSalesExTax: m2(t.taxable),
          costOfGoods: m2(t.cost),
          grossProfit: m2(t.grossProfit),
          grossMarginPct: pct(t.grossProfit, t.taxable),
        },
        expenses: {
          total: m2(exp!.amount),
          gstOnExpenses: m2(exp!.gst),
          counted: m2(expenses),
        },
        /** Gross profit − expenses (before tax, depreciation, interest and owner's drawings). */
        operatingResult: m2(operating),
        purchasing: {
          purchased: m2(buy!.purchased),
          returnedToSuppliers: m2(buy!.returned),
          paidToSuppliers: m2(paid!.net),
        },
        credit: {
          givenOnAccount: m2(credit!.given),
          collected: m2(credit!.collected),
        },
        cash: {
          cashSales: m2(cash!.taken),
          cashRefunds: m2(cash!.refunded),
          drawerPayIns: m2(cash!.pay_in),
          drawerPayOuts: m2(cash!.pay_out),
          net: m2(
            dec(cash!.taken)
              .minus(cash!.refunded)
              .plus(cash!.pay_in)
              .minus(cash!.pay_out),
          ),
        },
        now: {
          stockAtCost: m2(stock!.value),
          receivable: m2(owed!.receivable),
          payable: m2(owed!.payable),
        },
      };
    });
  }
}
