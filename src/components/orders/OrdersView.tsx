'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PageHead, downloadCsv } from '@/components/AppShell';
import { Info, Panel, SmallButton, StatCard } from '@/components/suppliers/SuppliersView';
import { CancelForm, CompleteForm, DispatchForm, NewOrderForm, type NewOrderValues } from '@/components/orders/OrderForms';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useBusinessProfile } from '@/lib/business-profile';
import { apiConfigured, errorMessage } from '@/lib/api/client';
import { useNotice } from '@/components/live/Notice';
import { advanceOrder, loadCustomers, loadOrders, placeOrder as placeOrderLive, serverIdOf } from '@/lib/live/customers';
import { inr } from '@/lib/store-data';
import { TODAY, creditState, dialable, fmtDate, initialCustomers, type Customer } from '@/lib/customers-data';
import {
  boardStatuses,
  nowHHMM,
  initialOrders,
  isOpen,
  itemCount,
  nextStep,
  orderTotal,
  statusLabel,
  subtotal,
  toMin,
  urgencyOf,
  type CollectMethod,
  type Order,
  type OrderStatus,
  type Urgency,
} from '@/lib/orders-data';

/* ---------- config ---------- */

const statusPill: Record<OrderStatus, string> = {
  new: 'bg-blue/15 text-blue',
  packing: 'bg-amber/15 text-amber',
  ready: 'bg-vio/15 text-vio',
  dispatched: 'bg-sky/15 text-sky',
  completed: 'bg-teal/15 text-teal',
  cancelled: 'bg-bg text-mute',
};

const urgencyMeta: Record<Urgency, { label: string; text: string; rank: number }> = {
  late: { label: 'Late', text: 'text-coral', rank: 0 },
  soon: { label: 'Due now', text: 'text-amber', rank: 1 },
  later: { label: 'Later', text: 'text-sub', rank: 2 },
  done: { label: '', text: 'text-mute', rank: 3 },
};

const tabs = {
  all: { label: 'All', test: () => true },
  open: { label: 'Open', test: isOpen },
  completed: { label: 'Completed', test: (o: Order) => o.status === 'completed' },
  cancelled: { label: 'Cancelled', test: (o: Order) => o.status === 'cancelled' },
} as const;
type TabKey = keyof typeof tabs;

type Modal =
  | { kind: 'new'; key: number; customerId?: string | undefined }
  | { kind: 'view' | 'dispatch' | 'complete' | 'cancel'; id: string; key: number };

const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
const byUrgency = (a: Order, b: Order) =>
  urgencyMeta[urgencyOf(a)].rank - urgencyMeta[urgencyOf(b)].rank || toMin(a.slot.slice(0, 5)) - toMin(b.slot.slice(0, 5));

/** The customers orders refer to: the demo's, or (connected) the business's, loaded by the view. */
let customerPool: Customer[] = apiConfigured ? [] : initialCustomers;
const customerById = (id: string | null) => (id ? customerPool.find((c) => c.id === id) : undefined);

/** Orders on khata for a customer who is already over their limit need a decision before packing. */
const khataBlocked = (o: Order) => {
  const c = customerById(o.customerId);
  return o.payment === 'Khata' && isOpen(o) && !!c && creditState(c) === 'over-limit';
};

const paymentLabel = (o: Order) => {
  if (o.payment === 'Cash on delivery')
    return o.paid ? `Collected · ${o.collectedBy ?? 'Cash'}` : o.fulfilment === 'Delivery' ? 'Cash on delivery' : 'Pay at pickup';
  return o.payment === 'Khata' ? 'On khata' : 'Prepaid UPI';
};

const updateMessage = (o: Order, storeName: string) => {
  const total = inr(orderTotal(o));
  const msg: Partial<Record<OrderStatus, string>> = {
    new: `we've received your order ${o.id} (${total}). We'll have it ready for the ${o.slot} slot.`,
    packing: `your order ${o.id} is being packed now.`,
    ready:
      o.fulfilment === 'Pickup'
        ? `your order ${o.id} is ready to pick up. Amount: ${total}.`
        : `your order ${o.id} is packed and will leave shortly.`,
    dispatched: `your order ${o.id} is on the way with ${o.rider ?? 'our rider'}.${o.paid ? '' : ` Please keep ${total} ready.`}`,
    completed: `thank you! Your order ${o.id} is complete.`,
  };
  return `https://wa.me/${dialable(o.phone)}?text=${encodeURIComponent(
    `Hi ${o.customer}, ${msg[o.status] ?? `your order ${o.id} was cancelled.`} — ${storeName}`
  )}`;
};

