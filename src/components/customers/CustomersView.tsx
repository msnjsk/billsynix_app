'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PageHead, downloadCsv } from '@/components/AppShell';
import { Avatar, Info, Panel, SmallButton, StatCard } from '@/components/suppliers/SuppliersView';
import {
  CollectPaymentForm,
  CreditSaleForm,
  CustomerForm,
  type CustomerFormValues,
} from '@/components/customers/CustomerForms';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { inr } from '@/lib/store-data';
import type { PayMethod } from '@/lib/sales-data';
import { ordersForCustomer, orderTotal, statusLabel, type Order } from '@/lib/orders-data';
import { apiConfigured, errorMessage } from '@/lib/api/client';
import { useNotice } from '@/components/live/Notice';
import { createCustomer, loadCustomers, loadLedger, loadOrders, receivePayment, updateCustomer } from '@/lib/live/customers';
import { useBusinessProfile } from '@/lib/business-profile';
import {
  LAPSED_AFTER_DAYS,
  POINTS_PER_RUPEE,
  POINT_VALUE,
  TODAY,
  billsByCustomer,
  creditLabel,
  creditState,
  daysSinceVisit,
  dialable,
  fmtDate,
  initialCustomers,
  isLapsed,
  lastVisitLabel,
  slug,
  tierOf,
  type CreditState,
  type Customer,
  type Tier,
} from '@/lib/customers-data';

/* ---------- config ---------- */

const creditMeta: Record<CreditState, { label: string; pill: string; text: string }> = {
  'over-limit': { label: 'Over limit', pill: 'bg-coral text-onbrand', text: 'text-coral' },
  overdue: { label: 'Overdue', pill: 'bg-coral/15 text-coral', text: 'text-coral' },
  ok: { label: 'On khata', pill: 'bg-amber/15 text-amber', text: 'text-amber' },
  none: { label: 'No dues', pill: 'bg-teal/15 text-teal', text: 'text-teal' },
};

const tierPill: Record<Tier, string> = {
  Gold: 'bg-amber/15 text-amber',
  Silver: 'bg-sky/15 text-sky',
  Regular: 'bg-bg text-sub',
};

const segments = {
  all: { label: 'All', test: () => true },
  khata: { label: 'On khata', test: (c: Customer) => c.balance > 0 },
  overdue: { label: 'Overdue', test: (c: Customer) => ['overdue', 'over-limit'].includes(creditState(c)) },
  gold: { label: 'Gold', test: (c: Customer) => tierOf(c) === 'Gold' },
  lapsed: { label: 'Lapsed', test: isLapsed },
} as const;
type SegmentKey = keyof typeof segments;

const sorts = {
  value: { label: 'Top spenders', fn: (a: Customer, b: Customer) => b.spend90 - a.spend90 },
  balance: { label: 'Khata balance', fn: (a: Customer, b: Customer) => b.balance - a.balance },
  recent: { label: 'Recent visit', fn: (a: Customer, b: Customer) => daysSinceVisit(a) - daysSinceVisit(b) },
  name: { label: 'Name A–Z', fn: (a: Customer, b: Customer) => a.name.localeCompare(b.name) },
} as const;
type SortKey = keyof typeof sorts;

type Modal =
  | { kind: 'add'; key: number }
  | { kind: 'view' | 'edit' | 'collect' | 'credit'; id: string; key: number };

const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

const reminderLink = (c: Customer, storeName: string) =>
  `https://wa.me/${dialable(c.phone)}?text=${encodeURIComponent(
    `Hi ${c.name}, a gentle reminder from ${storeName}: your khata balance is ${inr(c.balance)}. ` +
      'You can pay by UPI or at the counter. Thank you!'
  )}`;

/* ---------- customer detail ---------- */

