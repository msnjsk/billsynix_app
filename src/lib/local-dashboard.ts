/**
 * A real store kept on this computer (set up without a server, not the demo): the dashboard is
 * built from the bills this counter has saved, never from the sample store's figures.
 */
import { apiConfigured } from '@/lib/api/client';
import { getSetup } from '@/lib/setup';
import { loadLocal } from '@/lib/pos/store';
import type { CreditNote, Invoice } from '@/lib/pos/billing';
import { activity, clearDashboard, dailySales, dayNames, kpis, monthlySales, payments, setTodayCounts, weeklySales, type SalesPoint } from '@/lib/dashboard-data';

/** true for a store set up on this computer without a server (and not the demo). */
export const isLocalStore = () => !apiConfigured && typeof window !== 'undefined' && getSetup()?.mode === 'store';

/** Best sellers of the last 14 days, from this counter's bills. */
export const localTopProducts: { name: string; category: string; price: number; units: number; stock: number; trend: number }[] = [];

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const label = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const pct = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : 0);

export function loadLocalDashboard() {
  clearDashboard();
  localTopProducts.length = 0;
  const { docs } = loadLocal<{ docs: (Invoice | CreditNote)[] }>('session', { docs: [] });
  const bills = docs.filter((d): d is Invoice => d.kind === 'invoice');

  // Revenue per calendar day (net of refunds on that bill).
  const byDay = new Map<string, { revenue: number; bills: number }>();
  for (const b of bills) {
    const k = dayKey(new Date(b.issuedAt));
    const e = byDay.get(k) ?? { revenue: 0, bills: 0 };
    e.revenue += b.totals.payable - (b.refunded ?? 0);
    e.bills += 1;
    byDay.set(k, e);
  }
  const now = new Date();
  const day = (offset: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    return { d, ...(byDay.get(dayKey(d)) ?? { revenue: 0, bills: 0 }) };
  };
  const point = (from: number, size: number, name: string): SalesPoint => {
    let revenue = 0;
    let previous = 0;
    for (let i = 0; i < size; i++) {
      revenue += day(from + i).revenue;
      previous += day(from + size + i).revenue;
    }
    return { label: name, revenue, profit: 0, previous };
  };

  for (let i = 13; i >= 0; i--) {
    const { d, revenue } = day(i);
    dailySales.push({ label: label(d), revenue, profit: 0, previous: day(i + 14).revenue });
    const w = d.toLocaleDateString('en-IN', { weekday: 'short' });
    if (w === 'Sat' || w === 'Sun') dayNames[label(d)] = w;
  }
  for (let w = 7; w >= 0; w--) weeklySales.push(point(w * 7, 7, `Wk of ${label(day(w * 7 + 6).d)}`));
  for (let m = 5; m >= 0; m--) {
    const first = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const last = new Date(now.getFullYear(), now.getMonth() - m + 1, 0);
    let revenue = 0;
    for (const b of bills) {
      const t = new Date(b.issuedAt);
      if (t >= first && t <= new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59)) revenue += b.totals.payable - (b.refunded ?? 0);
    }
    monthlySales.push({ label: first.toLocaleDateString('en-IN', { month: 'short' }), revenue, profit: 0, previous: 0 });
  }

  // Today.
  const today = day(0);
  const yesterday = day(1);
  const todays = bills.filter((b) => dayKey(new Date(b.issuedAt)) === dayKey(now));
  setTodayCounts(today.bills);
  const methods = { UPI: 'var(--blue)', Cash: 'var(--teal)', Card: 'var(--vio)' } as const;
  for (const m of Object.keys(methods) as (keyof typeof methods)[]) {
    const amount = todays.reduce((s, b) => s + b.payments.filter((p) => p.method === m).reduce((x, p) => x + p.amount, 0), 0);
    if (amount > 0) payments.push({ method: m, amount, color: methods[m] });
  }
  const spark = dailySales.slice(-7).map((d) => d.revenue);
  kpis.splice(
    0,
    kpis.length,
    { label: "Today's Revenue", value: inr(today.revenue), delta: pct(today.revenue, yesterday.revenue), progress: 0, foot: `${today.bills} bills today`, spark },
    { label: 'Total Orders', value: String(today.bills), delta: pct(today.bills, yesterday.bills), progress: 0, foot: 'Bills today', spark: Array.from({ length: 7 }, (_, i) => day(6 - i).bills) },
    { label: 'Avg Order', value: inr(today.bills ? today.revenue / today.bills : 0), delta: 0, progress: 0, foot: 'Per bill today', spark },
  );

  // Best sellers (14 days) and the latest bills.
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13);
  const top = new Map<string, { name: string; units: number; revenue: number }>();
  for (const b of bills.filter((x) => new Date(x.issuedAt) >= since))
    for (const l of b.lines) {
      const k = l.sku ?? l.name;
      const e = top.get(k) ?? { name: l.name, units: 0, revenue: 0 };
      e.units += l.qty;
      e.revenue += l.price * l.qty;
      top.set(k, e);
    }
  localTopProducts.push(
    ...[...top.values()].map((t) => ({ name: t.name, category: '—', price: t.units ? t.revenue / t.units : 0, units: t.units, stock: Number.NaN, trend: 0 })),
  );
  activity.push(
    ...bills.slice(0, 6).map((b) => ({
      kind: 'sale' as const,
      text: `Sale ${b.no} · ${inr(b.totals.payable)}`,
      time: new Date(b.issuedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }),
    })),
  );
}
