/**
 * Dashboard and Sales figures from the API (connected mode), written into the data modules the
 * Dashboard and Sales screens already read. Part of the load in hydrate.ts.
 */
import { get } from '@/lib/api/client';
import type { Movement, Page, Sale, SalesSummary, StockRow } from '@/lib/api/types';
import { num } from '@/lib/api/types';
import {
  activity,
  categoryShare,
  clearDashboard,
  dailySales,
  dayNames,
  expiring,
  inventoryHealth,
  kpis,
  monthlySales,
  payments,
  setTodayCounts,
  weeklySales,
  type SalesPoint,
} from '@/lib/dashboard-data';
import { avgHourly, cashiers, salesRanges, todaysBills, type Bill } from '@/lib/sales-data';
import { liveBranchSales } from '@/lib/branch-data';
import { addDays, fmtDate, TODAY } from '@/lib/suppliers-data';
import { can } from './session';

const replace = <T>(target: T[], items: T[]) => {
  target.splice(0, target.length, ...items);
};
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const pctChange = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : 0);
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
const COLORS = ['var(--blue)', 'var(--sky)', 'var(--cyan)', 'var(--vio)', 'var(--lime)', 'var(--amber)'];

/** Sale ids of today's bills on the Sales screen (by its numeric bill id), for refunds. */
export const liveBillSales = new Map<number, Sale>();

export async function loadDashboard(stores: { id: string; active: boolean; kind: string }[], currentStoreId: string, categoryOf: Map<string, string>) {
  // Nothing left over from the sample store or a previously signed-in business.
  clearDashboard();
  if (!can('reports:sales')) return;
  // One year, all branches: daily (14 days), weekly (8 weeks) and monthly (6 months) series.
  const year = await get<SalesSummary>('/reports/sales-summary', { from: addDays(TODAY, -364), to: TODAY });
  const days = year.daily;
  const rev = (d: (typeof days)[number] | undefined) => num(d?.revenue);
  const last14 = days.slice(-14);
  replace(
    dailySales,
    last14.map((d, i) => ({
      label: fmtDate(d.date),
      revenue: rev(d),
      profit: num(d.profit),
      previous: rev(days[days.length - 28 + i]),
    })),
  );
  for (const k of Object.keys(dayNames)) delete dayNames[k];
  for (const d of last14) {
    const w = weekday(d.date);
    if (w === 'Sat' || w === 'Sun') dayNames[fmtDate(d.date)] = w;
  }
  const bucket = (from: number, size: number, label: (first: string) => string): SalesPoint => {
    const slice = days.slice(from, from + size);
    const prev = days.slice(Math.max(0, from - size), from);
    return {
      label: label(slice[0]?.date ?? TODAY),
      revenue: slice.reduce((s, d) => s + rev(d), 0),
      profit: slice.reduce((s, d) => s + num(d.profit), 0),
      previous: prev.reduce((s, d) => s + rev(d), 0),
    };
  };
  replace(weeklySales, Array.from({ length: 8 }, (_, i) => bucket(days.length - 56 + i * 7, 7, (f) => `Wk of ${fmtDate(f)}`)));
  const months = new Map<string, SalesPoint>();
  for (const d of days.slice(-183)) {
    const key = d.date.slice(0, 7);
    const m = months.get(key) ?? { label: new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }), revenue: 0, profit: 0, previous: 0 };
    m.revenue += rev(d);
    m.profit += num(d.profit);
    months.set(key, m);
  }
  replace(monthlySales, [...months.values()].slice(-6));
  const withOrders = (rows: SalesPoint[], bills: number[]) => rows.map((r, i) => ({ ...r, orders: bills[i] ?? 0, prevOrders: 0 }));
  const dailyBills = last14.map((d) => d.bills);
  const ranges = salesRanges as unknown as Record<string, { rows: unknown }>;
  ranges['7D']!.rows = withOrders(dailySales.slice(-7), dailyBills.slice(-7));
  ranges['14D']!.rows = withOrders(dailySales, dailyBills);
  ranges['8W']!.rows = withOrders(weeklySales, []);
  ranges['6M']!.rows = withOrders(monthlySales, []);

  // Today.
  const today = await get<SalesSummary>('/reports/sales-summary', { from: TODAY, to: TODAY, ...(currentStoreId ? { storeId: currentStoreId } : {}) });
  const yesterday = days[days.length - 2];
  const t = today.totals;
  setTodayCounts(t.bills);
  const methodColor: Record<string, string> = { UPI: 'var(--blue)', CASH: 'var(--teal)', CARD: 'var(--vio)' };
  replace(
    payments,
    today.byMethod.map((m) => ({ method: m.method === 'CASH' ? 'Cash' : m.method === 'CARD' ? 'Card' : 'UPI', amount: num(m.amount) + num(m.pending), color: methodColor[m.method] ?? 'var(--amber)' })),
  );
  replace(
    avgHourly,
    year.hourly.map((h) => ({ hour: `${h.hour % 12 || 12}${h.hour < 12 ? 'a' : 'p'}`, sales: Math.round(num(h.revenue) / 365) })),
  );

  // Stock health of this branch.
  const rows = can('inventory:read') && currentStoreId ? (await get<Page<StockRow>>(`/stores/${currentStoreId}/stock`, { pageSize: 200 })).data : [];
  const low = rows.filter((r) => r.status === 'LOW').length;
  const out = rows.filter((r) => r.status === 'OUT').length;
  Object.assign(inventoryHealth, { inStock: rows.length - low - out, low, critical: out });
  const stockValue = rows.reduce((s, r) => s + num(r.value), 0);

  const spark = last14.slice(-7).map((d) => rev(d));
  replace(kpis, [
    { label: "Today's Revenue", value: inr(num(t.revenue)), delta: pctChange(num(t.revenue), rev(yesterday)), progress: 0, foot: `${t.bills} bills today`, spark },
    { label: 'Total Orders', value: String(t.bills), delta: pctChange(t.bills, yesterday?.bills ?? 0), progress: 0, foot: 'Bills today', spark: last14.slice(-7).map((d) => d.bills) },
    { label: 'Gross Profit', value: t.profit !== undefined ? inr(num(t.profit)) : '—', delta: 0, progress: 0, foot: 'Before expenses', spark },
    { label: 'Avg Order', value: inr(num(t.averageBill)), delta: 0, progress: 0, foot: 'Per bill today', spark },
    { label: 'Low Stock', value: `${low + out} Products`, delta: 0, deltaLabel: `${out} out`, progress: rows.length ? Math.round(((low + out) / rows.length) * 100) : 0, foot: `${out} out of stock`, spark: [], highlight: low + out > 0 },
    { label: 'Inventory Value', value: inr(stockValue), delta: 0, progress: 0, foot: `${rows.length} SKUs`, spark: [] },
  ]);

  // Category share of the last 14 days' revenue.
  const recent = await get<SalesSummary>('/reports/sales-summary', { from: addDays(TODAY, -13), to: TODAY });
  const byCat = new Map<string, number>();
  for (const p of recent.byProduct) byCat.set(categoryOf.get(p.sku) ?? 'Other', (byCat.get(categoryOf.get(p.sku) ?? 'Other') ?? 0) + num(p.revenue));
  const catTotal = [...byCat.values()].reduce((a, b) => a + b, 0) || 1;
  replace(
    categoryShare,
    [...byCat.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, v], i) => ({ name, share: Math.round((v / catTotal) * 100), color: COLORS[i % COLORS.length]! })),
  );

  // Expiring batches and recent activity.
  if (can('inventory:read') && currentStoreId) {
    const exp = await get<{ data: { product: { name: string }; batch: { batchNo: string }; daysLeft: number }[] }>('/stock/alerts/expiry', { storeId: currentStoreId, days: 14 });
    replace(expiring, exp.data.slice(0, 5).map((e) => ({ name: e.product.name, batch: e.batch.batchNo, days: e.daysLeft })));
    const moves = await get<{ data: Movement[] }>(`/stores/${currentStoreId}/stock-movements`, { limit: 6 });
    replace(
      activity,
      moves.data.map((m) => ({
        kind: m.type === 'SALE' ? 'sale' : m.type === 'PURCHASE_RECEIPT' || m.type === 'TRANSFER_IN' ? 'restock' : 'adjust',
        text: `${m.type.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())} · ${num(m.qty) > 0 ? '+' : ''}${num(m.qty)}${m.note ? ` · ${m.note}` : ''}`,
        time: new Date(m.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }),
      })),
    );
  }

  // Per-branch 14 days (branch comparison on the dashboard).
  for (const k of Object.keys(liveBranchSales)) delete liveBranchSales[k];
  for (const s of stores.filter((x) => x.active && x.kind === 'store')) {
    const r = await get<SalesSummary>('/reports/sales-summary', { from: addDays(TODAY, -13), to: TODAY, storeId: s.id });
    liveBranchSales[s.id] = r.daily.map((d) => ({ date: d.date, label: fmtDate(d.date), revenue: num(d.revenue), bills: d.bills, profit: num(d.profit) }));
  }
}

