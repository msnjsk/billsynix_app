'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Actions, Field, borderCls, fieldCls } from '@/components/suppliers/SupplierForms';
import { inr } from '@/lib/store-data';
import { inventoryItems, statusOf } from '@/lib/inventory-data';
import { creditState, type Customer } from '@/lib/customers-data';
import {
  channels,
  deliveryFeeFor,
  FREE_DELIVERY_FROM,
  openSlots,
  orderPayments,
  riders,
  type Channel,
  type CollectMethod,
  type Fulfilment,
  type Order,
  type OrderLine,
  type OrderPayment,
} from '@/lib/orders-data';

const PHONE = /^(\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}$/;
const NEW_CUSTOMER = '__new__';

export type NewOrderValues = Omit<Order, 'id' | 'status' | 'rider' | 'history' | 'paid' | 'collectedBy'>;

/* ---------- new order ---------- */

export function NewOrderForm({
  customers,
  initialCustomerId,
  onSubmit,
  onCancel,
}: {
  customers: Customer[];
  /** Pre-select a customer, e.g. when starting an order from their profile. */
  initialCustomerId?: string | undefined;
  onSubmit: (v: NewOrderValues) => void;
  onCancel: () => void;
}) {
  const slots = openSlots();
  const first = customers.find((c) => c.id === initialCustomerId) ?? customers[0];
  const [customerId, setCustomerId] = useState(first?.id ?? NEW_CUSTOMER);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [channel, setChannel] = useState<Channel>('WhatsApp');
  const [fulfilment, setFulfilment] = useState<Fulfilment>('Delivery');
  const [address, setAddress] = useState(first?.area ?? '');
  const [slot, setSlot] = useState(slots[1] ?? slots[0] ?? '');
  const [payment, setPayment] = useState<OrderPayment>('Cash on delivery');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<(OrderLine & { qtyText: string })[]>([]);
  const [pick, setPick] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const customer = customers.find((c) => c.id === customerId) ?? null;
  const parsed = lines.map((l) => ({ ...l, qty: Number(l.qtyText) }));
  const badQty = parsed.some((l) => !Number.isInteger(l.qty) || l.qty <= 0);
  const sub = parsed.reduce((s, l) => s + (Number.isFinite(l.qty) && l.qty > 0 ? l.qty * l.price : 0), 0);
  const fee = deliveryFeeFor(fulfilment, sub);
  const total = sub + fee;

  const stockOf = (name: string) => inventoryItems.find((i) => i.name === name)?.stock ?? 0;
  const shortLines = parsed.filter((l) => l.qty > stockOf(l.name));

  const khataProblem = useMemo(() => {
    if (payment !== 'Khata') return null;
    if (!customer) return 'Khata is only for saved customers.';
    if (customer.creditLimit <= 0) return `${customer.name} is cash only — no khata limit set.`;
    if (creditState(customer) === 'over-limit')
      return `${customer.name} is already over their ${inr(customer.creditLimit)} khata limit.`;
    if (customer.balance + total > customer.creditLimit)
      return `This takes ${customer.name}'s khata to ${inr(customer.balance + total)}, above the ${inr(customer.creditLimit)} limit.`;
    return null;
  }, [payment, customer, total]);

  const errors = {
    name: !customer && newName.trim().length < 2 ? 'Enter the customer name' : undefined,
    phone: !customer && !PHONE.test(newPhone.trim()) ? 'Enter a 10-digit Indian mobile number' : undefined,
    address: fulfilment === 'Delivery' && address.trim().length < 5 ? 'Enter the delivery address' : undefined,
    slot: !slot ? 'No slots left today' : undefined,
    lines: lines.length === 0 ? 'Add at least one item' : badQty ? 'Quantities must be whole numbers above 0' : undefined,
  };
  const invalid = Object.values(errors).some(Boolean) || !!khataProblem;
  const show = (e?: string) => (submitted ? e : undefined);

  const chooseCustomer = (id: string) => {
    setCustomerId(id);
    const c = customers.find((x) => x.id === id);
    if (c && fulfilment === 'Delivery') setAddress(c.area);
    if (!c && payment === 'Khata') setPayment('Cash on delivery');
  };

  const addLine = (name: string) => {
    const item = inventoryItems.find((i) => i.name === name);
    if (!item) return;
    setLines((prev) =>
      prev.some((l) => l.name === name)
        ? prev.map((l) => (l.name === name ? { ...l, qtyText: String(Number(l.qtyText || 0) + 1) } : l))
        : [...prev, { name, price: item.price, qty: 1, qtyText: '1' }]
    );
    setPick('');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (invalid) return;
    onSubmit({
      customerId: customer?.id ?? null,
      customer: customer?.name ?? newName.trim(),
      phone: customer?.phone ?? newPhone.trim(),
      address: fulfilment === 'Pickup' ? 'Store pickup' : address.trim(),
      channel,
      fulfilment,
      slot,
      lines: parsed.map(({ name, price, qty }) => ({ name, price, qty })),
      deliveryFee: fee,
      payment,
      notes: notes.trim(),
    });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4 text-[13px]">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Customer">
          <select value={customerId} onChange={(e) => chooseCustomer(e.target.value)} className={`${fieldCls} border-line`}>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.phone}
              </option>
            ))}
            <option value={NEW_CUSTOMER}>+ Someone new</option>
          </select>
        </Field>
        <Field label="Received via">
          <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className={`${fieldCls} border-line`}>
            {channels.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
      </div>

      {!customer && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" error={show(errors.name)}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} className={`${fieldCls} ${borderCls(!!show(errors.name))}`} />
          </Field>
          <Field label="Phone" error={show(errors.phone)}>
            <input
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              inputMode="tel"
              placeholder="+91 98400 12345"
              className={`${fieldCls} ${borderCls(!!show(errors.phone))}`}
            />
          </Field>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Fulfilment">
          <div className="flex h-10 rounded-xl bg-bg p-1" role="radiogroup" aria-label="Fulfilment">
            {(['Delivery', 'Pickup'] as Fulfilment[]).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={fulfilment === f}
                onClick={() => setFulfilment(f)}
                className={`flex-1 rounded-lg text-[12px] ${fulfilment === f ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-sub'}`}
              >
                {f}
              </button>
            ))}
          </div>
        </Field>
        <Field label={fulfilment === 'Delivery' ? 'Delivery slot' : 'Pickup slot'} error={show(errors.slot)}>
          <select value={slot} onChange={(e) => setSlot(e.target.value)} className={`${fieldCls} border-line`}>
            {slots.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
      </div>

      {fulfilment === 'Delivery' && (
        <Field label="Delivery address" error={show(errors.address)}>
          <input value={address} onChange={(e) => setAddress(e.target.value)} className={`${fieldCls} ${borderCls(!!show(errors.address))}`} />
        </Field>
      )}

      <section>
        <div className="mb-1.5 font-semibold text-ink">Items</div>
        <select
          value={pick}
          onChange={(e) => addLine(e.target.value)}
          aria-label="Add an item"
          className={`${fieldCls} ${borderCls(!!show(errors.lines))}`}
        >
          <option value="">+ Add an item from the catalogue…</option>
          {inventoryItems.map((i) => (
            <option key={i.sku} value={i.name} disabled={statusOf(i) === 'out'}>
              {i.name} · {inr(i.price)} · {i.stock} in stock
            </option>
          ))}
        </select>
        {show(errors.lines) && <span className="mt-1 block text-[11px] text-coral">{errors.lines}</span>}
        {lines.length > 0 && (
          <table className="mt-2 w-full">
            <tbody>
              {lines.map((l, i) => {
                const q = Number(l.qtyText);
                const short = q > stockOf(l.name);
                return (
                  <tr key={l.name} className="h-11 border-t border-line">
                    <td className="!pl-0">
                      <div className="text-ink">{l.name}</div>
                      {short && <div className="text-[11px] text-coral">Only {stockOf(l.name)} in stock</div>}
                    </td>
                    <td className="text-right tabular-nums text-sub">{inr(l.price)}</td>
                    <td className="text-right">
                      <input
                        type="number"
                        min={1}
                        value={l.qtyText}
                        aria-label={`Quantity of ${l.name}`}
                        onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, qtyText: e.target.value } : x)))}
                        className={`h-8 w-16 rounded-lg border bg-surface px-2 text-right tabular-nums outline-none focus:border-blue ${short ? 'border-coral' : 'border-line'}`}
                      />
                    </td>
                    <td className="text-right font-semibold tabular-nums text-ink">
                      {Number.isFinite(q) && q > 0 ? inr(q * l.price) : '—'}
                    </td>
                    <td className="!pr-0 text-right">
                      <button
                        type="button"
                        aria-label={`Remove ${l.name}`}
                        onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                        className="text-mute hover:text-coral"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Payment">
          <select value={payment} onChange={(e) => setPayment(e.target.value as OrderPayment)} className={`${fieldCls} border-line`}>
            {orderPayments.map((p) => (
              <option key={p} disabled={p === 'Khata' && !customer}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Notes" hint="(optional)">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={`${fieldCls} border-line`} />
        </Field>
      </div>

      {khataProblem && <p className="rounded-xl bg-coral/10 px-3 py-2 text-[12px] text-coral">{khataProblem}</p>}
      {shortLines.length > 0 && (
        <p className="rounded-xl bg-amber/10 px-3 py-2 text-[12px] text-amber">
          Not enough stock for {shortLines.map((l) => l.name).join(', ')}. You can still take the order and restock before
          packing.
        </p>
      )}

      <div className="space-y-1 rounded-xl bg-bg px-3 py-2.5">
        <div className="flex justify-between text-sub">
          <span>Items subtotal</span>
          <span className="tabular-nums">{inr(sub)}</span>
        </div>
        {fulfilment === 'Delivery' && (
          <div className="flex justify-between text-sub">
            <span>Delivery {fee === 0 && sub > 0 ? '(free)' : `(free from ${inr(FREE_DELIVERY_FROM)})`}</span>
            <span className="tabular-nums">{inr(fee)}</span>
          </div>
        )}
        <div className="flex justify-between font-bold text-ink">
          <span>Total</span>
          <span className="tabular-nums">{inr(total)}</span>
        </div>
      </div>

      <Actions onCancel={onCancel} submitLabel="Place order" disabled={submitted && invalid} />
    </form>
  );
}

/* ---------- dispatch ---------- */

export function DispatchForm({
  busy,
  onSubmit,
  onCancel,
}: {
  /** Riders already out with another order. */
  busy: Set<string>;
  onSubmit: (rider: string) => void;
  onCancel: () => void;
}) {
  const [rider, setRider] = useState(riders.find((r) => !busy.has(r)) ?? riders[0] ?? '');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (rider) onSubmit(rider);
      }}
      className="space-y-4 text-[13px]"
    >
      <Field label="Rider">
        <select value={rider} onChange={(e) => setRider(e.target.value)} className={`${fieldCls} border-line`} autoFocus>
          {riders.map((r) => (
            <option key={r} value={r}>
              {r}
              {busy.has(r) ? ' (out on a delivery)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <Actions onCancel={onCancel} submitLabel="Dispatch" />
    </form>
  );
}

/* ---------- complete (collect COD) ---------- */

export function CompleteForm({
  order,
  total,
  onSubmit,
  onCancel,
}: {
  order: Order;
  total: number;
  onSubmit: (method: CollectMethod) => void;
  onCancel: () => void;
}) {
  const [method, setMethod] = useState<CollectMethod>('Cash');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(method);
      }}
      className="space-y-4 text-[13px]"
    >
      <div className="flex items-center justify-between rounded-xl bg-bg px-3 py-2.5">
        <span className="text-sub">To collect {order.fulfilment === 'Delivery' ? 'on delivery' : 'at pickup'}</span>
        <b className="tabular-nums text-ink">{inr(total)}</b>
      </div>
      <Field label="Collected by">
        <div className="flex h-10 rounded-xl bg-bg p-1" role="radiogroup" aria-label="Collected by">
          {(['Cash', 'UPI'] as CollectMethod[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={method === m}
              onClick={() => setMethod(m)}
              className={`flex-1 rounded-lg text-[12px] ${method === m ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-sub'}`}
            >
              {m}
            </button>
          ))}
        </div>
      </Field>
      <Actions onCancel={onCancel} submitLabel={`Collected ${inr(total)}`} />
    </form>
  );
}

/* ---------- cancel ---------- */

const cancelReasons = ['Customer cancelled', 'Items out of stock', 'Could not reach customer', 'Duplicate order'];

export function CancelForm({ onSubmit, onCancel }: { onSubmit: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState(cancelReasons[0]!);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(reason);
      }}
      className="space-y-4 text-[13px]"
    >
      <Field label="Reason">
        <select value={reason} onChange={(e) => setReason(e.target.value)} className={`${fieldCls} border-line`} autoFocus>
          {cancelReasons.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </Field>
      <p className="text-[12px] text-sub">The order stays in today&apos;s list as cancelled. This can&apos;t be undone.</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="h-10 rounded-xl card px-4 font-semibold">
          Keep order
        </button>
        <button type="submit" className="h-10 rounded-xl bg-coral px-5 font-semibold text-onbrand">
          Cancel order
        </button>
      </div>
    </form>
  );
}
