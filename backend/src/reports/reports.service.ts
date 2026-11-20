import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service.js';
import { Decimal } from '../common/decimal.js';
import {
  assertPermission,
  canAccessStore,
  can,
  type AuthContext,
} from '../auth/auth-context.js';
import { AppException } from '../common/errors/app-exception.js';
import { HttpStatus } from '@nestjs/common';

export const salesSummaryQuery = z.object({
  storeId: z.uuid().optional(),
  from: z.iso.date(),
  to: z.iso.date(),
});
export type SalesSummaryQuery = z.infer<typeof salesSummaryQuery>;

const ZERO = new Decimal(0);
const d2 = (d: Decimal) =>
  d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/**
 * Sales figures for dashboards (Phase 8): per day, per payment method, per product and per hour,
 * from completed sales net of returns. Profit = taxable value − cost of goods (the cost each line
 * left stock at). Full reporting arrives in Phase 10.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  salesSummary(auth: AuthContext, q: SalesSummaryQuery) {
    assertPermission(auth, 'reports:sales');
    if (q.from > q.to)
      throw new AppException(
        'VALIDATION_FAILED',
        '`from` is after `to`.',
        HttpStatus.BAD_REQUEST,
      );
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
    if (days > 400)
      throw new AppException(
        'VALIDATION_FAILED',
        'At most 400 days at a time.',
        HttpStatus.BAD_REQUEST,
      );
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (q.storeId && !canAccessStore(auth, q.storeId))
        throw new AppException(
          'NOT_FOUND',
          'Branch not found.',
          HttpStatus.NOT_FOUND,
        );
      const stores = q.storeId
        ? [q.storeId]
        : auth.storeIds === 'ALL'
          ? null
          : [...auth.storeIds];
      const t = auth.tenantId;
      const from = new Date(`${q.from}T00:00:00.000Z`);
      const to = new Date(`${q.to}T00:00:00.000Z`);

      const daily = await tx.$queryRaw<
        {
          day: Date;
          revenue: Decimal;
          bills: bigint;
          taxable: Decimal;
          cost: Decimal;
        }[]
      >`
        SELECT s.business_date AS day, SUM(s.payable) AS revenue, COUNT(*) AS bills, SUM(s.taxable) AS taxable,
               COALESCE(SUM(c.cost), 0) AS cost
        FROM sales s
        LEFT JOIN (SELECT sale_id, SUM(unit_cost * qty) AS cost FROM sale_items GROUP BY sale_id) c ON c.sale_id = s.id
        WHERE s.tenant_id = ${t}::uuid AND s.status = 'COMPLETED'
          AND s.business_date BETWEEN ${from} AND ${to}
          AND (${stores}::uuid[] IS NULL OR s.store_id = ANY(${stores}::uuid[]))
        GROUP BY s.business_date ORDER BY s.business_date`;
      const refunds = await tx.$queryRaw<
        { day: Date; amount: Decimal; taxable: Decimal; cost: Decimal }[]
      >`
        SELECT r.business_date AS day, SUM(r.refund_amount) AS amount, SUM(r.taxable) AS taxable,
               COALESCE(SUM(c.cost), 0) AS cost
        FROM sale_returns r
        LEFT JOIN (SELECT ri.return_id, SUM(ri.qty * si.unit_cost) AS cost
                   FROM sale_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id GROUP BY ri.return_id) c ON c.return_id = r.id
        WHERE r.tenant_id = ${t}::uuid AND r.business_date BETWEEN ${from} AND ${to}
          AND (${stores}::uuid[] IS NULL OR r.store_id = ANY(${stores}::uuid[]))
        GROUP BY r.business_date`;
      const methods = await tx.$queryRaw<
        { method: string; amount: Decimal; pending: Decimal }[]
      >`
        SELECT p.method::text AS method,
               SUM(CASE WHEN p.status = 'SUCCEEDED' THEN p.amount ELSE 0 END) AS amount,
               SUM(CASE WHEN p.status = 'PENDING_VERIFICATION' THEN p.amount ELSE 0 END) AS pending
        FROM sale_payments p JOIN sales s ON s.id = p.sale_id
        WHERE s.tenant_id = ${t}::uuid AND s.status = 'COMPLETED'
          AND s.business_date BETWEEN ${from} AND ${to}
          AND (${stores}::uuid[] IS NULL OR s.store_id = ANY(${stores}::uuid[]))
        GROUP BY p.method`;
      const products = await tx.$queryRaw<
        {
          product_id: string;
          sku: string;
          name: string;
          units: Decimal;
          revenue: Decimal;
          cost: Decimal;
        }[]
      >`
        SELECT i.product_id::text, MIN(i.sku) AS sku, MIN(i.name) AS name,
               SUM(i.qty - i.returned_qty) AS units,
               SUM(i.final * (i.qty - i.returned_qty) / i.qty) AS revenue,
               SUM(i.unit_cost * (i.qty - i.returned_qty)) AS cost
        FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.tenant_id = ${t}::uuid AND s.status = 'COMPLETED'
          AND s.business_date BETWEEN ${from} AND ${to}
          AND (${stores}::uuid[] IS NULL OR s.store_id = ANY(${stores}::uuid[]))
        GROUP BY i.product_id ORDER BY revenue DESC`;
      const hourly = await tx.$queryRaw<
        { hour: number; bills: bigint; revenue: Decimal }[]
      >`
        SELECT EXTRACT(HOUR FROM s.issued_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, COUNT(*) AS bills, SUM(s.payable) AS revenue
        FROM sales s
        WHERE s.tenant_id = ${t}::uuid AND s.status = 'COMPLETED'
          AND s.business_date BETWEEN ${from} AND ${to}
          AND (${stores}::uuid[] IS NULL OR s.store_id = ANY(${stores}::uuid[]))
        GROUP BY 1 ORDER BY 1`;

      const showProfit = can(auth, 'reports:finance');
      const refundByDay = new Map(
        refunds.map((r) => [r.day.toISOString().slice(0, 10), r]),
      );
      const series = [];
      for (let ms = from.getTime(); ms <= to.getTime(); ms += 86_400_000) {
        const day = new Date(ms).toISOString().slice(0, 10);
        const s = daily.find((x) => x.day.toISOString().slice(0, 10) === day);
        const r = refundByDay.get(day);
        const revenue = new Decimal(s?.revenue ?? 0).minus(r?.amount ?? 0);
        const profit = new Decimal(s?.taxable ?? 0)
          .minus(s?.cost ?? 0)
          .minus(new Decimal(r?.taxable ?? 0).minus(r?.cost ?? 0));
        series.push({
          date: day,
          revenue: d2(revenue),
          bills: Number(s?.bills ?? 0),
          ...(showProfit ? { profit: d2(profit) } : {}),
        });
      }
      const total = series.reduce((t2, x) => t2.plus(x.revenue), ZERO);
      const bills = series.reduce((n, x) => n + x.bills, 0);
      return {
        from: q.from,
        to: q.to,
        storeId: q.storeId ?? null,
        totals: {
          revenue: d2(total),
          bills,
          averageBill: bills ? d2(total.dividedBy(bills)) : '0.00',
          ...(showProfit
            ? {
                profit: d2(
                  series.reduce((t2, x) => t2.plus(x.profit ?? 0), ZERO),
                ),
              }
            : {}),
        },
        daily: series,
        byMethod: methods.map((m) => ({
          method: m.method,
          amount: d2(new Decimal(m.amount)),
          pending: d2(new Decimal(m.pending)),
        })),
        byProduct: products.map((p) => ({
          productId: p.product_id,
          sku: p.sku,
          name: p.name,
          units: new Decimal(p.units).toFixed(3),
          revenue: d2(new Decimal(p.revenue)),
          ...(showProfit ? { cost: d2(new Decimal(p.cost)) } : {}),
        })),
        hourly: hourly.map((h) => ({
          hour: h.hour,
          bills: Number(h.bills),
          revenue: d2(new Decimal(h.revenue)),
        })),
      };
    });
  }
}
