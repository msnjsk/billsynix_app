'use client';

import { isLive } from '@/lib/live/session';
import { useLiveVersion } from '@/lib/live/hydrate';
import { errorMessage } from '@/lib/api/client';
import { useNotice } from '@/components/live/Notice';
import { refundWholeBill } from '@/lib/live/actions';
import { voidSale } from '@/lib/live/shift';
import { CancelBillForm } from '@/components/live/CancelBillForm';
import { liveBillSales } from '@/lib/live/dashboard';
import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PageHead, downloadCsv } from '@/components/AppShell';
import { HourlyBars, PaymentDonut, SalesPerformanceChart } from '@/components/dashboard/Charts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { inr, products } from '@/lib/store-data';
import { categoryColor } from '@/lib/category-tones';
import { dayNames, payments } from '@/lib/dashboard-data';
import {
  avgHourly,
  cashiers,
  gstIncluded,
  salesRanges,
  todaysBills,
  type Bill,
  type BillStatus,
  type PayMethod,
  type SalesRangeKey,
} from '@/lib/sales-data';
import { slug } from '@/lib/suppliers-data';
import { useBranches } from '@/lib/branch-data';

/* ---------- helpers ---------- */

const sum = <T,>(rows: readonly T[], pick: (r: T) => number) => rows.reduce((s, r) => s + pick(r), 0);
const pctChange = (now: number, before: number) =>
  before ? Math.round(((now - before) / before) * 1000) / 10 : 0;

const titleFor = (unit: string, label: string) =>
  unit === 'day'
    ? dayNames[label]
      ? `${dayNames[label]}, ${label}`
      : label
    : unit === 'week'
      ? `Week of ${label}`
      : `${label} 2024`;

const PAGE_SIZE = 10;
const methodsAll: PayMethod[] = ['UPI', 'Cash', 'Card'];
const statusCls: Record<BillStatus, string> = {
  Paid: 'bg-teal/15 text-teal',
  Refunded: 'bg-coral/15 text-coral',
  Cancelled: 'bg-mute/15 text-sub line-through',
};
const methodDot: Record<PayMethod, string> = { UPI: 'bg-blue', Cash: 'bg-teal', Card: 'bg-vio' };

function Trend({ value }: { value: number }) {
  const up = value >= 0;
  return (
    <span className={`font-semibold tabular-nums ${up ? 'text-teal' : 'text-coral'}`}>
      {up ? '▲' : '▼'} {Math.abs(value)}%
    </span>
  );
}

