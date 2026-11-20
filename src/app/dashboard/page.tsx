'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { apiConfigured } from '@/lib/api/client';
import { isLocalStore, loadLocalDashboard, localTopProducts } from '@/lib/local-dashboard';

/** A real business (on the server, or set up on this computer) — never the sample store's figures. */
const realData = () => apiConfigured || isLocalStore();
import Link from 'next/link';
import { AppShell, downloadCsv } from '@/components/AppShell';
import { PaymentDonut, SalesPerformanceChart, Sparkline } from '@/components/dashboard/Charts';
import { PharmacyDashboard } from '@/components/dashboard/PharmacyDashboard';
import { useBusinessProfile } from '@/lib/business-profile';
import { greetingName, useSession } from '@/lib/auth';
import { answer, inr, lowStock, products } from '@/lib/store-data';
import { categoryPill } from '@/lib/category-tones';
import {
  activity,
  categoryShare,
  dailySales,
  dayNames,
  expiring,
  footfall,
  inventoryHealth,
  kpis,
  monthlySales,
  ordersToday,
  payments,
  suggestions,
  weeklySales,
  type ActivityKind,
  type Kpi,
} from '@/lib/dashboard-data';
import { branchSales, hasSales, stores, useBranches } from '@/lib/branch-data';

/* ---------- helpers ---------- */

const periods = {
  Daily: { data: dailySales, title: (l: string) => (dayNames[l] ? `${dayNames[l]}, ${l}` : l) },
  Weekly: { data: weeklySales, title: (l: string) => `Week of ${l}` },
  Monthly: { data: monthlySales, title: (l: string) => (apiConfigured ? l : `${l} 2024`) },
} as const;
type Period = keyof typeof periods;

const sum = <T,>(rows: T[], pick: (r: T) => number) => rows.reduce((s, r) => s + pick(r), 0);
/** % change, or null when there is nothing earlier to compare with (no ÷0 → "Infinity%"). */
const pctChange = (now: number, before: number): number | null =>
  before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null;

const activityDot: Record<ActivityKind, string> = {
  sale: 'bg-teal',
  restock: 'bg-blue',
  adjust: 'bg-amber',
};

function Trend({
  value,
  label,
  className = '',
}: {
  value: number | null;
  label?: string | undefined;
  className?: string;
}) {
  if (value === null)
    return <span className={`font-semibold text-mute ${className}`}>{label ?? 'new'}</span>;
  const up = value >= 0;
  return (
    <span className={`font-semibold tabular-nums ${up ? 'text-teal' : 'text-coral'} ${className}`}>
      {label ?? `${up ? '▲' : '▼'} ${Math.abs(value)}%`}
    </span>
  );
}