function CustomerDetail({
  c,
  orders,
  onEdit,
  onCollect,
  onCredit,
}: {
  c: Customer;
  orders: Order[];
  onEdit: () => void;
  onCollect: () => void;
  onCredit: () => void;
}) {
  const storeName = useBusinessProfile().displayName;
  const state = creditState(c);
  const tier = tierOf(c);
  const bills = apiConfigured ? [] : (billsByCustomer[c.name] ?? []);
  const usedPct = c.creditLimit > 0 ? Math.min(100, Math.round((c.balance / c.creditLimit) * 100)) : 0;

  return (
    <div className="space-y-5 text-[13px]">
      <div className="grid grid-cols-2 gap-3 rounded-xl bg-bg p-3 text-[12px] sm:grid-cols-3">
        <Info
          label="Phone"
          value={
            <a href={`tel:+${dialable(c.phone)}`} className="text-blue">
              {c.phone}
            </a>
          }
        />
        <Info
          label="Email"
          value={
            c.email ? (
              <a href={`mailto:${c.email}`} className="break-all text-blue">
                {c.email}
              </a>
            ) : (
              '—'
            )
          }
        />
        <Info label="Area" value={c.area || '—'} />
        <Info label="Customer since" value={`${fmtDate(c.since)} ${c.since.slice(0, 4)}`} />
        <Info label="Visits (90 days)" value={String(c.visits90)} />
        <Info label="Avg bill" value={c.visits90 ? inr(Math.round(c.spend90 / c.visits90)) : '—'} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line p-3">
          <div className="flex items-center justify-between">
            <span className="text-sub">Loyalty</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tierPill[tier]}`}>{tier}</span>
          </div>
          {apiConfigured ? (
            <>
              <div className="mt-1 text-[20px] font-extrabold tabular-nums text-ink">{inr(c.spend90)}</div>
              <div className="text-[12px] text-sub">spent in 90 days · loyalty points aren&apos;t tracked yet</div>
            </>
          ) : (
            <>
              <div className="mt-1 text-[20px] font-extrabold tabular-nums text-ink">
                {c.points.toLocaleString('en-IN')} pts
              </div>
              <div className="text-[12px] text-sub">
                Worth {inr(Math.floor(c.points * POINT_VALUE))} · {inr(c.spend90)} spent in 90 days
              </div>
            </>
          )}
        </div>

        <div className="rounded-xl border border-line p-3">
          <div className="flex items-center justify-between">
            <span className="text-sub">Khata</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${creditMeta[state].pill}`}>
              {creditMeta[state].label}
            </span>
          </div>
          <div className="mt-1 text-[20px] font-extrabold tabular-nums text-ink">{inr(c.balance)}</div>
          {c.creditLimit > 0 ? (
            <>
              <div
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg"
                role="progressbar"
                aria-label="Credit limit used"
                aria-valuenow={usedPct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`h-full rounded-full ${usedPct >= 100 ? 'bg-coral' : usedPct >= 75 ? 'bg-amber' : 'bg-teal'}`}
                  style={{ width: `${usedPct}%` }}
                />
              </div>
              <div className={`mt-1 text-[12px] ${creditMeta[state].text}`}>
                {creditLabel(c)} · limit {inr(c.creditLimit)}
              </div>
            </>
          ) : (
            <div className="text-[12px] text-sub">Cash only. Set a limit to allow khata.</div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <SmallButton onClick={onEdit}>Edit details</SmallButton>
        <Link
          href={`/orders?new=${c.id}`}
          className="grid h-8 place-items-center rounded-lg border border-line px-3 text-[12px] font-semibold text-ink hover:border-blue"
        >
          New order
        </Link>
        {c.creditLimit > 0 && !apiConfigured && <SmallButton onClick={onCredit}>Add credit sale</SmallButton>}
        {c.balance > 0 && (
          <>
            <a
              href={reminderLink(c, storeName)}
              target="_blank"
              rel="noopener noreferrer"
              className="grid h-8 place-items-center rounded-lg border border-line px-3 text-[12px] font-semibold text-ink hover:border-blue"
            >
              Send reminder
            </a>
            <SmallButton onClick={onCollect} tone="brand">
              Collect payment
            </SmallButton>
          </>
        )}
      </div>

      {apiConfigured && c.creditLimit > 0 && (
        <p className="text-[12px] text-sub">
          Credit sales are bills: they&apos;re recorded when this customer buys on khata, with a tax invoice, and show up here.
        </p>
      )}
      {c.notes && <p className="rounded-xl bg-amber/10 px-3 py-2 text-[12px] text-ink">📝 {c.notes}</p>}

      <section className={`grid gap-4 ${apiConfigured ? '' : 'sm:grid-cols-2'}`}>
        <div className={apiConfigured ? 'hidden' : ''}>
          <h3 className="mb-2 font-bold text-ink">Today&apos;s bills ({bills.length})</h3>
          {bills.length === 0 ? (
            <p className="text-sub">No bills today.</p>
          ) : (
            <ul className="space-y-2">
              {bills.map((b) => (
                <li key={b.id} className="flex justify-between gap-2">
                  <span>
                    <span className="text-ink">#{b.id}</span>{' '}
                    <span className="text-[11px] text-mute">
                      {b.time} · {b.method}
                      {b.status === 'Refunded' && ' · Refunded'}
                    </span>
                  </span>
                  <b className={`tabular-nums ${b.status === 'Refunded' ? 'text-mute line-through' : 'text-ink'}`}>
                    {inr(b.total)}
                  </b>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-2 font-bold text-ink">Khata history</h3>
          {c.ledger.length === 0 ? (
            <p className="text-sub">No khata entries.</p>
          ) : (
            <ul className="space-y-2">
              {c.ledger.map((e, i) => (
                <li key={`${e.date}-${i}`} className="flex justify-between gap-2">
                  <span>
                    <span className="text-ink">{fmtDate(e.date)}</span>{' '}
                    <span className="text-[11px] text-mute">
                      {e.kind === 'credit' ? 'Credit' : e.method ? `Paid · ${e.method}` : 'Paid'}
                      {e.ref ? ` · ${e.ref}` : ''}
                    </span>
                  </span>
                  <b className={`tabular-nums ${e.kind === 'credit' ? 'text-coral' : 'text-teal'}`}>
                    {e.kind === 'credit' ? '+' : '−'}
                    {inr(e.amount)}
                  </b>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {orders.length > 0 && (
        <section>
          <h3 className="mb-2 font-bold text-ink">Delivery &amp; pickup orders ({orders.length})</h3>
          <ul className="space-y-2">
            {orders.map((o) => (
              <li key={o.id} className="flex justify-between gap-2">
                <span>
                  <Link href={`/orders?id=${o.id}`} className="text-blue">
                    {o.id}
                  </Link>{' '}
                  <span className="text-[11px] text-mute">
                    {o.fulfilment} {o.slot} · {statusLabel[o.status]}
                  </span>
                </span>
                <b className={`tabular-nums ${o.status === 'cancelled' ? 'text-mute line-through' : 'text-ink'}`}>
                  {inr(orderTotal(o))}
                </b>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/* ---------- main view ---------- */

export function CustomersView() {
  const storeName = useBusinessProfile().displayName;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const linkedId = params.get('id');

  const [customers, setCustomers] = useState<Customer[]>(apiConfigured ? [] : initialCustomers);
  const [loading, setLoading] = useState(apiConfigured);
  const [detailOrders, setDetailOrders] = useState<Record<string, Order[]>>({});
  const [notice, notify] = useNotice();
  const [query, setQuery] = useState('');
  const [segment, setSegment] = useState<SegmentKey>('all');
  const [sort, setSort] = useState<SortKey>('value');
  // Deep link from other pages, e.g. /customers?id=lakshmi-r from a bill on the Sales page.
  const [modal, setModal] = useState<Modal | null>(() =>
    linkedId && initialCustomers.some((c) => c.id === linkedId) ? { kind: 'view', id: linkedId, key: 0 } : null
  );

  const open = (m: Omit<Extract<Modal, { id: string }>, 'key'>) => setModal({ ...m, key: Date.now() });
  const close = () => {
    setModal(null);
    if (linkedId) router.replace(pathname, { scroll: false });
  };
  const active = modal && modal.kind !== 'add' ? (customers.find((c) => c.id === modal.id) ?? null) : null;

  // Connected: the business's customers from the server.
  const reload = async () => {
    try {
      const cs = await loadCustomers();
      // Statements already loaded stay until the card is opened again.
      setCustomers((prev) => cs.map((c) => ({ ...c, ledger: prev.find((p) => p.id === c.id)?.ledger ?? [] })));
      return cs;
    } catch (e) {
      notify(errorMessage(e), true);
      return null;
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (!apiConfigured) return;
    void reload().then((cs) => {
      if (linkedId && cs?.some((c) => c.id === linkedId)) setModal({ kind: 'view', id: linkedId, key: Date.now() });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Connected: a customer's statement and orders, when their card is opened.
  const viewing = modal?.kind === 'view' ? modal.id : null;
  useEffect(() => {
    if (!apiConfigured || !viewing) return;
    void (async () => {
      try {
        const ledger = await loadLedger(viewing);
        const orders = await loadOrders(viewing);
        setCustomers((prev) => prev.map((c) => (c.id === viewing ? { ...c, ledger } : c)));
        setDetailOrders((prev) => ({ ...prev, [viewing]: orders }));
      } catch (e) {
        notify(errorMessage(e), true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewing, modal?.key]);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(segments) as SegmentKey[]).map((k) => [k, customers.filter(segments[k].test).length])
      ) as Record<SegmentKey, number>,
    [customers]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return customers
      .filter(segments[segment].test)
      .filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.area.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          (qDigits.length >= 3 && c.phone.replace(/\D/g, '').includes(qDigits))
      )
      .sort(sorts[sort].fn);
  }, [customers, query, segment, sort]);

  /* summary */
  const onKhata = customers.filter((c) => c.balance > 0);
  const khataTotal = sum(onKhata, (c) => c.balance);
  const overdue = customers.filter((c) => ['overdue', 'over-limit'].includes(creditState(c)));
  const overdueAmt = sum(overdue, (c) => c.balance);
  const active7 = customers.filter((c) => daysSinceVisit(c) <= 7).length;
  const spend90 = sum(customers, (c) => c.spend90);
  const lapsed = customers.filter(isLapsed).sort((a, b) => b.spend90 - a.spend90);
  const todayNamed = Object.entries(apiConfigured ? {} : billsByCustomer)
    .map(([name, bills]) => ({
      name,
      id: slug(name),
      bills: bills.length,
      total: sum(bills.filter((b) => b.status === 'Paid'), (b) => b.total),
    }))
    .sort((a, b) => b.total - a.total);

  const rank: Record<CreditState, number> = { 'over-limit': 0, overdue: 1, ok: 2, none: 3 };
  const dues = [...onKhata].sort((a, b) => rank[creditState(a)] - rank[creditState(b)] || b.balance - a.balance);

  /* actions */
  const update = (id: string, fn: (c: Customer) => Customer) =>
    setCustomers((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));

  const addCustomer = (v: CustomerFormValues) => {
    if (apiConfigured) {
      void createCustomer(v)
        .then((c) => {
          setCustomers((prev) => [...prev, c]);
          notify(`${c.name} added`);
          setModal({ kind: 'view', id: c.id, key: Date.now() });
        })
        .catch((e: unknown) => notify(errorMessage(e), true));
      return;
    }
    const base = slug(v.name);
    const id = customers.some((c) => c.id === base) ? `${base}-${Date.now()}` : base;
    setCustomers((prev) => [
      ...prev,
      {
        id,
        ...v,
        since: TODAY,
        visits90: 0,
        spend90: 0,
        lastVisit: null,
        points: 0,
        balance: 0,
        balanceSince: null,
        ledger: [],
      },
    ]);
    setModal({ kind: 'view', id, key: Date.now() });
  };

  const editCustomer = (id: string, v: CustomerFormValues) => {
    if (apiConfigured) {
      void updateCustomer(id, v)
        .then(async () => {
          await reload();
          notify(`${v.name} updated`);
          setModal({ kind: 'view', id, key: Date.now() });
        })
        .catch((e: unknown) => notify(errorMessage(e), true));
      return;
    }
    update(id, (c) => ({ ...c, ...v }));
    setModal({ kind: 'view', id, key: Date.now() });
  };

  const collect = (id: string, amount: number, method: PayMethod, ref: string) => {
    if (apiConfigured) {
      void receivePayment(id, amount, method, ref)
        .then(async (r) => {
          await reload();
          notify(`Received ${inr(amount)} · ${r.number}${method === 'Cash' ? ' (into your open drawer, if any)' : ''}`);
          setModal({ kind: 'view', id, key: Date.now() });
        })
        .catch((e: unknown) => notify(errorMessage(e), true));
      return;
    }
    update(id, (c) => {
      const balance = Math.max(0, Math.round((c.balance - amount) * 100) / 100);
      return {
        ...c,
        balance,
        balanceSince: balance > 0 ? c.balanceSince : null,
        ledger: [{ date: TODAY, kind: 'payment', amount, method, ref }, ...c.ledger],
      };
    });
    setModal({ kind: 'view', id, key: Date.now() });
  };

  /** A credit sale is a visit: it adds to spend and earns loyalty points like any bill. */
  const addCredit = (id: string, amount: number, ref: string) => {
    update(id, (c) => ({
      ...c,
      balance: Math.round((c.balance + amount) * 100) / 100,
      balanceSince: c.balanceSince ?? TODAY,
      lastVisit: TODAY,
      visits90: c.visits90 + 1,
      spend90: c.spend90 + amount,
      points: c.points + Math.floor(amount * POINTS_PER_RUPEE),
      ledger: [{ date: TODAY, kind: 'credit', amount, ref }, ...c.ledger],
    }));
    setModal({ kind: 'view', id, key: Date.now() });
  };

  const exportCsv = () =>
    downloadCsv('customers.csv', [
      ['Name', 'Phone', 'Email', 'Area', 'Since', 'Tier', 'Points', 'Visits (90d)', 'Spend (90d)', 'Last visit', 'Credit limit', 'Khata balance', 'Khata status'],
      ...visible.map((c) => [
        c.name,
        c.phone,
        c.email,
        c.area,
        c.since,
        tierOf(c),
        c.points,
        c.visits90,
        c.spend90,
        c.lastVisit ?? '',
        c.creditLimit,
        c.balance,
        creditMeta[creditState(c)].label,
      ]),
    ]);

  return (
    <div className="space-y-4 p-5 lg:p-6">
      <PageHead
        title="Customers"
        sub={loading ? 'Loading customers…' : `${customers.length} customers · ${inr(khataTotal)} on khata · as of ${fmtDate(TODAY)} ${TODAY.slice(0, 4)}`}
      >
        <button onClick={exportCsv} className="h-10 rounded-xl card px-4 font-semibold">
          Export CSV
        </button>
        <button
          onClick={() => setModal({ kind: 'add', key: Date.now() })}
          className="flex h-10 items-center rounded-xl gbv px-5 font-semibold text-onbrand shadow-lg shadow-blue/25"
        >
          + Add customer
        </button>
      </PageHead>

      {/* Summary */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Khata outstanding"
          value={inr(khataTotal)}
          foot={`Owed by ${onKhata.length} of ${customers.length} customers`}
          variant="brand"
        />
        <StatCard
          label="Overdue khata"
          value={inr(overdueAmt)}
          foot={overdue.length ? overdue.map((c) => c.name).join(', ') : 'Nothing overdue'}
          {...(overdue.length ? { variant: 'alert' as const } : {})}
        />
        <StatCard
          label="Active this week"
          value={`${active7} / ${customers.length}`}
          foot={`${lapsed.length} lapsed (no visit in ${LAPSED_AFTER_DAYS}+ days)`}
        />
        <StatCard
          label="Spend, last 90 days"
          value={inr(spend90)}
          foot={`Avg ${inr(Math.round(spend90 / Math.max(1, customers.length)))} per customer`}
        />
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        {/* Customer list */}
        <Panel
          title="All customers"
          sub={sorts[sort].label}
          className="lg:col-span-2"
          action={
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort customers"
              className="h-8 rounded-lg border border-line bg-surface px-2 text-[12px]"
            >
              {(Object.keys(sorts) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {sorts[k].label}
                </option>
              ))}
            </select>
          }
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, phone, area or email…"
              aria-label="Search customers"
              className="h-9 min-w-[200px] flex-1 rounded-xl border border-line bg-bg px-3 outline-none focus:border-blue"
            />
            <div className="flex flex-wrap rounded-lg bg-bg p-0.5" role="tablist" aria-label="Customer segment">
              {(Object.keys(segments) as SegmentKey[]).map((k) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={segment === k}
                  onClick={() => setSegment(k)}
                  className={`rounded-md px-3 py-1 text-[12px] ${
                    segment === k ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-sub'
                  }`}
                >
                  {segments[k].label} <span className="tabular-nums text-mute">{counts[k]}</span>
                </button>
              ))}
            </div>
          </div>

          <ul className="divide-y divide-line">
            {visible.map((c) => {
              const state = creditState(c);
              const tier = tierOf(c);
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-4 py-4">
                  <Avatar name={c.name} />
                  <div className="min-w-[200px] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button onClick={() => open({ kind: 'view', id: c.id })} className="font-bold text-ink hover:text-blue">
                        {c.name}
                      </button>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tierPill[tier]}`}>{tier}</span>
                      {isLapsed(c) && (
                        <span className="rounded-full bg-bg px-2 py-0.5 text-[10px] font-semibold text-mute">Lapsed</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[12px] text-sub">
                      <a href={`tel:+${dialable(c.phone)}`} className="hover:text-blue">
                        {c.phone}
                      </a>
                      {c.area && ` · ${c.area}`}
                    </div>
                    <div className="mt-0.5 text-[11px] text-mute">
                      {lastVisitLabel(c)} · {c.visits90} visits · {inr(c.spend90)} in 90 days ·{' '}
                      {c.points.toLocaleString('en-IN')} pts
                    </div>
                  </div>
                  <div className="min-w-[120px] text-right">
                    <div className="text-[16px] font-extrabold tabular-nums text-ink">{inr(c.balance)}</div>
                    <div className={`text-[11px] font-semibold ${creditMeta[state].text}`}>
                      {c.creditLimit > 0 || c.balance > 0 ? creditLabel(c) : 'Cash only'}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <SmallButton onClick={() => open({ kind: 'view', id: c.id })}>View</SmallButton>
                    {c.balance > 0 && (
                      <SmallButton onClick={() => open({ kind: 'collect', id: c.id })} tone="brand">
                        Collect
                      </SmallButton>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {visible.length === 0 && (
            <div className="py-10 text-center text-sub">
              No customers match.{' '}
              <button
                className="font-semibold text-blue"
                onClick={() => {
                  setQuery('');
                  setSegment('all');
                }}
              >
                Clear filters
              </button>
            </div>
          )}
        </Panel>

        {/* Side panels */}
        <div className="space-y-3">
          <Panel title="Collect dues" sub="Over limit and overdue first">
            {dues.length === 0 ? (
              <p className="text-sub">No one owes anything. 🎉</p>
            ) : (
              <ul className="space-y-3">
                {dues.map((c) => {
                  const state = creditState(c);
                  return (
                    <li key={c.id} className="flex items-center gap-3">
                      <Avatar name={c.name} size="size-9" />
                      <div className="min-w-0 flex-1">
                        <button
                          onClick={() => open({ kind: 'view', id: c.id })}
                          className="block truncate font-semibold text-ink hover:text-blue"
                        >
                          {c.name}
                        </button>
                        <div className={`text-[11px] ${creditMeta[state].text}`}>{creditLabel(c)}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold tabular-nums text-ink">{inr(c.balance)}</div>
                        <div className="flex justify-end gap-2 text-[11px] font-semibold">
                          <a href={reminderLink(c, storeName)} target="_blank" rel="noopener noreferrer" className="text-sub hover:text-blue">
                            Remind
                          </a>
                          <button onClick={() => open({ kind: 'collect', id: c.id })} className="text-blue">
                            Collect
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title="At the counter today" sub="Named customers on today's bills" className={apiConfigured ? 'hidden' : ''}>
            {todayNamed.length === 0 ? (
              <p className="text-sub">No named customers yet today.</p>
            ) : (
              <ul className="space-y-2">
                {todayNamed.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2">
                    <button onClick={() => open({ kind: 'view', id: t.id })} className="truncate text-ink hover:text-blue">
                      {t.name} <span className="text-[11px] text-mute">· {t.bills} bill{t.bills === 1 ? '' : 's'}</span>
                    </button>
                    <b className="tabular-nums text-ink">{inr(t.total)}</b>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Win back" sub={`No visit in ${LAPSED_AFTER_DAYS}+ days`}>
            {lapsed.length === 0 ? (
              <p className="text-sub">Every customer has visited recently.</p>
            ) : (
              <ul className="space-y-2">
                {lapsed.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <button
                        onClick={() => open({ kind: 'view', id: c.id })}
                        className="block truncate text-ink hover:text-blue"
                      >
                        {c.name}
                      </button>
                      <div className="text-[11px] text-mute">{lastVisitLabel(c)}</div>
                    </div>
                    <a href={`tel:+${dialable(c.phone)}`} className="text-[11px] font-semibold text-blue">
                      Call
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </section>

      {/* Dialogs */}
      <Dialog open={modal !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto rounded-2xl border-line bg-surface text-ink sm:max-w-xl">
          {modal?.kind === 'add' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Add customer</DialogTitle>
                <DialogDescription className="text-sub">
                  {apiConfigured ? 'Saved for the whole business.' : 'Saved on this page only.'}
                </DialogDescription>
              </DialogHeader>
              <CustomerForm key={modal.key} existing={customers} onSubmit={addCustomer} onCancel={close} />
            </>
          )}

          {modal && modal.kind !== 'add' && active && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <Avatar name={active.name} size="size-11" />
                  <div>
                    <DialogTitle className="text-[18px] font-extrabold">
                      {modal.kind === 'collect'
                        ? `Collect from ${active.name}`
                        : modal.kind === 'credit'
                          ? `Credit sale · ${active.name}`
                          : modal.kind === 'edit'
                            ? `Edit ${active.name}`
                            : active.name}
                    </DialogTitle>
                    <DialogDescription className="text-sub">
                      {tierOf(active)} customer · {lastVisitLabel(active)}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              {modal.kind === 'view' && (
                <CustomerDetail
                  c={active}
                  orders={apiConfigured ? (detailOrders[active.id] ?? []) : ordersForCustomer(active.id)}
                  onEdit={() => open({ kind: 'edit', id: active.id })}
                  onCollect={() => open({ kind: 'collect', id: active.id })}
                  onCredit={() => open({ kind: 'credit', id: active.id })}
                />
              )}
              {modal.kind === 'edit' && (
                <CustomerForm
                  key={modal.key}
                  initial={active}
                  existing={customers}
                  onSubmit={(v) => editCustomer(active.id, v)}
                  onCancel={() => open({ kind: 'view', id: active.id })}
                />
              )}
              {modal.kind === 'collect' && (
                <CollectPaymentForm
                  key={modal.key}
                  customer={active}
                  onSubmit={(amount, method, ref) => collect(active.id, amount, method, ref)}
                  onCancel={() => open({ kind: 'view', id: active.id })}
                />
              )}
              {modal.kind === 'credit' && (
                <CreditSaleForm
                  key={modal.key}
                  customer={active}
                  onSubmit={(amount, ref) => addCredit(active.id, amount, ref)}
                  onCancel={() => open({ kind: 'view', id: active.id })}
                />
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      {notice}
    </div>
  );
}
