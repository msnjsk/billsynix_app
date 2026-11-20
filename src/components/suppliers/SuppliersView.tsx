'use client';

import { isLive } from '@/lib/live/session';
import { live, useLiveVersion } from '@/lib/live/hydrate';
import { apiConfigured, errorMessage } from '@/lib/api/client';
import { useNotice } from '@/components/live/Notice';
import { createPurchaseOrder, createSupplier, recordSupplierPayment } from '@/lib/live/actions';
import Link from 'next/link';
import { posCatalog } from '@/lib/pos/catalog';
import { suppliers as liveSuppliers, usePurchases, type PurchaseState } from '@/lib/purchase-data';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PageHead, downloadCsv } from '@/components/AppShell';
import { PaymentForm, PurchaseOrderForm, SupplierForm, type SupplierFormValues } from '@/components/suppliers/SupplierForms';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { inr } from '@/lib/store-data';
import { inventoryItems, statusOf, suggestedOrder, type StockStatus } from '@/lib/inventory-data';
import {
  TODAY,
  addDays,
  daysFromToday,
  dueLabel,
  dueState,
  fmtDate,
  initialPurchaseOrders,
  initialSuppliers,
  slug,
  type DueState,
  type PaymentMethod,
  type PoLine,
  type PurchaseOrder,
  type Supplier,
} from '@/lib/suppliers-data';

/* ---------- config ---------- */

const dueMeta: Record<DueState, { label: string; pill: string; text: string }> = {
  overdue: { label: 'Overdue', pill: 'bg-coral/15 text-coral', text: 'text-coral' },
  soon: { label: 'Due soon', pill: 'bg-amber/15 text-amber', text: 'text-amber' },
  upcoming: { label: 'Upcoming', pill: 'bg-sky/15 text-sky', text: 'text-sub' },
  settled: { label: 'Settled', pill: 'bg-teal/15 text-teal', text: 'text-teal' },
};

const filters = {
  all: { label: 'All', test: () => true },
  overdue: { label: 'Overdue', test: (s: DueState) => s === 'overdue' },
  soon: { label: 'Due soon', test: (s: DueState) => s === 'soon' },
  settled: { label: 'Settled', test: (s: DueState) => s === 'settled' },
} as const;
type FilterKey = keyof typeof filters;

const stockPill: Record<StockStatus, string> = {
  ok: 'bg-teal/15 text-teal',
  low: 'bg-amber/15 text-amber',
  critical: 'bg-coral/15 text-coral',
  out: 'bg-coral text-onbrand',
};

type Modal =
  | { kind: 'add'; key: number }
  | { kind: 'view' | 'pay' | 'order'; id: string; key: number };

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

const productsOf = (s: Supplier) => inventoryItems.filter((i) => i.supplier === s.name);
const reorderLines = (s: Supplier): PoLine[] =>
  productsOf(s)
    .filter((i) => statusOf(i) !== 'ok' && suggestedOrder(i) > 0)
    .map((i) => ({ name: i.name, qty: suggestedOrder(i), cost: i.cost }));

/* ---------- small pieces ---------- */

