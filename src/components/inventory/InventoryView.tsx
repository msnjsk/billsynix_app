'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { PageHead, downloadCsv } from '@/components/AppShell';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { inr } from '@/lib/store-data';
import { categoryColor, categoryPill } from '@/lib/category-tones';
import {
  COVER_TARGET_DAYS,
  daysOfCover,
  expiringBatches,
  initialMovements,
  inventoryItems,
  statusOf,
  stockInReasons,
  stockOutReasons,
  suggestedOrder,
  type InventoryItem,
  type Movement,
  type StockStatus,
} from '@/lib/inventory-data';
import { useBranches } from '@/lib/branch-data';
import { isLive } from '@/lib/live/session';
import { useLiveVersion } from '@/lib/live/hydrate';
import { changeStock } from '@/lib/live/actions';
import { errorMessage } from '@/lib/api/client';
import { useNotice } from '@/components/live/Notice';

/* ---------- styling maps ---------- */

const statusMeta: Record<StockStatus, { label: string; badge: string; bar: string }> = {
  ok: { label: 'In stock', badge: 'bg-teal/15 text-teal', bar: 'bg-teal' },
  low: { label: 'Low', badge: 'bg-amber/15 text-amber', bar: 'bg-amber' },
  critical: { label: 'Critical', badge: 'bg-coral/15 text-coral', bar: 'bg-coral' },
  out: { label: 'Out of stock', badge: 'bg-coral text-onbrand', bar: 'bg-coral' },
};

const filters = {
  all: { label: 'All', test: () => true },
  reorder: { label: 'Needs reorder', test: (s: StockStatus) => s !== 'ok' },
  critical: { label: 'Critical', test: (s: StockStatus) => s === 'critical' || s === 'out' },
  ok: { label: 'In stock', test: (s: StockStatus) => s === 'ok' },
} as const;
type FilterKey = keyof typeof filters;

const sorts = {
  cover: { label: 'Days of cover', fn: (a: InventoryItem, b: InventoryItem) => daysOfCover(a) - daysOfCover(b) },
  name: { label: 'Name', fn: (a: InventoryItem, b: InventoryItem) => a.name.localeCompare(b.name) },
  value: { label: 'Stock value', fn: (a: InventoryItem, b: InventoryItem) => b.stock * b.cost - a.stock * a.cost },
  stock: { label: 'Units on hand', fn: (a: InventoryItem, b: InventoryItem) => a.stock - b.stock },
} as const;
type SortKey = keyof typeof sorts;

const formatCover = (d: number) => (d === Infinity ? '—' : d < 1 ? '< 1 day' : `${Math.floor(d)} days`);

/* ---------- small building blocks ---------- */

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