function Panel({
  title,
  sub,
  action,
  children,
  className = '',
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card p-4 ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-bold text-ink">{title}</h2>
          {sub && <p className="mt-0.5 text-[12px] text-sub">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function KpiCard({
  label,
  value,
  delta,
  foot,
  brand,
}: {
  label: string;
  value: string;
  delta: number;
  foot: string;
  brand?: boolean;
}) {
  const up = delta >= 0;
  return (
    <div className={`rounded-2xl p-4 ${brand ? 'gbv text-onbrand shadow-lg shadow-blue/25' : 'card'}`}>
      <div className={brand ? 'text-onbrand/80' : 'text-sub'}>{label}</div>
      <div className={`mt-2 text-[24px] font-extrabold tabular-nums ${brand ? '' : 'text-ink'}`}>{value}</div>
      <div className="mt-1 text-[12px]">
        {brand ? (
          <span className="font-semibold">
            {up ? '▲' : '▼'} {Math.abs(delta)}%
          </span>
        ) : (
          <Trend value={delta} />
        )}{' '}
        <span className={brand ? 'text-onbrand/80' : 'text-sub'}>{foot}</span>
      </div>
    </div>
  );
}

/* ---------- bill detail ---------- */

function BillDetail({
  bill,
  onRefund,
  onVoid,
}: {
  bill: Bill;
  onRefund: (id: number) => void;
  /** Connected: cancel the bill (today's, nothing returned yet). */
  onVoid?: { storeId: string; run: (reason: string, approval?: { userId: string; pin: string }) => Promise<void> } | undefined;
}) {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  if (cancelling && onVoid)
    return (
      <CancelBillForm invoiceNo={`#${bill.id}`} amount={bill.total} storeId={onVoid.storeId} run={onVoid.run} onClose={() => setCancelling(false)} />
    );
  const itemCount = sum(bill.lines, (l) => l.qty);
  return (
    <div className="space-y-4 text-[13px]">
      <div className="grid grid-cols-2 gap-2 rounded-xl bg-bg p-3 text-[12px]">
        <Meta label="Customer" value={<CustomerLink name={bill.customer} />} />
        <Meta label="Cashier" value={bill.cashier} />
        <Meta label="Payment" value={bill.method} />
        <Meta label="Status" value={bill.status} />
      </div>

      <table className="w-full">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
            <th className="pb-2 !pl-0 font-medium">Item</th>
            <th className="pb-2 font-medium text-right">Qty</th>
            <th className="pb-2 font-medium text-right">Rate</th>
            <th className="pb-2 !pr-0 font-medium text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {bill.lines.map((l) => (
            <tr key={l.name} className="h-9 border-t border-line">
              <td className="!pl-0 text-ink">{l.name}</td>
              <td className="text-right tabular-nums">{l.qty}</td>
              <td className="text-right tabular-nums text-sub">{inr(l.price)}</td>
              <td className="!pr-0 text-right font-semibold tabular-nums text-ink">{inr(l.price * l.qty)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="space-y-1 border-t border-line pt-3">
        <div className="flex justify-between text-sub">
          <span>{itemCount} items</span>
          <span className="tabular-nums">Incl. GST (5%) {inr(gstIncluded(bill.total))}</span>
        </div>
        <div className="flex justify-between text-[16px] font-extrabold text-ink">
          <span>Total</span>
          <span className={`tabular-nums ${bill.status === 'Refunded' ? 'text-coral line-through' : bill.status === 'Cancelled' ? 'text-mute line-through' : ''}`}>
            {inr(bill.total)}
          </span>
        </div>
      </div>

      {bill.status === 'Paid' && (
        <div className="flex justify-end gap-2">
          {confirming ? (
            <>
              <span className="mr-auto self-center text-coral">Refund {inr(bill.total)} via {bill.method}?</span>
              <button onClick={() => setConfirming(false)} className="h-10 rounded-xl card px-4 font-semibold">
                Cancel
              </button>
              <button
                onClick={() => onRefund(bill.id)}
                className="h-10 rounded-xl bg-coral px-4 font-semibold text-onbrand"
              >
                Confirm refund
              </button>
            </>
          ) : (
            <>
            {onVoid && (
              <button
                onClick={() => setCancelling(true)}
                className="h-10 rounded-xl border border-line px-4 font-semibold text-sub hover:border-coral hover:text-coral"
              >
                Cancel bill
              </button>
            )}
            <button
              onClick={() => setConfirming(true)}
              className="h-10 rounded-xl border border-line px-4 font-semibold text-coral hover:border-coral"
            >
              Refund bill
            </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Named customers link to their profile; walk-ins stay plain text. */
function CustomerLink({ name }: { name: string }) {
  if (name === 'Walk-in') return <span className="text-mute">{name}</span>;
  return (
    <Link
      href={`/customers?id=${slug(name)}`}
      onClick={(e) => e.stopPropagation()}
      className="text-ink hover:text-blue hover:underline"
    >
      {name}
    </Link>
  );
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-mute">{label}</div>
      <div className="font-semibold text-ink">{value}</div>
    </div>
  );
}

/* ---------- main view ---------- */

export function SalesView() {
  // Demo: the sample store's fixed dates. Connected: today and the last 14 days.
  const dates = useMemo(() => {
    if (!isLive()) return { today: '14 May 2024', day: 'Tue, 14 May 2024', range: '1 – 14 May 2024' };
    const now = new Date();
    const from = new Date(now.getTime() - 13 * 86_400_000);
    const f = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-IN', o);
    return {
      today: f(now, { day: 'numeric', month: 'short', year: 'numeric' }),
      day: f(now, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
      range: `${f(from, { day: 'numeric', month: 'short' })} – ${f(now, { day: 'numeric', month: 'short', year: 'numeric' })}`,
    };
  }, []);
  const [range, setRange] = useState<SalesRangeKey>('14D');
  const [bills, setBills] = useState<Bill[]>(todaysBills);
  const [liveNotice, notify] = useNotice();
  const liveVersion = useLiveVersion();
  useEffect(() => {
    if (isLive()) setBills([...todaysBills]);
  }, [liveVersion]);
  const [query, setQuery] = useState('');
  const [method, setMethod] = useState<PayMethod | 'All'>('All');
  const [status, setStatus] = useState<BillStatus | 'All'>('All');
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);

  /* period analytics */
  const { rows, unit, label: rangeLabel } = salesRanges[range];
  const chartRows = rows.map((r) => ({ ...r, title: titleFor(unit, r.label) }));
  const revenue = sum(rows, (r) => r.revenue);
  const previous = sum(rows, (r) => r.previous);
  const profit = sum(rows, (r) => r.profit);
  const prevProfit = Math.round(previous * 0.1848);
  const orderCount = sum(rows, (r) => r.orders);
  const prevOrders = sum(rows, (r) => r.prevOrders);
  // A new business has no bills yet: averages are 0, not NaN.
  const avgBill = orderCount ? Math.round(revenue / orderCount) : 0;
  const prevAvgBill = prevOrders ? Math.round(previous / prevOrders) : 0;

  const categories = useMemo(() => {
    const m = new Map<string, number>();
    products.forEach((p) => m.set(p.category, (m.get(p.category) ?? 0) + p.units * p.price));
    const total = sum([...m.values()], (v) => v);
    return [...m.entries()]
      .filter(([, value]) => value > 0)
      .map(([name, value]) => ({ name, value, pct: total ? Math.round((value / total) * 100) : 0 }))
      .sort((a, b) => b.value - a.value);
  }, []);
  const maxCat = categories[0]?.value ?? 1;

  const payTotal = sum(payments, (p) => p.amount);
  const peakHour = avgHourly.reduce<(typeof avgHourly)[number] | null>((a, b) => (!a || b.sales > a.sales ? b : a), null);
  const maxCashier = Math.max(1, ...cashiers.map((c) => c.revenue));

  /* bills */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, '');
    return bills.filter(
      (b) =>
        (method === 'All' || b.method === method) &&
        (status === 'All' || b.status === status) &&
        (!q || String(b.id).includes(q) || b.customer.toLowerCase().includes(q) || b.cashier.toLowerCase().includes(q))
    );
  }, [bills, query, method, status]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const pageRows = filtered.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
  const paidShown = sum(
    filtered.filter((b) => b.status === 'Paid'),
    (b) => b.total
  );
  const openBill = bills.find((b) => b.id === openId) ?? null;

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(0);
  };

  /** Today's live bill with nothing returned yet can be cancelled outright. */
  const voidFor = (b: Bill) => {
    const sale = isLive() ? liveBillSales.get(b.id) : undefined;
    if (!sale || b.status !== 'Paid' || sale.items.some((i) => Number(i.returnedQty) > 0)) return undefined;
    return {
      storeId: sale.store.id,
      run: async (reason: string, approval?: { userId: string; pin: string }) => {
        await voidSale(sale.id, reason, approval);
        setOpenId(null);
        notify(`Bill ${sale.invoiceNo} cancelled — stock returned and payment reversed`);
      },
    };
  };

  const refund = (id: number) => {
    const sale = isLive() ? liveBillSales.get(id) : undefined;
    if (sale) {
      refundWholeBill(sale)
        .then((r) => notify(`Refunded — credit note ${r.creditNoteNo}`))
        .catch((e: unknown) => notify(errorMessage(e), true));
      return;
    }
    setBills((prev) => prev.map((b) => (b.id === id ? { ...b, status: 'Refunded' } : b)));
  };

  const exportBills = () =>
    downloadCsv('bills-14-may-2024.csv', [
      ['Bill', 'Time', 'Customer', 'Cashier', 'Items', 'Method', 'Total', 'GST included', 'Status'],
      ...filtered.map((b) => [
        b.id,
        b.time,
        b.customer,
        b.cashier,
        sum(b.lines, (l) => l.qty),
        b.method,
        b.total,
        gstIncluded(b.total),
        b.status,
      ]),
    ]);

  const exportSummary = () =>
    downloadCsv(`sales-${range.toLowerCase()}.csv`, [
      ['Period', 'Revenue', 'Profit', 'Orders', 'Previous revenue'],
      ...rows.map((r) => [r.label, r.revenue, r.profit, r.orders, r.previous]),
    ]);

  const branchState = useBranches();
  const hq = branchState.branches.find((b) => b.isHq);
  const hqName = hq ? (branchState.branches.length > 1 ? `${hq.name} branch` : hq.name) : 'Main branch';
  return (
    <div className="space-y-4 p-5 lg:p-6">
      <PageHead title="Sales" sub={`${hqName} · ${rangeLabel.toLowerCase()} to ${dates.today}`}>
        <div className="flex h-10 items-center rounded-xl card p-1" role="tablist" aria-label="Period">
          {(Object.keys(salesRanges) as SalesRangeKey[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={range === k}
              title={salesRanges[k].label}
              onClick={() => setRange(k)}
              className={`h-full rounded-lg px-3 text-[12px] font-semibold ${
                range === k ? 'gbv text-onbrand' : 'text-sub'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <button onClick={exportSummary} className="h-10 rounded-xl card px-4 font-semibold">
          Export report
        </button>
      </PageHead>

      {/* KPIs */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Revenue" value={inr(revenue)} delta={pctChange(revenue, previous)} foot="vs previous period" brand />
        <KpiCard
          label="Gross profit"
          value={inr(profit)}
          delta={pctChange(profit, prevProfit)}
          foot={revenue ? `${((profit / revenue) * 100).toFixed(1)}% margin` : 'No sales yet'}
        />
        <KpiCard
          label="Orders"
          value={orderCount.toLocaleString('en-IN')}
          delta={pctChange(orderCount, prevOrders)}
          foot="vs previous period"
        />
        <KpiCard label="Avg. bill value" value={inr(avgBill)} delta={pctChange(avgBill, prevAvgBill)} foot="vs previous period" />
      </section>

      {/* Trend + payments */}
      <section className="grid gap-3 lg:grid-cols-3">
        <Panel
          title="Revenue & profit"
          sub={`${rangeLabel}, by ${unit}`}
          className="lg:col-span-2"
          action={
            <div className="flex gap-4 text-[11px] text-sub">
              <span className="flex items-center gap-1.5">
                <i className="size-2 rounded-full bg-blue" /> Revenue
              </span>
              <span className="flex items-center gap-1.5">
                <i className="size-2 rounded-full bg-teal" /> Profit
              </span>
              <span className="flex items-center gap-1.5">
                <span className="tracking-tighter text-mute">---</span> Previous
              </span>
            </div>
          }
        >
          <SalesPerformanceChart data={chartRows} />
        </Panel>

        <Panel title="Payment methods" sub="Today">
          <div className="flex items-center gap-4">
            <PaymentDonut data={payments} center={inr(Math.round(payTotal / 1000)) + 'K'} />
            <ul className="flex-1 space-y-2">
              {payments.map((p) => (
                <li key={p.method}>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <i className="size-2 rounded-full" style={{ background: p.color }} />
                      {p.method}
                    </span>
                    <b className="tabular-nums text-ink">{inr(p.amount)}</b>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-line">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${payTotal ? (p.amount / payTotal) * 100 : 0}%`, background: p.color }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-5 rounded-xl bg-bg p-3 text-[12px] text-sub">
            {payTotal ? (
              <>
                {payments[0]?.method ?? 'UPI'} covers {Math.round(((payments[0]?.amount ?? 0) / payTotal) * 100)}% of today’s takings. Card payments carry MDR
                fees, so cash and UPI keep more margin.
              </>
            ) : (
              'No payments yet today. Card payments carry MDR fees, so cash and UPI keep more margin.'
            )}
          </p>
        </Panel>
      </section>

      {/* Hourly, category, cashiers */}
      <section className="grid gap-3 lg:grid-cols-3">
        <Panel title="Sales by hour" sub={peakHour && peakHour.sales > 0 ? `Average over 14 days · busiest at ${peakHour.hour.replace('a', ' AM').replace('p', ' PM')}` : 'Average over 14 days · no sales yet'}>
          <HourlyBars data={avgHourly} />
        </Panel>

        <Panel title="Sales by category" sub={dates.range}>
          <ul className="space-y-3.5">
            {categories.map((c) => (
              <li key={c.name}>
                <div className="mb-1.5 flex justify-between">
                  <span className="font-semibold text-ink">{c.name}</span>
                  <span className="tabular-nums text-sub">
                    {inr(c.value)} · {c.pct}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-line">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(c.value / maxCat) * 100}%`, background: categoryColor(c.name) }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Cashier performance" sub="Today">
          <ol className="space-y-4">
            {cashiers.map((c, i) => (
              <li key={c.name}>
                <div className="flex items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full gbv text-[12px] font-bold text-onbrand">
                    {c.name
                      .split(' ')
                      .map((w) => w[0])
                      .join('')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-ink">
                      {c.name} {i === 0 && <span className="ml-1 text-[11px] text-amber">★ Top</span>}
                    </div>
                    <div className="text-[11px] text-mute">
                      {c.counter} · {c.bills} bills · avg {inr(Math.round(c.revenue / c.bills))}
                    </div>
                  </div>
                  <b className="tabular-nums text-ink">{inr(c.revenue)}</b>
                </div>
                <div className="mt-2 bar">
                  <i style={{ width: `${(c.revenue / maxCashier) * 100}%` }} />
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      </section>

      {/* Bills */}
      <Panel
        title="Today’s bills"
        sub={`${filtered.length} bills · ${inr(paidShown)} collected (refunds excluded)`}
        action={
          <button onClick={exportBills} className="h-9 rounded-xl border border-line px-3 text-[12px] font-semibold">
            Export CSV
          </button>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => resetPage(setQuery)(e.target.value)}
            placeholder="Search bill #, customer or cashier…"
            aria-label="Search bills"
            className="h-9 min-w-[200px] flex-1 rounded-xl border border-line bg-bg px-3 outline-none focus:border-blue"
          />
          <div className="flex rounded-lg bg-bg p-0.5" role="tablist" aria-label="Payment method">
            {(['All', ...methodsAll] as const).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={method === m}
                onClick={() => resetPage(setMethod)(m)}
                className={`rounded-md px-3 py-1 text-[12px] ${
                  method === m ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-sub'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <select
            value={status}
            onChange={(e) => resetPage(setStatus)(e.target.value as BillStatus | 'All')}
            aria-label="Status"
            className="h-9 rounded-xl border border-line bg-surface px-3"
          >
            <option value="All">All statuses</option>
            <option>Paid</option>
            <option>Refunded</option>
            {isLive() && <option>Cancelled</option>}
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                <th className="pb-2 font-medium">Bill</th>
                <th className="pb-2 font-medium">Time</th>
                <th className="pb-2 font-medium">Customer</th>
                <th className="pb-2 font-medium">Cashier</th>
                <th className="pb-2 font-medium text-right">Items</th>
                <th className="pb-2 font-medium">Method</th>
                <th className="pb-2 font-medium text-right">Total</th>
                <th className="pb-2 font-medium text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((b) => (
                <tr
                  key={b.id}
                  onClick={() => setOpenId(b.id)}
                  className="h-12 cursor-pointer border-t border-line hover:bg-bg"
                >
                  <td>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenId(b.id);
                      }}
                      className="font-semibold text-blue"
                    >
                      #{b.id}
                    </button>
                  </td>
                  <td className="tabular-nums text-sub">{b.time}</td>
                  <td>
                    <CustomerLink name={b.customer} />
                  </td>
                  <td>{b.cashier}</td>
                  <td className="text-right tabular-nums">{sum(b.lines, (l) => l.qty)}</td>
                  <td>
                    <span className="flex items-center gap-1.5">
                      <i className={`size-2 rounded-full ${methodDot[b.method]}`} />
                      {b.method}
                    </span>
                  </td>
                  <td className="text-right font-semibold tabular-nums text-ink">{inr(b.total)}</td>
                  <td className="text-right">
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${statusCls[b.status]}`}>
                      {b.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="border-t border-line py-10 text-center text-sub">
              No bills match these filters.{' '}
              <button
                className="font-semibold text-blue"
                onClick={() => {
                  setQuery('');
                  setMethod('All');
                  setStatus('All');
                  setPage(0);
                }}
              >
                Clear filters
              </button>
            </div>
          )}
        </div>

        {filtered.length > PAGE_SIZE && (
          <div className="mt-3 flex items-center justify-between text-[12px] text-sub">
            <span className="tabular-nums">
              {current * PAGE_SIZE + 1}–{Math.min(filtered.length, (current + 1) * PAGE_SIZE)} of {filtered.length}
            </span>
            <div className="flex gap-1.5">
              <button
                disabled={current === 0}
                onClick={() => setPage(current - 1)}
                className="h-8 rounded-lg border border-line px-3 font-semibold disabled:opacity-40"
              >
                ← Prev
              </button>
              <button
                disabled={current >= pages - 1}
                onClick={() => setPage(current + 1)}
                className="h-8 rounded-lg border border-line px-3 font-semibold disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </Panel>

      <Dialog open={openBill !== null} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto rounded-2xl border-line bg-surface text-ink">
          {openBill && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Bill #{openBill.id}</DialogTitle>
                <DialogDescription className="text-sub">
                  {dates.day} · {openBill.time} · {hqName}
                </DialogDescription>
              </DialogHeader>
              <BillDetail key={openBill.id} bill={openBill} onRefund={refund} onVoid={voidFor(openBill)} />
            </>
          )}
        </DialogContent>
      </Dialog>
      {liveNotice}
    </div>
  );
}