export function Panel({
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

export function StatCard({
  label,
  value,
  foot,
  variant,
}: {
  label: string;
  value: string;
  foot: string;
  variant?: 'brand' | 'alert';
}) {
  const bg =
    variant === 'brand'
      ? 'gbv text-onbrand shadow-lg shadow-blue/25'
      : variant === 'alert'
        ? 'gco text-onbrand shadow-lg shadow-coral/25'
        : 'card';
  const muted = variant ? 'text-onbrand/80' : 'text-sub';
  return (
    <div className={`rounded-2xl p-4 ${bg}`}>
      <div className={muted}>{label}</div>
      <div className={`mt-2 text-[24px] font-extrabold tabular-nums ${variant ? '' : 'text-ink'}`}>{value}</div>
      <div className={`mt-1 text-[12px] ${variant ? 'text-onbrand/85' : 'text-mute'}`}>{foot}</div>
    </div>
  );
}

export function Avatar({ name, size = 'size-10' }: { name: string; size?: string }) {
  return (
    <span className={`grid ${size} shrink-0 place-items-center rounded-xl gbv text-[13px] font-bold text-onbrand`}>
      {initials(name)}
    </span>
  );
}

export function SmallButton({
  onClick,
  children,
  tone = 'default',
}: {
  onClick: () => void;
  children: ReactNode;
  tone?: 'default' | 'brand';
}) {
  return (
    <button
      onClick={onClick}
      className={`h-8 rounded-lg px-3 text-[12px] font-semibold ${
        tone === 'brand' ? 'gbv text-onbrand' : 'border border-line text-ink hover:border-blue'
      }`}
    >
      {children}
    </button>
  );
}

/* ---------- supplier detail ---------- */

function SupplierDetail({
  s,
  orders,
  onPay,
  onOrder,
}: {
  s: Supplier;
  orders: PurchaseOrder[];
  onPay: () => void;
  onOrder: () => void;
}) {
  const items = productsOf(s);
  const state = dueState(s);
  return (
    <div className="space-y-5 text-[13px]">
      <div className="grid grid-cols-2 gap-3 rounded-xl bg-bg p-3 text-[12px] sm:grid-cols-3">
        <Info label="Contact" value={s.contact || '—'} />
        <Info
          label="Phone"
          value={
            <a href={`tel:${s.phone.replace(/\s/g, '')}`} className="text-blue">
              {s.phone}
            </a>
          }
        />
        <Info
          label="Email"
          value={
            s.email ? (
              <a href={`mailto:${s.email}`} className="break-all text-blue">
                {s.email}
              </a>
            ) : (
              '—'
            )
          }
        />
        <Info label="GSTIN" value={s.gstin || '—'} />
        <Info label="Credit terms" value={`${s.creditDays} days`} />
        <Info label="Supplier since" value={String(s.since)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3">
        <div>
          <div className="text-sub">Outstanding</div>
          <div className="text-[20px] font-extrabold tabular-nums text-ink">{inr(s.due)}</div>
          <div className={`text-[12px] font-semibold ${dueMeta[state].text}`}>{dueLabel(s)}</div>
        </div>
        <div className="flex gap-2">
          <SmallButton onClick={onOrder}>Create order</SmallButton>
          {s.due > 0 && (
            <SmallButton onClick={onPay} tone="brand">
              Record payment
            </SmallButton>
          )}
        </div>
      </div>

      <section>
        <h3 className="mb-2 font-bold text-ink">Products supplied ({items.length})</h3>
        {items.length === 0 ? (
          <p className="text-sub">No catalogue products are linked to this supplier yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((i) => {
              const st = statusOf(i);
              return (
                <li key={i.sku} className="flex items-center justify-between py-2">
                  <span className="text-ink">{i.name}</span>
                  <span className="flex items-center gap-3">
                    <span className="text-[12px] tabular-nums text-sub">{inr(i.cost)} cost</span>
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${stockPill[st]}`}>
                      {i.stock} in stock
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 font-bold text-ink">Payments</h3>
          {s.payments.length === 0 ? (
            <p className="text-sub">No payments recorded.</p>
          ) : (
            <ul className="space-y-2">
              {s.payments.map((p, i) => (
                <li key={`${p.date}-${i}`} className="flex justify-between gap-2">
                  <span>
                    <span className="text-ink">{fmtDate(p.date)}</span>{' '}
                    <span className="text-[11px] text-mute">
                      {p.method}
                      {p.ref ? ` · ${p.ref}` : ''}
                    </span>
                  </span>
                  <b className="tabular-nums text-teal">{inr(p.amount)}</b>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-2 font-bold text-ink">Purchase orders</h3>
          {orders.length === 0 ? (
            <p className="text-sub">No orders yet.</p>
          ) : (
            <ul className="space-y-2">
              {orders.map((o) => (
                <li key={o.id} className="flex justify-between gap-2">
                  <span>
                    <span className="text-ink">{o.id}</span>{' '}
                    <span className="text-[11px] text-mute">
                      {fmtDate(o.date)} · {o.status}
                    </span>
                  </span>
                  <b className="tabular-nums text-ink">{inr(o.total)}</b>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

export function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-mute">{label}</div>
      <div className="font-semibold text-ink">{value}</div>
    </div>
  );
}

/** Connected: the server's purchase orders, newest first, in this screen's simpler shape. */
function serverOrders(pos: PurchaseState['pos'], sups: Supplier[]): PurchaseOrder[] {
  return pos
    .filter((o) => o.status !== 'cancelled')
    .map((o) => ({
      id: live.pos.find((x) => x.id === o.id)?.number ?? o.id,
      supplier: sups.find((x) => x.id === o.supplierId)?.name ?? 'Supplier',
      date: o.date,
      expected: o.expected || o.date,
      status: o.status === 'received' ? ('Received' as const) : ('Ordered' as const),
      lines: o.lines.map((l) => ({ name: l.name, qty: l.qty, cost: l.rate })),
      // What the supplier will bill: after line discounts, with GST.
      total: o.lines.reduce((t, l) => t + l.qty * l.rate * (1 - l.discountPct / 100) * (1 + l.gst / 100), 0),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/* ---------- main view ---------- */

export function SuppliersView() {
  const [suppliers, setSuppliers] = useState<Supplier[]>(initialSuppliers);
  const [liveNotice, notify] = useNotice();
  // Connected: suppliers, balances and payments reload from the server after every change.
  const liveVersion = useLiveVersion();
  useEffect(() => {
    if (isLive()) setSuppliers([...liveSuppliers]);
  }, [liveVersion]);
  // The sample orders only on the demo / this-computer store; connected, the server's.
  const [orders, setOrders] = useState<PurchaseOrder[]>(apiConfigured ? [] : initialPurchaseOrders);
  const purchases = usePurchases();
  useEffect(() => {
    if (isLive()) setOrders(serverOrders(purchases.pos, liveSuppliers));
  }, [purchases, liveVersion]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [modal, setModal] = useState<Modal | null>(null);
  const [nextPo, setNextPo] = useState(1047);

  const open = (m: Omit<Extract<Modal, { id: string }>, 'key'>) => setModal({ ...m, key: Date.now() });
  const active = modal && modal.kind !== 'add' ? (suppliers.find((s) => s.id === modal.id) ?? null) : null;

  const counts = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(filters) as FilterKey[]).map((k) => [k, suppliers.filter((s) => filters[k].test(dueState(s))).length])
      ) as Record<FilterKey, number>,
    [suppliers]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rank: Record<DueState, number> = { overdue: 0, soon: 1, upcoming: 2, settled: 3 };
    return suppliers
      .filter((s) => filters[filter].test(dueState(s)))
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.contact.toLowerCase().includes(q) ||
          s.supplies.toLowerCase().includes(q) ||
          s.phone.replace(/\s/g, '').includes(q.replace(/\s/g, ''))
      )
      .sort((a, b) => rank[dueState(a)] - rank[dueState(b)] || b.due - a.due);
  }, [suppliers, query, filter]);

  /* summary */
  const outstanding = suppliers.reduce((s, x) => s + x.due, 0);
  const owing = suppliers.filter((s) => s.due > 0).length;
  const overdue = suppliers.filter((s) => dueState(s) === 'overdue');
  const overdueAmt = overdue.reduce((s, x) => s + x.due, 0);
  const next7 = suppliers.filter((s) => s.dueDate && s.due > 0 && daysFromToday(s.dueDate) >= 0 && daysFromToday(s.dueDate) <= 7);
  const monthOrders = orders.filter((o) => o.date.startsWith(TODAY.slice(0, 7)));
  const monthSpend = monthOrders.reduce((s, o) => s + o.total, 0);
  const openOrders = orders.filter((o) => o.status === 'Ordered').length;

  const schedule = suppliers
    .filter((s) => s.due > 0 && s.dueDate)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));

  /* actions */
  const update = (id: string, fn: (s: Supplier) => Supplier) =>
    setSuppliers((prev) => prev.map((s) => (s.id === id ? fn(s) : s)));

  const addSupplier = (v: SupplierFormValues) => {
    if (isLive()) {
      createSupplier(v)
        .then(() => {
          setModal(null);
          notify(`${v.name} added`);
        })
        .catch((e: unknown) => notify(errorMessage(e), true));
      return;
    }
    setSuppliers((prev) => [
      ...prev,
      {
        id: slug(v.name),
        name: v.name,
        contact: v.contact,
        phone: v.phone,
        email: v.email,
        gstin: v.gstin,
        supplies: v.supplies,
        creditDays: v.creditDays,
        since: Number(TODAY.slice(0, 4)),
        onTime: 100,
        lastDelivery: null,
        due: 0,
        dueDate: null,
        payments: [],
      },
    ]);
    setModal(null);
  };

  const recordPayment = (id: string, amount: number, method: PaymentMethod, ref: string) => {
    if (isLive()) {
      recordSupplierPayment({ supplierId: id, date: TODAY, amount, mode: method, ref, allocations: [], notes: '' })
        .then((r) => {
          setModal(null);
          notify(`${r.number} recorded — oldest bills settled first`);
        })
        .catch((e: unknown) => notify(errorMessage(e), true));
      return;
    }
    update(id, (s) => {
      const due = Math.max(0, Math.round((s.due - amount) * 100) / 100);
      return {
        ...s,
        due,
        dueDate: due > 0 ? s.dueDate : null,
        payments: [{ date: TODAY, amount, method, ref }, ...s.payments],
      };
    });
    setModal({ kind: 'view', id, key: Date.now() });
  };

  const placeOrder = (s: Supplier, lines: PoLine[]) => {
    if (isLive()) {
      // A real order on the server, sent to the supplier (large ones wait for approval).
      const ui = lines.flatMap((l) => {
        const item = inventoryItems.find((i) => i.name === l.name);
        if (!item) return [];
        return [{ sku: item.sku, qty: l.qty, rate: l.cost, discountPct: 0, gst: posCatalog.find((c) => c.sku === item.sku)?.gst ?? 0 }];
      });
      if (!ui.length) {
        notify('Add at least one product to the order.', true);
        return;
      }
      createPurchaseOrder({ supplierId: s.id, date: TODAY, expected: addDays(TODAY, 2), status: 'sent', lines: ui, notes: '' })
        .then((r) => {
          setModal(null);
          notify(r.message ?? `${r.number} sent to ${s.name}`);
        })
        .catch((e: unknown) => notify(errorMessage(e), true));
      return;
    }
    const total = lines.reduce((t, l) => t + l.qty * l.cost, 0);
    setOrders((prev) => [
      { id: `PO-${nextPo}`, supplier: s.name, date: TODAY, expected: addDays(TODAY, 2), status: 'Ordered', lines, total },
      ...prev,
    ]);
    setNextPo((n) => n + 1);
    setModal(null);
  };

  /** Receiving goods adds the order to the supplier's bill, payable after their credit period. */
  const receive = (po: PurchaseOrder) => {
    setOrders((prev) => prev.map((o) => (o.id === po.id ? { ...o, status: 'Received' } : o)));
    const sup = suppliers.find((s) => s.name === po.supplier);
    if (sup)
      update(sup.id, (s) => ({
        ...s,
        due: s.due + po.total,
        dueDate: s.dueDate ?? addDays(TODAY, s.creditDays),
        lastDelivery: TODAY,
      }));
  };

  const exportCsv = () =>
    downloadCsv('suppliers.csv', [
      ['Supplier', 'Contact', 'Phone', 'Email', 'GSTIN', 'Supplies', 'Credit days', 'Outstanding', 'Due date', 'Status'],
      ...visible.map((s) => [
        s.name,
        s.contact,
        s.phone,
        s.email,
        s.gstin,
        s.supplies,
        s.creditDays,
        s.due,
        s.dueDate ?? '',
        dueMeta[dueState(s)].label,
      ]),
    ]);

  return (
    <div className="space-y-4 p-5 lg:p-6">
      <PageHead title="Suppliers" sub={`${suppliers.length} suppliers · ${inr(outstanding)} outstanding · as of ${fmtDate(TODAY)} ${TODAY.slice(0, 4)}`}>
        <a href="/purchases" className="flex h-10 items-center rounded-xl card px-4 font-semibold text-blue">
          Purchases: orders, bills &amp; payments →
        </a>
        <button onClick={exportCsv} className="h-10 rounded-xl card px-4 font-semibold">
          Export CSV
        </button>
        <button
          onClick={() => setModal({ kind: 'add', key: Date.now() })}
          className="flex h-10 items-center rounded-xl gbv px-5 font-semibold text-onbrand shadow-lg shadow-blue/25"
        >
          + Add supplier
        </button>
      </PageHead>

      {/* Summary */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total outstanding" value={inr(outstanding)} foot={`Owed to ${owing} of ${suppliers.length} suppliers`} variant="brand" />
        <StatCard
          label="Overdue"
          value={inr(overdueAmt)}
          foot={overdue.length ? `${overdue.map((s) => s.name).join(', ')}` : 'Nothing overdue'}
          {...(overdue.length ? { variant: 'alert' as const } : {})}
        />
        <StatCard
          label="Due in next 7 days"
          value={inr(next7.reduce((s, x) => s + x.due, 0))}
          foot={`${next7.length} payment${next7.length === 1 ? '' : 's'} scheduled`}
        />
        <StatCard
          label="Purchases this month"
          value={inr(monthSpend)}
          foot={`${monthOrders.length} orders · ${openOrders} awaiting delivery`}
        />
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        {/* Supplier list */}
        <Panel title="All suppliers" sub="Sorted by payment urgency" className="lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, contact, phone or items…"
              aria-label="Search suppliers"
              className="h-9 min-w-[200px] flex-1 rounded-xl border border-line bg-bg px-3 outline-none focus:border-blue"
            />
            <div className="flex rounded-lg bg-bg p-0.5" role="tablist" aria-label="Payment status">
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
                  {filters[k].label} <span className="tabular-nums text-mute">{counts[k]}</span>
                </button>
              ))}
            </div>
          </div>

          <ul className="divide-y divide-line">
            {visible.map((s) => {
              const state = dueState(s);
              const reorder = reorderLines(s);
              const itemCount = productsOf(s).length;
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-4 py-4">
                  <Avatar name={s.name} />
                  <div className="min-w-[200px] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button onClick={() => open({ kind: 'view', id: s.id })} className="font-bold text-ink hover:text-blue">
                        {s.name}
                      </button>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${dueMeta[state].pill}`}>
                        {dueMeta[state].label}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-sub">
                      {s.contact && `${s.contact} · `}
                      <a href={`tel:${s.phone.replace(/\s/g, '')}`} className="hover:text-blue">
                        {s.phone}
                      </a>
                    </div>
                    <div className="mt-0.5 text-[11px] text-mute">
                      {s.supplies} · {itemCount} products · {s.onTime}% on time
                    </div>
                  </div>
                  <div className="min-w-[140px] text-right">
                    <div className="text-[16px] font-extrabold tabular-nums text-ink">{inr(s.due)}</div>
                    <div className={`text-[11px] font-semibold ${dueMeta[state].text}`}>{dueLabel(s)}</div>
                  </div>
                  <div className="flex gap-1.5">
                    <SmallButton onClick={() => open({ kind: 'view', id: s.id })}>View</SmallButton>
                    {reorder.length > 0 && (
                      <SmallButton onClick={() => open({ kind: 'order', id: s.id })}>
                        Reorder <span className="text-coral">{reorder.length}</span>
                      </SmallButton>
                    )}
                    {s.due > 0 && (
                      <SmallButton onClick={() => open({ kind: 'pay', id: s.id })} tone="brand">
                        Pay
                      </SmallButton>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {suppliers.length === 0 ? (
            <div className="py-10 text-center text-sub">
              No suppliers yet.{' '}
              <button className="font-semibold text-blue" onClick={() => setModal({ kind: 'add', key: Date.now() })}>
                Add your first supplier
              </button>
            </div>
          ) : visible.length === 0 && (
            <div className="py-10 text-center text-sub">
              No suppliers match.{' '}
              <button
                className="font-semibold text-blue"
                onClick={() => {
                  setQuery('');
                  setFilter('all');
                }}
              >
                Clear filters
              </button>
            </div>
          )}
        </Panel>

        {/* Side panels */}
        <div className="space-y-3">
          <Panel title="Payment schedule" sub="Oldest due first">
            {schedule.length === 0 ? (
              <p className="text-sub">All suppliers are settled.</p>
            ) : (
              <ul className="space-y-3">
                {schedule.map((s) => {
                  const state = dueState(s);
                  const [day, mon] = fmtDate(s.dueDate!).split(' ');
                  return (
                    <li key={s.id} className="flex items-center gap-3">
                      <div
                        className={`grid size-11 shrink-0 place-items-center rounded-xl text-center leading-tight ${dueMeta[state].pill}`}
                      >
                        <div>
                          <div className="text-[14px] font-extrabold">{day}</div>
                          <div className="text-[10px] font-semibold uppercase">{mon}</div>
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold text-ink">{s.name}</div>
                        <div className={`text-[11px] ${dueMeta[state].text}`}>{dueLabel(s)}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold tabular-nums text-ink">{inr(s.due)}</div>
                        <button
                          onClick={() => open({ kind: 'pay', id: s.id })}
                          className="text-[11px] font-semibold text-blue"
                        >
                          Pay now
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title="Purchase orders" sub={`${openOrders} awaiting delivery`}>
            {orders.length === 0 && <p className="text-[12.5px] text-sub">No purchase orders yet. Open a supplier to place one.</p>}
            <ul className="space-y-3">
              {orders.slice(0, 6).map((o) => (
                <li key={o.id} className="flex items-center gap-3">
                  <span
                    className={`grid size-8 shrink-0 place-items-center rounded-lg text-[12px] font-bold ${
                      o.status === 'Ordered' ? 'bg-amber/15 text-amber' : 'bg-teal/15 text-teal'
                    }`}
                    aria-hidden="true"
                  >
                    {o.status === 'Ordered' ? '⏳' : '✓'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ink">
                      <b>{o.id}</b> · {o.supplier}
                    </div>
                    <div className="text-[11px] text-mute">
                      {o.status === 'Ordered' ? `Expected ${fmtDate(o.expected)}` : `Received ${fmtDate(o.expected)}`}
                      {o.lines.length > 0 && ` · ${o.lines.length} items`}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold tabular-nums text-ink">{inr(o.total)}</div>
                    {o.status === 'Ordered' &&
                      (isLive() ? (
                        <Link href="/purchases" className="text-[11px] font-semibold text-blue">
                          Receive in Purchases →
                        </Link>
                      ) : (
                        <button onClick={() => receive(o)} className="text-[11px] font-semibold text-blue">
                          Mark received
                        </button>
                      ))}
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </section>

      {/* Dialogs */}
      <Dialog open={modal !== null} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto rounded-2xl border-line bg-surface text-ink sm:max-w-xl">
          {modal?.kind === 'add' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Add supplier</DialogTitle>
                <DialogDescription className="text-sub">
                  {isLive() ? 'Saved to the server.' : 'Saved on this page only until a backend is connected.'}
                </DialogDescription>
              </DialogHeader>
              <SupplierForm
                key={modal.key}
                takenNames={new Set(suppliers.map((s) => s.name.toLowerCase()))}
                onSubmit={addSupplier}
                onCancel={() => setModal(null)}
              />
            </>
          )}

          {modal && modal.kind !== 'add' && active && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <Avatar name={active.name} size="size-11" />
                  <div>
                    <DialogTitle className="text-[18px] font-extrabold">
                      {modal.kind === 'pay'
                        ? `Pay ${active.name}`
                        : modal.kind === 'order'
                          ? `New order · ${active.name}`
                          : active.name}
                    </DialogTitle>
                    <DialogDescription className="text-sub">
                      {modal.kind === 'order'
                        ? 'Pre-filled with low-stock items and quantities for 14 days of sales.'
                        : `${active.supplies} · last delivery ${active.lastDelivery ? fmtDate(active.lastDelivery) : '—'}`}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              {modal.kind === 'view' && (
                <SupplierDetail
                  s={active}
                  orders={orders.filter((o) => o.supplier === active.name)}
                  onPay={() => open({ kind: 'pay', id: active.id })}
                  onOrder={() => open({ kind: 'order', id: active.id })}
                />
              )}
              {modal.kind === 'pay' && (
                <PaymentForm
                  key={modal.key}
                  supplier={active}
                  onSubmit={(amount, method, ref) => recordPayment(active.id, amount, method, ref)}
                  onCancel={() => setModal(null)}
                />
              )}
              {modal.kind === 'order' && (
                <PurchaseOrderForm
                  key={modal.key}
                  supplier={active}
                  suggested={reorderLines(active)}
                  onSubmit={(lines) => placeOrder(active, lines)}
                  onCancel={() => setModal(null)}
                />
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      {liveNotice}
    </div>
  );
}