function StatCard({
  label,
  value,
  foot,
  progress,
  tone = 'bg-blue',
  highlight,
}: {
  label: string;
  value: string;
  foot: string;
  progress: number;
  tone?: string;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-2xl p-4 ${highlight ? 'gco text-onbrand shadow-lg shadow-coral/25' : 'card'}`}>
      <div className={highlight ? 'text-onbrand/85' : 'text-sub'}>{label}</div>
      <div className={`mt-2 text-[22px] font-extrabold tabular-nums ${highlight ? '' : 'text-ink'}`}>{value}</div>
      <div className={`mt-3 h-1 overflow-hidden rounded-full ${highlight ? 'bg-onbrand/30' : 'bg-line'}`}>
        <div
          className={`h-full rounded-full ${highlight ? 'bg-onbrand' : tone}`}
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
      <div className={`mt-2 text-[11px] ${highlight ? 'text-onbrand/85' : 'text-mute'}`}>{foot}</div>
    </div>
  );
}

/* ---------- stock update dialog ---------- */

type Draft = { product: string; direction: 'in' | 'out'; qty: number };

function StockForm({
  items,
  draft,
  onSubmit,
  onCancel,
}: {
  items: InventoryItem[];
  draft: Draft;
  onSubmit: (product: string, signedQty: number, reason: string) => void;
  onCancel: () => void;
}) {
  const [product, setProduct] = useState(draft.product);
  const [direction, setDirection] = useState(draft.direction);
  const [qty, setQty] = useState(String(draft.qty || ''));
  const reasons = direction === 'in' ? stockInReasons : stockOutReasons;
  const [reason, setReason] = useState<string>(reasons[0]);

  const item = items.find((i) => i.name === product);
  const n = Number(qty);
  const error =
    !item
      ? 'Choose a product.'
      : !Number.isInteger(n) || n <= 0
        ? 'Enter a whole number above 0.'
        : direction === 'out' && n > item.stock
          ? `Only ${item.stock} units on hand.`
          : null;
  const after = item && !error ? item.stock + (direction === 'in' ? n : -n) : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (error || !item) return;
    onSubmit(item.name, direction === 'in' ? n : -n, reason);
  };

  const field = 'h-10 w-full rounded-xl border border-line bg-surface px-3 text-ink outline-none focus:border-blue';

  return (
    <form onSubmit={submit} className="space-y-4 text-[13px]">
      <div className="flex rounded-xl bg-bg p-1" role="radiogroup" aria-label="Direction">
        {(['in', 'out'] as const).map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={direction === d}
            onClick={() => {
              setDirection(d);
              setReason((d === 'in' ? stockInReasons : stockOutReasons)[0]);
            }}
            className={`flex-1 rounded-lg py-2 font-semibold ${
              direction === d ? 'bg-surface text-ink shadow-sm' : 'text-sub'
            }`}
          >
            {d === 'in' ? 'Stock in' : 'Stock out'}
          </button>
        ))}
      </div>

      <label className="block">
        <span className="mb-1.5 block font-semibold text-ink">Product</span>
        <select value={product} onChange={(e) => setProduct(e.target.value)} className={field}>
          <option value="">Select a product…</option>
          {items.map((i) => (
            <option key={i.sku} value={i.name}>
              {i.name} ({i.stock} on hand)
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1.5 block font-semibold text-ink">Quantity</span>
          <input
            type="number"
            min={1}
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className={field}
            aria-invalid={Boolean(error && qty)}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block font-semibold text-ink">Reason</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)} className={field}>
            {reasons.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex min-h-10 items-center justify-between rounded-xl bg-bg px-3 py-2">
        {after !== null && item ? (
          <>
            <span className="text-sub">On hand after update</span>
            <span className="font-bold tabular-nums text-ink">
              {item.stock} → <span className={direction === 'in' ? 'text-teal' : 'text-coral'}>{after}</span>
            </span>
          </>
        ) : (
          <span className="text-coral">{qty || product ? error : 'Fill in the details above.'}</span>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="h-10 rounded-xl card px-4 font-semibold">
          Cancel
        </button>
        <button
          type="submit"
          disabled={Boolean(error)}
          className="h-10 rounded-xl gbv px-5 font-semibold text-onbrand disabled:opacity-50"
        >
          {direction === 'in' ? 'Add stock' : 'Remove stock'}
        </button>
      </div>
    </form>
  );
}

/* ---------- main view ---------- */

export function InventoryView() {
  const [items, setItems] = useState(inventoryItems);
  const [movements, setMovements] = useState<Movement[]>(initialMovements);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<SortKey>('cover');
  const [dialog, setDialog] = useState<{ key: number; draft: Draft } | null>(null);
  const [notice, notify] = useNotice();
  // Connected: stock and the activity list reload from the server after every change.
  const liveVersion = useLiveVersion();
  useEffect(() => {
    if (!isLive()) return;
    setItems([...inventoryItems]);
    setMovements([...initialMovements]);
  }, [liveVersion]);

  const categories = useMemo(() => ['All', ...new Set(items.map((i) => i.category))], [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((i) => category === 'All' || i.category === category)
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q))
      .filter((i) => filters[filter].test(statusOf(i)))
      .sort(sorts[sort].fn);
  }, [items, query, category, filter, sort]);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(filters) as FilterKey[]).map((k) => [
          k,
          items.filter((i) => filters[k].test(statusOf(i))).length,
        ])
      ) as Record<FilterKey, number>,
    [items]
  );

  const totalValue = items.reduce((s, i) => s + i.stock * i.cost, 0);
  const totalUnits = items.reduce((s, i) => s + i.stock, 0);
  const critical = counts.critical;
  const needReorder = counts.reorder;
  const expiringQty = expiringBatches.reduce((s, b) => s + b.qty, 0);

  const byCategory = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((i) => map.set(i.category, (map.get(i.category) ?? 0) + i.stock * i.cost));
    return [...map.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [items]);
  const maxCat = byCategory[0]?.value ?? 1;

  const openDialog = (draft: Draft) => setDialog({ key: Date.now(), draft });

  const applyUpdate = (product: string, qty: number, reason: string) => {
    if (isLive()) {
      const sku = items.find((i) => i.name === product)?.sku;
      if (!sku) return;
      changeStock(sku, qty, reason)
        .then((r) => {
          setDialog(null);
          notify(r.message ?? `Stock of ${product} updated`);
        })
        .catch((e: unknown) => notify(errorMessage(e), true));
      return;
    }
    setItems((prev) => prev.map((i) => (i.name === product ? { ...i, stock: i.stock + qty } : i)));
    const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
    setMovements((prev) => [{ id: Date.now(), product, qty, reason, time }, ...prev].slice(0, 8));
    setDialog(null);
  };

  const exportCsv = () =>
    downloadCsv('inventory-14-may-2024.csv', [
      ['SKU', 'Product', 'Category', 'Supplier', 'On hand', 'Unit cost', 'Stock value', 'Days of cover', 'Status', 'Suggested order'],
      ...visible.map((i) => [
        i.sku,
        i.name,
        i.category,
        i.supplier,
        i.stock,
        i.cost,
        i.stock * i.cost,
        Number.isFinite(daysOfCover(i)) ? daysOfCover(i).toFixed(1) : '',
        statusMeta[statusOf(i)].label,
        suggestedOrder(i),
      ]),
    ]);

  const branchState = useBranches();
  const hq = branchState.branches.find((b) => b.isHq);
  const hqName = hq ? (branchState.branches.length > 1 ? `${hq.name} branch` : hq.name) : 'Main branch';
  return (
    <div className="space-y-4 p-5 lg:p-6">
      <PageHead title="Inventory" sub={`${items.length} products · ${hqName} · as of 14 May 2024, 10:42`}>
        <button onClick={exportCsv} className="h-10 rounded-xl card px-4 font-semibold">
          Export CSV
        </button>
        <button
          onClick={() => openDialog({ product: '', direction: 'in', qty: 0 })}
          className="flex h-10 items-center rounded-xl gbv px-5 font-semibold text-onbrand shadow-lg shadow-blue/25"
        >
          + Stock in
        </button>
      </PageHead>

      {/* Summary */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Stock value (at cost)"
          value={inr(totalValue)}
          foot={`${totalUnits.toLocaleString('en-IN')} units on hand`}
          progress={72}
        />
        <StatCard
          label="Healthy stock"
          value={`${counts.ok} of ${items.length}`}
          foot={`${COVER_TARGET_DAYS}+ days of cover is the target`}
          progress={(counts.ok / items.length) * 100}
          tone="bg-teal"
        />
        <StatCard
          label="Needs reorder"
          value={`${needReorder} Products`}
          foot={`${critical} critical (5 units or fewer)`}
          progress={(needReorder / items.length) * 100}
          highlight
        />
        <StatCard
          label="Expiring in 7 days"
          value={`${expiringBatches.length} batches`}
          foot={`${expiringQty} units at risk`}
          progress={(expiringBatches.length / items.length) * 100}
          tone="bg-amber"
        />
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        {/* Stock table */}
        <Panel title="Stock levels" sub="Days of cover = units on hand ÷ average daily sales" className="lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or SKU…"
              aria-label="Search inventory"
              className="h-9 min-w-[180px] flex-1 rounded-xl border border-line bg-bg px-3 outline-none focus:border-blue"
            />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label="Category"
              className="h-9 rounded-xl border border-line bg-surface px-3"
            >
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort by"
              className="h-9 rounded-xl border border-line bg-surface px-3"
            >
              {(Object.keys(sorts) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  Sort: {sorts[k].label}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-3 flex flex-wrap gap-1 rounded-lg bg-bg p-0.5 w-fit" role="tablist" aria-label="Status">
            {(Object.keys(filters) as FilterKey[]).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={filter === k}
                onClick={() => setFilter(k)}
                className={`rounded-md px-3 py-1 text-[12px] ${
                  filter === k ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-sub'
                }`}
              >
                {filters[k].label} <span className="text-mute tabular-nums">{counts[k]}</span>
              </button>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                  <th className="pb-2 font-medium">Product</th>
                  <th className="pb-2 font-medium">Category</th>
                  <th className="pb-2 font-medium">On hand</th>
                  <th className="pb-2 font-medium">Cover</th>
                  <th className="pb-2 font-medium text-right">Value</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((i) => {
                  const status = statusOf(i);
                  const meta = statusMeta[status];
                  const cover = daysOfCover(i);
                  const suggest = suggestedOrder(i);
                  const level = Number.isFinite(cover) ? (cover / COVER_TARGET_DAYS) * 100 : 100;
                  return (
                    <tr key={i.sku} className="h-[54px] border-t border-line">
                      <td>
                        <div className="font-semibold text-ink">{i.name}</div>
                        <div className="text-[11px] text-mute">
                          {i.sku} · {i.supplier}
                        </div>
                      </td>
                      <td>
                        <span
                          className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${categoryPill(i.category)}`}
                        >
                          {i.category}
                        </span>
                      </td>
                      <td className="w-[130px]">
                        <div className={`font-semibold tabular-nums ${status === 'ok' ? 'text-ink' : 'text-coral'}`}>
                          {i.stock}
                        </div>
                        <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-line">
                          <div className={`h-full rounded-full ${meta.bar}`} style={{ width: `${Math.min(level, 100)}%` }} />
                        </div>
                      </td>
                      <td className="tabular-nums">{formatCover(cover)}</td>
                      <td className="text-right font-semibold tabular-nums text-ink">{inr(i.stock * i.cost)}</td>
                      <td>
                        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${meta.badge}`}>
                          {meta.label}
                        </span>
                      </td>
                      <td className="text-right">
                        {status !== 'ok' && suggest > 0 ? (
                          <button
                            onClick={() => openDialog({ product: i.name, direction: 'in', qty: suggest })}
                            className="h-8 rounded-lg gbv px-3 text-[12px] font-semibold text-onbrand"
                          >
                            Reorder {suggest}
                          </button>
                        ) : (
                          <button
                            onClick={() => openDialog({ product: i.name, direction: 'in', qty: 0 })}
                            className="h-8 rounded-lg border border-line px-3 text-[12px] font-semibold text-ink hover:border-blue"
                          >
                            Adjust
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visible.length === 0 && (
              <div className="border-t border-line py-10 text-center text-sub">
                No products match these filters.{' '}
                <button
                  className="font-semibold text-blue"
                  onClick={() => {
                    setQuery('');
                    setCategory('All');
                    setFilter('all');
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}
          </div>
        </Panel>

        {/* Side panels */}
        <div className="space-y-3">
          <Panel title="Value by category" sub={`${inr(totalValue)} at cost`}>
            <ul className="space-y-3">
              {byCategory.map((c) => (
                <li key={c.name}>
                  <div className="mb-1.5 flex justify-between">
                    <span className="font-semibold text-ink">{c.name}</span>
                    <span className="tabular-nums text-sub">
                      {inr(c.value)} · {Math.round((c.value / totalValue) * 100)}%
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-line">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(c.value / maxCat) * 100}%`,
                        background: categoryColor(c.name),
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Expiring in 7 days" sub="Sell first or mark down">
            <ul className="space-y-3">
              {expiringBatches.map((b) => (
                <li key={b.batch} className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-ink">{b.name}</div>
                    <div className="text-[10px] text-mute">
                      Batch #{b.batch} · {b.qty} units
                    </div>
                  </div>
                  <span className={`text-[12px] font-semibold ${b.days <= 2 ? 'text-coral' : 'text-amber'}`}>
                    {b.days} {b.days === 1 ? 'day' : 'days'}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Stock movements" sub="Latest changes at this branch">
            <ul className="space-y-3">
              {movements.map((m) => (
                <li key={m.id} className="flex items-center gap-3">
                  <span
                    className={`grid size-7 shrink-0 place-items-center rounded-lg text-[11px] font-bold ${
                      m.qty > 0 ? 'bg-teal/15 text-teal' : 'bg-coral/15 text-coral'
                    }`}
                    aria-hidden="true"
                  >
                    {m.qty > 0 ? '↑' : '↓'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ink">{m.product}</div>
                    <div className="text-[11px] text-mute">{m.reason}</div>
                  </div>
                  <div className="text-right">
                    <div className={`font-semibold tabular-nums ${m.qty > 0 ? 'text-teal' : 'text-coral'}`}>
                      {m.qty > 0 ? '+' : '−'}
                      {Math.abs(m.qty)}
                    </div>
                    <div className="text-[11px] text-mute tabular-nums">{m.time}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </section>

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="rounded-2xl border-line bg-surface text-ink">
          <DialogHeader>
            <DialogTitle className="text-[18px] font-extrabold">Update stock</DialogTitle>
            <DialogDescription className="text-sub">
              Record stock received or removed.{isLive() ? '' : ' Changes are kept on this page only until a backend is connected.'}
            </DialogDescription>
          </DialogHeader>
          {dialog && (
            <StockForm
              key={dialog.key}
              items={items}
              draft={dialog.draft}
              onSubmit={applyUpdate}
              onCancel={() => setDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      {notice}
    </div>
  );
}