function StatusPill({ status }: { status: OrderStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusPill[status]}`}>{statusLabel[status]}</span>
  );
}

/* ---------- board card ---------- */

function OrderCard({ o, onOpen, onAdvance }: { o: Order; onOpen: () => void; onAdvance: () => void }) {
  const urgency = urgencyOf(o);
  const step = nextStep(o);
  const blocked = khataBlocked(o);
  return (
    <li className={`rounded-xl border bg-surface p-3 ${urgency === 'late' ? 'border-coral/60' : 'border-line'}`}>
      <div className="flex items-start justify-between gap-2">
        <button onClick={onOpen} className="min-w-0 text-left">
          <div className="truncate font-bold text-ink hover:text-blue">{o.customer}</div>
          <div className="text-[11px] text-mute">
            {o.id} · {o.channel}
          </div>
        </button>
        <b className="tabular-nums text-ink">{inr(orderTotal(o))}</b>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span className={`font-semibold ${urgencyMeta[urgency].text}`}>
          {urgency === 'late' ? '⚠ Late · ' : ''}
          {o.fulfilment} {o.slot}
        </span>
        <span className="text-mute">
          {itemCount(o)} items · {paymentLabel(o)}
          {o.rider && ` · ${o.rider}`}
        </span>
      </div>
      {blocked && (
        <div className="mt-2 rounded-lg bg-coral/10 px-2 py-1 text-[11px] text-coral">Khata over limit — confirm payment</div>
      )}
      {o.bill && <div className="mt-2 text-[11px] font-semibold text-teal">Billed · {o.bill.invoiceNo}</div>}
      {step && (
        <button
          onClick={onAdvance}
          className={`mt-2.5 h-8 w-full rounded-lg text-[12px] font-semibold ${
            urgency === 'late' ? 'gco text-onbrand' : 'border border-line text-ink hover:border-blue'
          }`}
        >
          {step.label} →
        </button>
      )}
    </li>
  );
}

/* ---------- order detail ---------- */

function OrderDetail({
  o,
  onAdvance,
  onCancelOrder,
}: {
  o: Order;
  onAdvance: () => void;
  onCancelOrder: () => void;
}) {
  const storeName = useBusinessProfile().displayName;
  const step = nextStep(o);
  const customer = customerById(o.customerId);
  const sub = subtotal(o);
  return (
    <div className="space-y-5 text-[13px]">
      <div className="grid grid-cols-2 gap-3 rounded-xl bg-bg p-3 text-[12px] sm:grid-cols-3">
        <Info
          label="Customer"
          value={
            customer ? (
              <Link href={`/customers?id=${customer.id}`} className="text-blue">
                {o.customer}
              </Link>
            ) : (
              <>
                {o.customer} <span className="font-normal text-mute">(not saved)</span>
              </>
            )
          }
        />
        <Info
          label="Phone"
          value={
            <a href={`tel:+${dialable(o.phone)}`} className="text-blue">
              {o.phone}
            </a>
          }
        />
        <Info label="Received via" value={o.channel} />
        <Info label={o.fulfilment === 'Delivery' ? 'Deliver to' : 'Fulfilment'} value={o.address} />
        <Info label="Slot" value={`${o.slot} · ${fmtDate(TODAY)}`} />
        <Info label="Payment" value={o.bill ? `Billed · ${o.bill.invoiceNo}` : paymentLabel(o)} />
      </div>

      {apiConfigured && isOpen(o) && !o.bill && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-blue/30 bg-blue/5 px-3 py-2 text-[12px]">
          <span className="text-sub">
            Not billed yet. Billing it takes the stock out, issues the invoice and records the payment
            {o.payment === 'Cash on delivery' ? ' — bill it when the cash is collected' : ''}.
          </span>
          {serverIdOf(o.id) && (
            <Link href={`/pos?order=${serverIdOf(o.id)}`} className="rounded-lg gbv px-3 py-1.5 font-semibold text-onbrand">
              Bill at POS →
            </Link>
          )}
        </div>
      )}

      {khataBlocked(o) && customer && (
        <p className="rounded-xl bg-coral/10 px-3 py-2 text-[12px] text-coral">
          {customer.name} already owes {inr(customer.balance)} against a {inr(customer.creditLimit)} khata limit. Collect a
          payment from their{' '}
          <Link href={`/customers?id=${customer.id}`} className="font-semibold underline">
            customer profile
          </Link>{' '}
          or ask them to pay on delivery before packing.
        </p>
      )}
      {o.notes && <p className="rounded-xl bg-amber/10 px-3 py-2 text-[12px] text-ink">📝 {o.notes}</p>}

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
          {o.lines.map((l) => (
            <tr key={l.name} className="h-10 border-t border-line">
              <td className="!pl-0 text-ink">{l.name}</td>
              <td className="text-right tabular-nums">{l.qty}</td>
              <td className="text-right tabular-nums text-sub">{inr(l.price)}</td>
              <td className="!pr-0 text-right font-semibold tabular-nums text-ink">{inr(l.price * l.qty)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="text-sub">
          <tr className="border-t border-line">
            <td colSpan={3} className="!pl-0 pt-2">
              Subtotal
            </td>
            <td className="!pr-0 pt-2 text-right tabular-nums">{inr(sub)}</td>
          </tr>
          {o.fulfilment === 'Delivery' && (
            <tr>
              <td colSpan={3} className="!pl-0">
                Delivery
              </td>
              <td className="!pr-0 text-right tabular-nums">{o.deliveryFee ? inr(o.deliveryFee) : 'Free'}</td>
            </tr>
          )}
          <tr className="font-bold text-ink">
            <td colSpan={3} className="!pl-0">
              Total
            </td>
            <td className="!pr-0 text-right tabular-nums">{inr(orderTotal(o))}</td>
          </tr>
        </tfoot>
      </table>

      <section>
        <h3 className="mb-2 font-bold text-ink">Timeline</h3>
        <ol className="space-y-2 border-l border-line pl-4">
          {o.history.map((h, i) => (
            <li key={`${h.status}-${i}`} className="relative">
              <span
                className={`absolute -left-[21px] top-1 size-2.5 rounded-full ${
                  h.status === 'cancelled' ? 'bg-coral' : i === o.history.length - 1 ? 'bg-blue' : 'bg-line'
                }`}
                aria-hidden="true"
              />
              <span className="font-semibold text-ink">{statusLabel[h.status]}</span>{' '}
              <span className="text-[11px] text-mute">
                {h.time}
                {h.note ? ` · ${h.note}` : ''}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <div className="flex flex-wrap justify-end gap-2">
        {isOpen(o) && <SmallButton onClick={onCancelOrder}>Cancel order</SmallButton>}
        <a
          href={updateMessage(o, storeName)}
          target="_blank"
          rel="noopener noreferrer"
          className="grid h-8 place-items-center rounded-lg border border-line px-3 text-[12px] font-semibold text-ink hover:border-blue"
        >
          Send WhatsApp update
        </a>
        {step && (
          <SmallButton onClick={onAdvance} tone="brand">
            {step.label}
          </SmallButton>
        )}
      </div>
    </div>
  );
}

/* ---------- main view ---------- */

export function OrdersView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const linkedId = params.get('id');
  const newFor = params.get('new');

  const [orders, setOrders] = useState<Order[]>(initialOrders);
  const [customers, setCustomers] = useState<Customer[]>(customerPool);
  const [loading, setLoading] = useState(apiConfigured);
  const [notice, notify] = useNotice();
  const [nextId, setNextId] = useState(2060);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<TabKey>('all');
  // Deep links: /orders?id=ORD-2054 opens an order; /orders?new=<customerId> starts one for that customer.
  const [modal, setModal] = useState<Modal | null>(() => {
    if (linkedId && initialOrders.some((o) => o.id === linkedId)) return { kind: 'view', id: linkedId, key: 0 };
    if (newFor !== null) return { kind: 'new', key: 0, customerId: newFor || undefined };
    return null;
  });

  const open = (m: Omit<Extract<Modal, { id: string }>, 'key'>) => setModal({ ...m, key: Date.now() });
  const close = () => {
    setModal(null);
    if (linkedId || newFor !== null) router.replace(pathname, { scroll: false });
  };

  // Connected: the branch's open orders and today's closed ones, and the business's customers.
  useEffect(() => {
    if (!apiConfigured) return;
    let gone = false;
    void (async () => {
      try {
        const os = await loadOrders();
        const cs = await loadCustomers();
        if (gone) return;
        customerPool = cs;
        setCustomers(cs);
        setOrders(os);
        if (linkedId && os.some((o) => o.id === linkedId)) setModal({ kind: 'view', id: linkedId, key: Date.now() });
      } catch (e) {
        if (!gone) notify(errorMessage(e), true);
      } finally {
        if (!gone) setLoading(false);
      }
    })();
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Connected: the server's copy of an order replaces ours. */
  const put = (o: Order) => setOrders((prev) => (prev.some((x) => x.id === o.id) ? prev.map((x) => (x.id === o.id ? o : x)) : [o, ...prev]));
  const remote = async (fn: () => Promise<Order>, after?: (o: Order) => void) => {
    try {
      const o = await fn();
      put(o);
      after?.(o);
    } catch (e) {
      notify(errorMessage(e), true);
    }
  };
  const active = modal && modal.kind !== 'new' ? (orders.find((o) => o.id === modal.id) ?? null) : null;

  /* summary */
  const openOrders = orders.filter(isOpen);
  const late = openOrders.filter((o) => urgencyOf(o) === 'late');
  const codDue = openOrders.filter((o) => !o.paid);
  const completed = orders.filter((o) => o.status === 'completed');
  const cancelled = orders.filter((o) => o.status === 'cancelled');
  const byStatus = (s: OrderStatus) => openOrders.filter((o) => o.status === s);
  const busyRiders = new Set(orders.filter((o) => o.status === 'dispatched' && o.rider).map((o) => o.rider!));

  const counts = useMemo(
    () =>
      Object.fromEntries((Object.keys(tabs) as TabKey[]).map((k) => [k, orders.filter(tabs[k].test).length])) as Record<
        TabKey,
        number
      >,
    [orders]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return orders
      .filter(tabs[tab].test)
      .filter(
        (o) =>
          !q ||
          o.id.toLowerCase().includes(q) ||
          o.customer.toLowerCase().includes(q) ||
          o.address.toLowerCase().includes(q) ||
          (qDigits.length >= 3 && o.phone.replace(/\D/g, '').includes(qDigits))
      )
      .sort((a, b) => b.id.localeCompare(a.id));
  }, [orders, query, tab]);

  /* actions */
  const setStatus = (id: string, status: OrderStatus, patch: Partial<Order> = {}, note?: string) => {
    if (apiConfigured)
      return void remote(() =>
        advanceOrder(id, status, {
          ...(patch.rider ? { rider: patch.rider } : {}),
          ...(patch.collectedBy ? { collectedBy: patch.collectedBy } : {}),
          ...(status === 'cancelled' && note ? { note } : {}),
        })
      );
    return setOrders((prev) =>
      prev.map((o) =>
        o.id === id
          ? { ...o, ...patch, status, history: [...o.history, { status, time: nowHHMM(), ...(note ? { note } : {}) }] }
          : o
      )
    );
  };

  /** Moves an order one step on; steps that need input (rider, COD collection) open a dialog instead. */
  const advance = (o: Order) => {
    const step = nextStep(o);
    if (!step) return;
    if (step.to === 'dispatched') return open({ kind: 'dispatch', id: o.id });
    if (step.to === 'completed' && !o.paid) return open({ kind: 'complete', id: o.id });
    setStatus(o.id, step.to);
  };

  const placeOrder = (v: NewOrderValues) => {
    if (apiConfigured)
      return void remote(
        () => placeOrderLive(v),
        (o) => setModal({ kind: 'view', id: o.id, key: Date.now() })
      );
    const id = `ORD-${nextId}`;
    setOrders((prev) => [
      { ...v, id, status: 'new', rider: null, paid: v.payment !== 'Cash on delivery', history: [{ status: 'new', time: nowHHMM() }] },
      ...prev,
    ]);
    setNextId((n) => n + 1);
    setModal({ kind: 'view', id, key: Date.now() });
  };

  const dispatch = (id: string, rider: string) => {
    setStatus(id, 'dispatched', { rider }, `Rider: ${rider}`);
    setModal(null);
  };

  const complete = (o: Order, method: CollectMethod) => {
    setStatus(o.id, 'completed', { paid: true, collectedBy: method }, `Collected ${inr(orderTotal(o))} by ${method}`);
    setModal(null);
  };

  const cancel = (id: string, reason: string) => {
    setStatus(id, 'cancelled', {}, reason);
    setModal(null);
  };

  const exportCsv = () =>
    downloadCsv('orders.csv', [
      ['Order', 'Customer', 'Phone', 'Channel', 'Fulfilment', 'Slot', 'Address', 'Items', 'Subtotal', 'Delivery', 'Total', 'Payment', 'Paid', 'Status', 'Rider'],
      ...visible.map((o) => [
        o.id,
        o.customer,
        o.phone,
        o.channel,
        o.fulfilment,
        o.slot,
        o.address,
        itemCount(o),
        subtotal(o),
        o.deliveryFee,
        orderTotal(o),
        o.payment,
        o.paid ? 'Yes' : 'No',
        statusLabel[o.status],
        o.rider ?? '',
      ]),
    ]);

  return (
    <div className="space-y-4 p-5 lg:p-6">
      <PageHead
        title="Customer orders"
        sub={`Delivery & pickup orders · ${openOrders.length} open · ${fmtDate(TODAY)} ${TODAY.slice(0, 4)}, ${nowHHMM()}`}
      >
        <button onClick={exportCsv} className="h-10 rounded-xl card px-4 font-semibold">
          Export CSV
        </button>
        <button
          onClick={() => setModal({ kind: 'new', key: Date.now() })}
          className="flex h-10 items-center rounded-xl gbv px-5 font-semibold text-onbrand shadow-lg shadow-blue/25"
        >
          + New order
        </button>
      </PageHead>

      {loading && <p className="text-[13px] text-sub">Loading orders…</p>}

      {/* Summary */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Open orders"
          value={String(openOrders.length)}
          foot={`${byStatus('new').length + byStatus('packing').length} to pack · ${byStatus('ready').length} ready · ${byStatus('dispatched').length} out`}
          variant="brand"
        />
        <StatCard
          label="Running late"
          value={String(late.length)}
          foot={late.length ? late.map((o) => `${o.id} (${o.customer})`).join(', ') : 'Every order is on time'}
          {...(late.length ? { variant: 'alert' as const } : {})}
        />
        <StatCard
          label="Cash to collect"
          value={inr(sum(codDue, orderTotal))}
          foot={`${codDue.length} cash-on-delivery order${codDue.length === 1 ? '' : 's'} open`}
        />
        <StatCard
          label="Completed today"
          value={inr(sum(completed, orderTotal))}
          foot={`${completed.length} orders · ${cancelled.length} cancelled`}
        />
      </section>

      {/* Fulfilment board */}
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="Fulfilment board">
        {boardStatuses.map((s) => {
          const col = byStatus(s).sort(byUrgency);
          return (
            <div key={s} className="card p-3">
              <div className="mb-3 flex items-center justify-between px-1">
                <h2 className="flex items-center gap-2 text-[14px] font-bold text-ink">
                  {statusLabel[s]}
                  <span className={`rounded-full px-2 py-0.5 text-[11px] tabular-nums ${statusPill[s]}`}>{col.length}</span>
                </h2>
                {s === 'dispatched' && (
                  <span className="text-[11px] text-mute">
                    {busyRiders.size ? `${[...busyRiders].join(', ')} out` : 'Riders free'}
                  </span>
                )}
              </div>
              {col.length === 0 ? (
                <p className="rounded-xl bg-bg px-3 py-6 text-center text-[12px] text-mute">Nothing here</p>
              ) : (
                <ul className="space-y-2">
                  {col.map((o) => (
                    <OrderCard key={o.id} o={o} onOpen={() => open({ kind: 'view', id: o.id })} onAdvance={() => advance(o)} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </section>

      {/* All orders */}
      <Panel title="Today's orders" sub="Newest first">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search order #, customer, phone or address…"
            aria-label="Search orders"
            className="h-9 min-w-[200px] flex-1 rounded-xl border border-line bg-bg px-3 outline-none focus:border-blue"
          />
          <div className="flex rounded-lg bg-bg p-0.5" role="tablist" aria-label="Order status">
            {(Object.keys(tabs) as TabKey[]).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={`rounded-md px-3 py-1 text-[12px] ${tab === k ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-sub'}`}
              >
                {tabs[k].label} <span className="tabular-nums text-mute">{counts[k]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                <th className="pb-2 font-medium">Order</th>
                <th className="pb-2 font-medium">Customer</th>
                <th className="pb-2 font-medium">Fulfilment</th>
                <th className="pb-2 font-medium text-right">Items</th>
                <th className="pb-2 font-medium">Payment</th>
                <th className="pb-2 font-medium text-right">Total</th>
                <th className="pb-2 font-medium text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((o) => {
                const urgency = urgencyOf(o);
                return (
                  <tr
                    key={o.id}
                    onClick={() => open({ kind: 'view', id: o.id })}
                    className="h-12 cursor-pointer border-t border-line hover:bg-bg"
                  >
                    <td>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          open({ kind: 'view', id: o.id });
                        }}
                        className="font-semibold text-blue"
                      >
                        {o.id}
                      </button>
                      <div className="text-[11px] text-mute">
                        {o.history[0]?.time} · {o.channel}
                      </div>
                    </td>
                    <td className="text-ink">{o.customer}</td>
                    <td>
                      <span className={urgency === 'late' || urgency === 'soon' ? urgencyMeta[urgency].text : 'text-sub'}>
                        {o.fulfilment} · {o.slot}
                      </span>
                      {urgency === 'late' && <span className="ml-1 text-[11px] font-semibold text-coral">Late</span>}
                    </td>
                    <td className="text-right tabular-nums">{itemCount(o)}</td>
                    <td className="text-sub">{paymentLabel(o)}</td>
                    <td className="text-right font-semibold tabular-nums text-ink">{inr(orderTotal(o))}</td>
                    <td className="text-right">
                      <StatusPill status={o.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && (
          <div className="py-10 text-center text-sub">
            No orders match.{' '}
            <button
              className="font-semibold text-blue"
              onClick={() => {
                setQuery('');
                setTab('all');
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </Panel>

      {/* Dialogs */}
      <Dialog open={modal !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto rounded-2xl border-line bg-surface text-ink sm:max-w-xl">
          {modal?.kind === 'new' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">New order</DialogTitle>
                <DialogDescription className="text-sub">
                  For phone and WhatsApp orders.{apiConfigured ? ' Bill it at the POS when it’s delivered or picked up.' : ' Saved on this page only.'}
                </DialogDescription>
              </DialogHeader>
              <NewOrderForm
                key={modal.key}
                customers={customers}
                initialCustomerId={modal.customerId}
                onSubmit={placeOrder}
                onCancel={close}
              />
            </>
          )}

          {modal && modal.kind !== 'new' && active && (
            <>
              <DialogHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="text-[18px] font-extrabold">
                    {modal.kind === 'dispatch'
                      ? `Dispatch ${active.id}`
                      : modal.kind === 'complete'
                        ? `Complete ${active.id}`
                        : modal.kind === 'cancel'
                          ? `Cancel ${active.id}?`
                          : `${active.id} · ${active.customer}`}
                  </DialogTitle>
                  <StatusPill status={active.status} />
                </div>
                <DialogDescription className="text-sub">
                  {active.fulfilment} {active.slot} · {itemCount(active)} items · {inr(orderTotal(active))}
                </DialogDescription>
              </DialogHeader>

              {modal.kind === 'view' && (
                <OrderDetail
                  o={active}
                  onAdvance={() => advance(active)}
                  onCancelOrder={() => open({ kind: 'cancel', id: active.id })}
                />
              )}
              {modal.kind === 'dispatch' && (
                <DispatchForm
                  busy={busyRiders}
                  onSubmit={(rider) => dispatch(active.id, rider)}
                  onCancel={() => open({ kind: 'view', id: active.id })}
                />
              )}
              {modal.kind === 'complete' && (
                <CompleteForm
                  order={active}
                  total={orderTotal(active)}
                  onSubmit={(m) => complete(active, m)}
                  onCancel={() => open({ kind: 'view', id: active.id })}
                />
              )}
              {modal.kind === 'cancel' && (
                <CancelForm onSubmit={(r) => cancel(active.id, r)} onCancel={() => open({ kind: 'view', id: active.id })} />
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      {notice}
    </div>
  );
}