/** Today's bills for the Sales screen. */
export async function loadTodaysBills(currentStoreId: string) {
  if (!can('sales:read')) return;
  const r = await get<Page<Sale>>('/sales', { date: TODAY, pageSize: 200, ...(currentStoreId ? { storeId: currentStoreId } : {}) });
  liveBillSales.clear();
  const method = (s: Sale): Bill['method'] => {
    const m = [...s.payments].sort((a, b) => num(b.amount) - num(a.amount))[0]?.method;
    return m === 'CASH' ? 'Cash' : m === 'CARD' ? 'Card' : 'UPI';
  };
  const bills: Bill[] = r.data.map((s) => {
      const id = Number(s.invoiceNo.slice(-5));
      liveBillSales.set(id, s);
      return {
        id,
        time: new Date(s.issuedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }),
        method: method(s),
        status: s.status === 'VOIDED' ? 'Cancelled' : s.paymentStatus === 'REFUNDED' ? 'Refunded' : 'Paid',
        cashier: s.counter.name,
        customer: s.buyer?.name ?? 'Walk-in',
        lines: s.items.map((i) => ({ name: i.name, price: num(i.unitPrice), qty: num(i.qty) })),
        total: num(s.totals.payable),
      };
    });
  replace(todaysBills, bills);
  // Bills per counter today.
  const byCounter = new Map<string, { name: string; counter: string; bills: number; revenue: number }>();
  for (const s of r.data.filter((x) => x.status === 'COMPLETED')) {
    const c = byCounter.get(s.counter.id) ?? { name: s.counter.name, counter: s.counter.name, bills: 0, revenue: 0 };
    c.bills++;
    c.revenue += num(s.totals.payable);
    byCounter.set(s.counter.id, c);
  }
  replace(cashiers, [...byCounter.values()]);
}