function Panel({
  title,
  action,
  children,
  className = '',
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card p-4 ${className}`}>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="font-bold text-[15px] text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

/* ---------- sections ---------- */

function Hero() {
  const total = sum(dailySales, (d) => d.revenue);
  const growth = pctChange(total, sum(dailySales, (d) => d.previous));
  const best = dailySales.reduce<(typeof dailySales)[number] | null>((a, b) => (!a || b.revenue > a.revenue ? b : a), null);
  const avg = dailySales.length ? Math.round(total / dailySales.length / 100) * 100 : 0;
  // `previous` is the same number of days just before (the 14 days before the last 14).
  const days = dailySales.length;
  const headline =
    growth === null ? 'Off to a good start!' : growth > 0 ? 'Your business is growing!' : growth < 0 ? 'Sales are down a little' : 'Sales are steady';
  const detail =
    growth === null
      ? `No sales in the ${days} days before to compare with yet.`
      : growth === 0
        ? `Revenue is level with the ${days} days before.`
        : `Revenue is ${growth > 0 ? 'up' : 'down'} ${Math.abs(growth)}% on the ${days} days before.`;

  return (
    <section className="gbv rounded-2xl px-6 py-6 text-onbrand shadow-lg shadow-blue/20">
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div>
          <h2 className="text-[20px] font-extrabold">{headline}</h2>
          <p className="mt-1 text-onbrand/80">{detail}</p>
          <Link
            href="/sales"
            className="mt-4 inline-flex h-9 items-center rounded-lg bg-surface px-4 font-semibold text-blue"
          >
            View analytics →
          </Link>
        </div>
        <div className="flex items-center gap-8">
          <div className="hidden md:block">
            <Sparkline
              points={dailySales.map((d) => d.revenue)}
              color="var(--onbrand)"
              fill="color-mix(in oklch, var(--onbrand) 18%, transparent)"
              width={200}
              height={56}
            />
          </div>
          <div className="text-right">
            <div className="text-[40px] font-extrabold leading-none tabular-nums">
              {growth === null ? '—' : `${growth > 0 ? '+' : growth < 0 ? '−' : ''}${Math.abs(growth)}%`}
            </div>
            <div className="mt-1 text-onbrand/70 text-[12px]">vs previous {days} days</div>
          </div>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 border-t border-onbrand/20 pt-4 sm:grid-cols-3">
        <HeroStat label="Best day" value={inr(best?.revenue ?? 0)} suffix={best && best.revenue > 0 ? (dayNames[best.label] ?? best.label) : undefined} />
        <HeroStat label="Avg daily" value={inr(avg)} />
        <HeroStat label="Footfall" value={footfall.toLocaleString('en-IN')} suffix="customers" />
      </div>
    </section>
  );
}

function HeroStat({ label, value, suffix }: { label: string; value: string; suffix?: string | undefined }) {
  return (
    <div>
      <div className="text-[12px] text-onbrand/70">{label}</div>
      <div className="mt-0.5 text-[17px] font-extrabold tabular-nums">
        {value} {suffix && <span className="text-[11px] font-semibold text-onbrand/70">{suffix}</span>}
      </div>
    </div>
  );
}

function KpiCard({ k }: { k: Kpi }) {
  const hi = k.highlight;
  const up = k.delta >= 0;
  return (
    <div
      className={`rounded-2xl p-3.5 ${
        hi ? 'gco text-onbrand shadow-lg shadow-coral/25' : 'card'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className={hi ? 'text-onbrand/85' : 'text-sub'}>{k.label}</span>
        <Sparkline
          points={k.spark}
          color={hi ? 'var(--onbrand)' : up ? 'var(--teal)' : 'var(--coral)'}
        />
      </div>
      <div className={`mt-2 text-[19px] font-extrabold tabular-nums ${hi ? '' : 'text-ink'}`}>
        {k.value}
      </div>
      <div className="mt-0.5 text-[11px]">
        {hi ? (
          <span className="font-semibold">{k.deltaLabel}</span>
        ) : (
          <Trend value={k.delta} label={k.deltaLabel} />
        )}{' '}
        <span className={hi ? 'text-onbrand/80' : 'text-sub'}>vs last month</span>
      </div>
      <div className={`mt-3 h-1 rounded-full overflow-hidden ${hi ? 'bg-onbrand/30' : 'bg-line'}`}>
        <div
          className={`h-full rounded-full ${hi ? 'bg-onbrand' : 'bg-blue'}`}
          style={{ width: `${k.progress}%` }}
        />
      </div>
      <div className={`mt-2 text-[11px] ${hi ? 'text-onbrand/85' : 'text-mute'}`}>{k.foot}</div>
    </div>
  );
}

function SalesPerformance() {
  const [period, setPeriod] = useState<Period>('Daily');
  const { data, title } = periods[period];
  const rows = data.map((d) => ({ ...d, title: title(d.label) }));
  const revenue = sum(data, (d) => d.revenue);
  const previous = sum(data, (d) => d.previous);

  return (
    <Panel
      title="Sales Performance"
      className="lg:col-span-2"
      action={
        <div className="flex rounded-lg bg-bg p-0.5" role="tablist" aria-label="Period">
          {(Object.keys(periods) as Period[]).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={period === p}
              onClick={() => setPeriod(p)}
              className={`rounded-md px-3 py-1 text-[12px] ${
                period === p ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-sub'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        <Legend dot="bg-blue" label="Revenue">
          {inr(revenue)} <Trend value={pctChange(revenue, previous)} className="text-[11px]" />
        </Legend>
        <Legend dot="bg-teal" label="Profit">
          {inr(sum(data, (d) => d.profit))}
        </Legend>
        <Legend dash label="Previous" muted>
          {inr(previous)}
        </Legend>
      </div>
      <div className="mt-3">
        <SalesPerformanceChart data={rows} />
      </div>
    </Panel>
  );
}

function Legend({
  dot,
  dash,
  label,
  muted,
  children,
}: {
  dot?: string;
  dash?: boolean;
  label: string;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] text-sub">
        {dot && <i className={`size-2 rounded-full ${dot}`} />}
        {dash && <span className="tracking-tighter text-mute">---</span>}
        {label}
      </div>
      <div className={`mt-0.5 text-[17px] font-extrabold tabular-nums ${muted ? 'text-mute' : 'text-ink'}`}>
        {children}
      </div>
    </div>
  );
}

function PaymentsAndBranches() {
  const total = sum(payments, (p) => p.amount);
  // Branch sales this month (1–14 May sample), best first. Hidden for a single-store business.
  const branchState = useBranches();
  const branches = stores(branchState)
    .filter((b) => hasSales(b.id))
    .map((b) => ({ id: b.id, name: b.name, revenue: sum(branchSales(b.id), (d) => d.revenue) }))
    .sort((a, b) => b.revenue - a.revenue);
  const maxBranch = Math.max(1, ...branches.map((b) => b.revenue));
  return (
    <Panel title="Payment Distribution">
      <div className="flex items-center gap-4">
        <PaymentDonut data={payments} center={String(ordersToday)} />
        <ul className="flex-1 space-y-1.5">
          {payments.map((p) => (
            <li key={p.method} className="flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <i className="size-2 rounded-full" style={{ background: p.color }} />
                {p.method}
              </span>
              <span className="tabular-nums">
                <b className="text-ink">{inr(p.amount)}</b>{' '}
                <span className="text-mute text-[11px]">{Math.round((p.amount / total) * 100)}%</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      {branches.length > 1 && (
        <>
      <div className="mt-6 mb-2 flex items-center justify-between">
        <h3 className="font-bold text-ink">Top Branches</h3>
        <Link href="/branches" className="text-[12px] font-semibold text-blue">
          All branches →
        </Link>
      </div>
      <ol className="space-y-3">
        {branches.map((b, i) => (
          <li key={b.id}>
            <div className="flex justify-between">
              <span>
                <span className="text-blue font-semibold mr-2">{i + 1}</span>
                {b.name}
              </span>
              <b className="tabular-nums text-ink">{inr(b.revenue)}</b>
            </div>
            <div className="mt-1.5 bar">
              <i style={{ width: `${(b.revenue / maxBranch) * 100}%` }} />
            </div>
          </li>
        ))}
      </ol>
        </>
      )}
    </Panel>
  );
}

function TopProducts() {
  const top = [...(isLocalStore() ? localTopProducts : products)]
    .filter((p) => !realData() || p.units > 0)
    .sort((a, b) => b.units * b.price - a.units * a.price)
    .slice(0, 7);
  return (
    <Panel
      title="Top Selling Products"
      className="lg:col-span-2"
      action={
        <Link href="/products" className="text-blue font-semibold text-[12px]">
          View all →
        </Link>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
              <th className="pb-2 font-medium">Product</th>
              <th className="pb-2 font-medium">Category</th>
              <th className="pb-2 font-medium">Units</th>
              <th className="pb-2 font-medium">Revenue</th>
              <th className="pb-2 font-medium">Stock left</th>
              <th className="pb-2 font-medium">Trend</th>
            </tr>
          </thead>
          <tbody>
            {top.map((p) => (
              <tr key={p.name} className="h-[42px] border-t border-line">
                <td className="font-semibold text-ink">{p.name}</td>
                <td>
                  <span
                    className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${categoryPill(p.category)}`}
                  >
                    {p.category}
                  </span>
                </td>
                <td className="tabular-nums">{p.units}</td>
                <td className="tabular-nums font-semibold text-ink">{inr(p.units * p.price)}</td>
                <td className={`tabular-nums ${lowStock(p) ? 'text-coral font-semibold' : ''}`}>
                  {Number.isFinite(p.stock) ? p.stock : '—'}
                </td>
                <td>
                  <Trend value={p.trend} className="text-[12px]" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {top.length === 0 && (
          <p className="py-8 text-center text-[12.5px] text-sub">
            No sales yet. Your best sellers show here once you start billing —{' '}
            <Link href="/pos" className="font-semibold text-blue">
              open the POS
            </Link>
            .
          </p>
        )}
      </div>
    </Panel>
  );
}

function InventoryIntelligence() {
  const { inStock, low, critical } = inventoryHealth;
  const total = inStock + low + critical;
  // Keep small segments visible: give each at least 6% of the bar.
  const seg = (n: number) => (total ? Math.max((n / total) * 100, 6) : 0);
  return (
    <Panel title="Inventory Intelligence">
      <div className="grid grid-cols-3 text-center">
        <Stat value={inStock.toLocaleString('en-IN')} label="In stock" tone="text-ink" />
        <Stat value={String(low)} label="Low" tone="text-amber" />
        <Stat value={String(critical)} label="Critical" tone="text-coral" />
      </div>
      <div className="mt-3 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        <i className="bg-teal" style={{ flexGrow: seg(inStock) }} />
        <i className="bg-amber" style={{ flexGrow: seg(low) }} />
        <i className="bg-coral" style={{ flexGrow: seg(critical) }} />
      </div>

      <div className="mt-3 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        {categoryShare.map((c) => (
          <i key={c.name} style={{ flexGrow: c.share, background: c.color }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-sub">
        {categoryShare.map((c) => (
          <li key={c.name} className="flex items-center gap-1">
            <i className="size-1.5 rounded-full" style={{ background: c.color }} />
            {c.name} {c.share}%
          </li>
        ))}
      </ul>

      <h3 className="mt-5 mb-2 font-bold text-ink">Expiring in 7 days</h3>
      <ul className="space-y-3">
        {expiring.map((e) => (
          <li key={e.batch} className="flex items-start justify-between">
            <div>
              <div className="font-semibold text-ink">{e.name}</div>
              <div className="text-[10px] text-mute">Batch #{e.batch}</div>
            </div>
            <span className={`text-[12px] font-semibold ${e.days <= 2 ? 'text-coral' : 'text-amber'}`}>
              {e.days} {e.days === 1 ? 'day' : 'days'}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Stat({ value, label, tone }: { value: string; label: string; tone: string }) {
  return (
    <div>
      <div className={`text-[17px] font-extrabold tabular-nums ${tone}`}>{value}</div>
      <div className="text-[10px] text-sub">{label}</div>
    </div>
  );
}

function AiAssistant() {
  const [q, setQ] = useState('');
  const [reply, setReply] = useState<{ q: string; a: string } | null>(null);

  const ask = (question: string) => {
    const text = question.trim();
    if (!text) return;
    setReply({ q: text, a: answer(text) });
    setQ('');
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask(q);
  };

  return (
    <section className="gbv rounded-2xl p-5 text-onbrand lg:col-span-2">
      <h2 className="text-[17px] font-extrabold">Ask your AI Business Assistant</h2>
      <form
        onSubmit={onSubmit}
        className="mt-4 flex items-center gap-2 rounded-xl bg-surface p-1.5 ring-4 ring-onbrand/20"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask about sales, stock or customers…"
          aria-label="Ask the AI assistant"
          className="h-9 flex-1 bg-transparent px-3 text-ink outline-none placeholder:text-mute"
        />
        <button type="submit" className="h-9 rounded-lg gbv px-6 font-semibold">
          Ask
        </button>
      </form>
      {reply && (
        <div className="mt-3 rounded-xl bg-onbrand/10 p-3" aria-live="polite">
          <div className="text-[11px] text-onbrand/70">{reply.q}</div>
          <p className="mt-1 leading-relaxed">{reply.a}</p>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => ask(s)}
            className="rounded-full bg-onbrand/15 px-3 py-1.5 text-[12px] hover:bg-onbrand/25"
          >
            {s}
          </button>
        ))}
      </div>
    </section>
  );
}

function RecentActivity() {
  return (
    <Panel title="Recent activity">
      <ul className="space-y-3">
        {activity.map((a) => (
          <li key={a.text} className="flex items-center gap-3">
            <i className={`size-2 shrink-0 rounded-full ${activityDot[a.kind]}`} />
            <span className="flex-1 text-ink">{a.text}</span>
            <span className="text-[11px] text-mute tabular-nums">{a.time}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* ---------- page ---------- */

/** The original retail dashboard (grocery, supermarket and other store types). */
function RetailDashboard() {
  const session = useSession();
  const firstName = greetingName(session?.name);
  const branches = useBranches();
  const branchName = branches.branches.find((b) => b.id === branches.currentId)?.name;
  // Demo: the sample store's fixed dates. Connected: today and the last 14 days.
  const head = useMemo(() => {
    if (!realData()) return { hello: 'Good morning', today: 'Tue, 14 May 2024', range: '1 – 14 May 2024', file: 'report-1-14-may-2024.csv' };
    const now = new Date();
    const from = new Date(now.getTime() - 13 * 86_400_000);
    const d = (x: Date, o: Intl.DateTimeFormatOptions) => x.toLocaleDateString('en-IN', o);
    const h = now.getHours();
    return {
      hello: h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening',
      today: d(now, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
      range: `${d(from, { day: 'numeric', month: 'short' })} – ${d(now, { day: 'numeric', month: 'short', year: 'numeric' })}`,
      file: `report-${now.toISOString().slice(0, 10)}.csv`,
    };
  }, []);
  return (
      <div className="p-5 lg:p-6 space-y-5">
        <section className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[26px] font-extrabold" suppressHydrationWarning>
              {head.hello}, {firstName}
            </h1>
            <p className="text-sub mt-1" suppressHydrationWarning>
              {head.today}
              {realData() ? (branchName ? ` · ${branchName}` : '') : ' · Anna Nagar branch'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="h-10 px-4 rounded-xl card flex items-center" suppressHydrationWarning>
              {head.range}
            </div>
            <button
              onClick={() =>
                downloadCsv(head.file, [
                  ['Product', 'Category', 'Units', 'Revenue', 'Stock'],
                  ...products.map((p) => [p.name, p.category, p.units, p.units * p.price, p.stock]),
                ])
              }
              className="h-10 px-4 rounded-xl card font-semibold"
            >
              Export report
            </button>
          </div>
        </section>

        <Hero />

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {kpis.map((k) => (
            <KpiCard key={k.label} k={k} />
          ))}
        </section>

        <section className="grid gap-3 lg:grid-cols-3">
          <SalesPerformance />
          <PaymentsAndBranches />
        </section>

        <section className="grid gap-3 lg:grid-cols-3">
          <TopProducts />
          <InventoryIntelligence />
        </section>

        {/* The assistant's answers are written for the sample store, so it is demo-only for now. */}
        <section className="grid gap-3 lg:grid-cols-3">
          {!realData() && <AiAssistant />}
          <RecentActivity />
        </section>
      </div>
  );
}

/** Each business type gets the dashboard that fits it; pharmacies get expiry, H1 register, refills and cold chain. */
function DashboardForBusiness() {
  const { businessType } = useBusinessProfile();
  // A store kept on this computer: figures from its own saved bills (after mount — they live in this browser).
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    if (!isLocalStore()) return;
    loadLocalDashboard();
    setLoaded((n) => n + 1);
  }, []);
  if (isLocalStore() && !loaded) return null;
  // The pharmacy dashboard runs on sample pharmacy data; connected businesses get the live one.
  return businessType === 'pharmacy' && !realData() ? <PharmacyDashboard /> : <RetailDashboard />;
}

export default function Dashboard() {
  return (
    <AppShell title="Dashboard">
      <DashboardForBusiness />
    </AppShell>
  );
}
