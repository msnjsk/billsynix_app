'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { initialCustomers, tierOf } from '@/lib/customers-data';
import { cashiers } from '@/lib/sales-data';
import { gstRates, DEFAULT_TAX, type GstRate } from '@/lib/pos/catalog';
import {
  GSTIN_RE,
  buildCreditLines,
  discountAmount,
  money,
  payMethods,
  r2,
  refundFor,
  returnableQty,
  unitCharged,
  type Buyer,
  type CartLine,
  type Discount,
  type Invoice,
  type PayMethod,
  type PosDocument,
} from '@/lib/pos/billing';
import { connectSerialPrinter, hasSerialPrinter, serialSupported } from '@/lib/pos/escpos';
import { counters, type PosSettings } from '@/lib/pos/store';
import type { DesktopPrinter } from '@/types/desktop';

/* ---------- shared bits ---------- */

const inputCls = 'h-10 w-full rounded-xl border border-line bg-surface px-3 text-ink outline-none focus:border-blue';

function F({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-semibold text-ink">
        {label} {hint && <span className="font-normal text-mute">{hint}</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-[11px] text-coral">{error}</span>}
    </label>
  );
}

function Buttons({
  onCancel,
  submitLabel,
  disabled,
  extra,
}: {
  onCancel: () => void;
  submitLabel: string;
  disabled?: boolean;
  extra?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      {extra}
      <button type="button" onClick={onCancel} className="h-10 rounded-xl card px-4 font-semibold">
        Cancel
      </button>
      <button type="submit" disabled={disabled} className="h-10 rounded-xl gbv px-5 font-semibold text-onbrand disabled:opacity-50">
        {submitLabel}
      </button>
    </div>
  );
}

function Toggle<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="flex h-10 rounded-xl bg-bg p-1" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-lg text-[12px] disabled:opacity-40 ${
            value === o.value ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-sub'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- discount ---------- */

export function DiscountPanel({
  base,
  current,
  maxPct = 100,
  onSubmit,
  onCancel,
}: {
  /** Amount the discount applies to. */
  base: number;
  current: Discount;
  /** Highest % the cashier may give without approval. */
  maxPct?: number;
  onSubmit: (d: Discount) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<'pct' | 'amt'>(current?.kind ?? 'pct');
  const [text, setText] = useState(current ? String(current.value) : '');
  const v = Number(text);
  const d: Discount = text && Number.isFinite(v) && v > 0 ? { kind, value: v } : null;
  const amount = discountAmount(base, d);
  const pct = base > 0 ? (amount / base) * 100 : 0;
  const error =
    text && (!Number.isFinite(v) || v < 0)
      ? 'Enter a positive number'
      : kind === 'amt' && v > base
        ? `Can't exceed ${money(base)}`
        : pct > maxPct + 1e-9
          ? `Max ${maxPct}% without manager approval`
          : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!error) onSubmit(d);
      }}
      className="space-y-4 text-[13px]"
    >
      <div className="grid grid-cols-2 gap-3">
        <F label="Type">
          <Toggle
            label="Discount type"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'pct', label: '% off' },
              { value: 'amt', label: '₹ off' },
            ]}
          />
        </F>
        <F label={kind === 'pct' ? 'Percent' : 'Amount (₹)'} error={error}>
          <input
            autoFocus
            type="number"
            min={0}
            step="0.01"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={inputCls}
          />
        </F>
      </div>
      <div className="flex flex-wrap gap-2">
        {[5, 10, 15, 20].map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              setKind('pct');
              setText(String(p));
            }}
            className="h-8 rounded-lg border border-line px-3 text-[12px] font-semibold hover:border-blue"
          >
            {p}%
          </button>
        ))}
      </div>
      <div className="flex justify-between rounded-xl bg-bg px-3 py-2.5">
        <span className="text-sub">
          {money(base)} − {money(amount)}
        </span>
        <b className="tabular-nums text-ink">{money(r2(base - amount))}</b>
      </div>
      <Buttons
        onCancel={onCancel}
        submitLabel={d ? 'Apply discount' : 'Remove discount'}
        disabled={!!error || (!d && !current)}
      />
    </form>
  );
}

/* ---------- open-price / loose item ---------- */

export function OpenItemPanel({ onSubmit, onCancel }: { onSubmit: (l: Omit<CartLine, 'key'>) => void; onCancel: () => void }) {
  const [name, setName] = useState('Loose vegetables');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('1');
  const [gst, setGst] = useState<GstRate>(0);
  const [hsn, setHsn] = useState('0709');
  const p = Number(price);
  const q = Number(qty);
  const errors = {
    name: name.trim().length < 2 ? 'Enter a name' : null,
    price: !(p > 0) ? 'Enter the price' : null,
    qty: !(q > 0) ? 'Enter a quantity' : null,
  };
  const bad = Object.values(errors).some(Boolean);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!bad) onSubmit({ sku: null, name: name.trim(), price: r2(p), qty: r2(q), gst, hsn: hsn.trim() || DEFAULT_TAX.hsn, discount: null });
      }}
      className="space-y-4 text-[13px]"
    >
      <F label="Item name" error={name ? errors.name : null}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </F>
      <div className="grid grid-cols-2 gap-3">
        <F label="Price per unit / kg (₹)" hint="incl. GST" error={price ? errors.price : null}>
          <input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className={inputCls} />
        </F>
        <F label="Qty / weight (kg)" error={errors.qty}>
          <input type="number" min={0} step="0.005" value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} />
        </F>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <F label="GST rate">
          <select value={gst} onChange={(e) => setGst(Number(e.target.value) as GstRate)} className={inputCls}>
            {gstRates.map((r) => (
              <option key={r} value={r}>
                {r}%
              </option>
            ))}
          </select>
        </F>
        <F label="HSN code">
          <input value={hsn} onChange={(e) => setHsn(e.target.value)} className={inputCls} />
        </F>
      </div>
      {!bad && (
        <div className="flex justify-between rounded-xl bg-bg px-3 py-2.5">
          <span className="text-sub">Line total</span>
          <b className="tabular-nums text-ink">{money(r2(p * q))}</b>
        </div>
      )}
      <Buttons onCancel={onCancel} submitLabel="Add to bill" disabled={bad} />
    </form>
  );
}

/* ---------- customer ---------- */

export function CustomerPanel({
  current,
  onSubmit,
  onCancel,
}: {
  current: Buyer | null;
  onSubmit: (b: Buyer | null) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState('');
  const [name, setName] = useState(current?.customerId ? '' : (current?.name ?? ''));
  const [phone, setPhone] = useState(current?.customerId ? '' : (current?.phone ?? ''));
  const [gstin, setGstin] = useState(current?.gstin ?? '');
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    const digits = s.replace(/\D/g, '');
    return initialCustomers
      .filter((c) => !s || c.name.toLowerCase().includes(s) || (digits.length >= 3 && c.phone.replace(/\D/g, '').includes(digits)))
      .slice(0, 6);
  }, [q]);
  const g = gstin.trim().toUpperCase();
  const gstinError = g && !GSTIN_RE.test(g) ? 'GSTIN should be 15 characters, e.g. 33AAGFS5678K1Z2' : null;

  const submitNew = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2 || gstinError) return;
    onSubmit({ customerId: null, name: name.trim(), phone: phone.trim(), gstin: g });
  };

  return (
    <div className="space-y-4 text-[13px]">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search saved customers by name or phone…"
        aria-label="Search customers"
        className={inputCls}
      />
      <ul className="divide-y divide-line rounded-xl border border-line">
        {matches.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onSubmit({ customerId: c.id, name: c.name, phone: c.phone, gstin: current?.customerId === c.id ? current.gstin : '' })}
              className={`flex w-full items-center justify-between px-3 py-2 text-left hover:bg-bg ${current?.customerId === c.id ? 'bg-blue/5' : ''}`}
            >
              <span>
                <span className="font-semibold text-ink">{c.name}</span> <span className="text-mute">{c.phone}</span>
              </span>
              <span className="text-[11px] text-sub">
                {tierOf(c)} · {c.points} pts
              </span>
            </button>
          </li>
        ))}
        {matches.length === 0 && <li className="px-3 py-3 text-sub">No saved customer matches.</li>}
      </ul>

      <form onSubmit={submitNew} className="space-y-3 rounded-xl bg-bg p-3">
        <div className="font-semibold text-ink">Or bill to someone else (e.g. a business needing a GST invoice)</div>
        <div className="grid grid-cols-2 gap-3">
          <F label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </F>
          <F label="Phone" hint="(optional)">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" className={inputCls} />
          </F>
        </div>
        <F label="Buyer GSTIN" hint="(for B2B invoices)" error={gstinError}>
          <input value={gstin} onChange={(e) => setGstin(e.target.value)} className={`${inputCls} uppercase`} />
        </F>
        <div className="flex justify-between gap-2">
          <button type="button" onClick={() => onSubmit(null)} className="h-10 rounded-xl card px-4 font-semibold">
            Walk-in (no customer)
          </button>
          <button
            type="submit"
            disabled={name.trim().length < 2 || !!gstinError}
            className="h-10 rounded-xl gbv px-5 font-semibold text-onbrand disabled:opacity-50"
          >
            Use these details
          </button>
        </div>
      </form>
      <div className="flex justify-end">
        <button type="button" onClick={onCancel} className="text-[12px] font-semibold text-sub">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ---------- held bills ---------- */

export type HeldBill = { id: string; heldAt: string; lines: CartLine[]; billDiscount: Discount; buyer: Buyer | null; total: number };

export function HeldPanel({
  held,
  onResume,
  onDelete,
}: {
  held: HeldBill[];
  onResume: (h: HeldBill) => void;
  onDelete: (id: string) => void;
}) {
  if (!held.length) return <p className="py-6 text-center text-sub">No bills on hold. Press F8 to park the current bill.</p>;
  return (
    <ul className="divide-y divide-line text-[13px]">
      {held.map((h) => (
        <li key={h.id} className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-ink">{h.buyer?.name ?? 'Walk-in'}</div>
            <div className="text-[11px] text-mute">
              Held {new Date(h.heldAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} ·{' '}
              {h.lines.length} items
            </div>
          </div>
          <b className="tabular-nums">{money(h.total)}</b>
          <button onClick={() => onDelete(h.id)} className="text-[12px] font-semibold text-sub hover:text-coral">
            Discard
          </button>
          <button onClick={() => onResume(h)} className="h-8 rounded-lg gbv px-3 text-[12px] font-semibold text-onbrand">
            Resume
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ---------- bills & returns ---------- */

const reasons = ['Damaged / defective', 'Expired', 'Wrong item', 'Customer changed mind', 'Billing error'];

export function ReturnsPanel({
  invoices,
  docs,
  onReturn,
  onVoid,
  onReprint,
  onCancel,
}: {
  /** Every invoice that can be looked up (this counter's + today's register). Newest first. */
  invoices: Invoice[];
  /** Documents issued on this counter, for reprinting. */
  docs: PosDocument[];
  onReturn: (inv: Invoice, qtys: Record<string, number>, reason: string, method: PayMethod) => void;
  /** Connected: cancel one of today's bills (nothing returned yet). */
  onVoid?: (inv: Invoice) => void;
  onReprint: (d: PosDocument) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Invoice | null>(null);
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [reason, setReason] = useState(reasons[0]!);
  const [method, setMethod] = useState<PayMethod>('Cash');

  const found = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return invoices.slice(0, 8);
    return invoices
      .filter((i) => i.no.toLowerCase().includes(s) || i.no.endsWith(s.padStart(5, '0')) || i.buyer?.name.toLowerCase().includes(s))
      .slice(0, 8);
  }, [q, invoices]);

  const pick = (inv: Invoice) => {
    setPicked(inv);
    setQtys({});
    setMethod(inv.payments[0]?.method ?? 'Cash');
  };

  if (!picked) {
    return (
      <div className="space-y-3 text-[13px]">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && found[0]) pick(found[0]);
          }}
          placeholder="Bill number (e.g. 4815) or customer name…"
          aria-label="Find bill"
          className={inputCls}
        />
        <ul className="divide-y divide-line rounded-xl border border-line">
          {found.map((inv) => {
            const fully = inv.totals.rows.every((r) => returnableQty(inv, r) <= 0);
            const untouched = Object.values(inv.returned).every((q) => !q);
            const today = new Date(inv.issuedAt).toDateString() === new Date().toDateString();
            const doc = docs.find((d) => d.kind === 'invoice' && d.no === inv.no);
            return (
              <li key={inv.no} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-ink">
                    {inv.no}
                    {inv.cancelled && <span className="ml-2 rounded bg-coral/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-coral">Cancelled</span>}
                  </div>
                  <div className="text-[11px] text-mute">
                    {new Date(inv.issuedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{' '}
                    · {inv.buyer?.name ?? 'Walk-in'} · {inv.payments.map((p) => p.method).join(' + ')}
                  </div>
                </div>
                <b className="tabular-nums">{money(inv.totals.payable)}</b>
                <button onClick={() => onReprint(doc ?? inv)} className="text-[12px] font-semibold text-sub hover:text-blue">
                  Reprint
                </button>
                {onVoid && !inv.cancelled && today && untouched && (
                  <button onClick={() => onVoid(inv)} className="text-[12px] font-semibold text-sub hover:text-coral">
                    Cancel bill
                  </button>
                )}
                <button
                  disabled={fully || !!inv.cancelled}
                  onClick={() => pick(inv)}
                  className="h-8 rounded-lg border border-line px-3 text-[12px] font-semibold hover:border-blue disabled:opacity-40"
                >
                  {inv.cancelled ? 'Cancelled' : fully ? 'Returned' : 'Return items'}
                </button>
              </li>
            );
          })}
          {found.length === 0 && <li className="px-3 py-4 text-center text-sub">No bill found.</li>}
        </ul>
        {docs.some((d) => d.kind === 'credit') && (
          <div>
            <div className="mb-1 font-semibold text-ink">Credit notes issued</div>
            <ul className="space-y-1">
              {docs
                .filter((d) => d.kind === 'credit')
                .map((d) => (
                  <li key={d.no} className="flex justify-between">
                    <span>
                      {d.no} <span className="text-mute">· against {d.kind === 'credit' && d.against}</span>
                    </span>
                    <button onClick={() => onReprint(d)} className="text-[12px] font-semibold text-blue">
                      Reprint
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  const lines = buildCreditLines(picked, qtys);
  const refund = lines.length ? refundFor(picked, lines) : 0;
  const all = () =>
    setQtys(Object.fromEntries(picked.totals.rows.map((r) => [r.key, returnableQty(picked, r)])));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (lines.length) onReturn(picked, qtys, reason, method);
      }}
      className="space-y-4 text-[13px]"
    >
      <div className="flex items-center justify-between rounded-xl bg-bg px-3 py-2">
        <span>
          <b>{picked.no}</b> <span className="text-mute">· {picked.buyer?.name ?? 'Walk-in'}</span>
        </span>
        <button type="button" onClick={() => setPicked(null)} className="text-[12px] font-semibold text-blue">
          Change bill
        </button>
      </div>
      <table className="w-full">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
            <th className="pb-2 !pl-0 font-medium">Item</th>
            <th className="pb-2 text-right font-medium">Paid / unit</th>
            <th className="pb-2 text-right font-medium">Return</th>
          </tr>
        </thead>
        <tbody>
          {picked.totals.rows.map((r) => {
            const max = returnableQty(picked, r);
            const val = qtys[r.key] ?? 0;
            const set = (n: number) => setQtys((p) => ({ ...p, [r.key]: Math.max(0, Math.min(max, r2(n))) }));
            return (
              <tr key={r.key} className="h-12 border-t border-line">
                <td className="!pl-0">
                  <div className="text-ink">{r.name}</div>
                  <div className="text-[11px] text-mute">
                    Bought {r.qty}
                    {max < r.qty && ` · ${r2(r.qty - max)} already returned`}
                  </div>
                </td>
                <td className="text-right tabular-nums text-sub">{money(r2(unitCharged(r)))}</td>
                <td className="text-right">
                  {max <= 0 ? (
                    <span className="text-[11px] text-mute">Returned</span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <button type="button" aria-label={`Fewer ${r.name}`} onClick={() => set(val - 1)} className="size-7 rounded-lg border border-line">
                        −
                      </button>
                      <input
                        type="number"
                        min={0}
                        max={max}
                        step="any"
                        value={val}
                        aria-label={`Return quantity of ${r.name}`}
                        onChange={(e) => set(Number(e.target.value) || 0)}
                        className="h-7 w-14 rounded-lg border border-line bg-surface px-1 text-center tabular-nums outline-none focus:border-blue"
                      />
                      <button type="button" aria-label={`More ${r.name}`} onClick={() => set(val + 1)} className="size-7 rounded-lg border border-line">
                        +
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="grid grid-cols-2 gap-3">
        <F label="Reason">
          <select value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls}>
            {reasons.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </F>
        <F label="Refund by" hint={`(paid by ${picked.payments.map((p) => p.method).join(' + ')})`}>
          <Toggle label="Refund method" value={method} onChange={setMethod} options={payMethods.map((m) => ({ value: m, label: m }))} />
        </F>
      </div>
      <div className="flex items-center justify-between rounded-xl bg-coral/10 px-4 py-3">
        <span className="font-semibold text-coral">Refund · issues a credit note</span>
        <b className="text-[20px] tabular-nums text-coral">{money(refund)}</b>
      </div>
      <Buttons
        onCancel={onCancel}
        submitLabel="Refund & print credit note"
        disabled={!lines.length}
        extra={
          <button type="button" onClick={all} className="mr-auto text-[12px] font-semibold text-blue">
            Return everything
          </button>
        }
      />
    </form>
  );
}

/* ---------- camera scanner ---------- */

type Detector = { detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]> };
type DetectorCtor = new (o: { formats: string[] }) => Detector;

export const cameraScanSupported = () =>
  typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;

/** Uses the phone / webcam camera via the browser's BarcodeDetector (Chrome on Android, macOS, ChromeOS). */
export function CameraScanner({ onScan, onCancel }: { onScan: (code: string) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector;
    const detector = new Ctor({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'] });

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then(async (s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (!video.current) return;
        video.current.srcObject = s;
        await video.current.play();
        const tick = async () => {
          if (stopped || !video.current) return;
          try {
            const [hit] = await detector.detect(video.current);
            if (hit?.rawValue) return onScan(hit.rawValue);
          } catch {
            /* frame not ready */
          }
          timer = window.setTimeout(tick, 250);
        };
        tick();
      })
      .catch(() => setError('Camera unavailable. Allow camera access in the browser, or use a USB scanner.'));

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onScan]);

  return (
    <div className="space-y-3 text-[13px]">
      {error ? (
        <p className="rounded-xl bg-coral/10 px-3 py-4 text-center text-coral">{error}</p>
      ) : (
        <div className="relative overflow-hidden rounded-xl bg-black">
          <video ref={video} muted playsInline className="aspect-video w-full object-cover" />
          <div className="pointer-events-none absolute inset-x-10 top-1/2 h-0.5 -translate-y-1/2 bg-coral/80" />
        </div>
      )}
      <p className="text-sub">Hold the barcode steady inside the frame.</p>
      <div className="flex justify-end">
        <button onClick={onCancel} className="h-10 rounded-xl card px-4 font-semibold">
          Close
        </button>
      </div>
    </div>
  );
}

/* ---------- settings ---------- */

export function SettingsPanel({
  settings,
  onSave,
  onTestPrint,
  onCancel,
}: {
  settings: PosSettings;
  onSave: (s: PosSettings) => void;
  onTestPrint: (s: PosSettings) => void;
  onCancel: () => void;
}) {
  const [s, setS] = useState(settings);
  const [printer, setPrinter] = useState<'unknown' | 'connected' | 'none'>('unknown');
  const [msg, setMsg] = useState<string | null>(null);
  const serialOk = serialSupported();
  const desktop = typeof window !== 'undefined' ? window.posDesktop : undefined;
  const [printers, setPrinters] = useState<DesktopPrinter[]>([]);
  const set = <K extends keyof PosSettings>(k: K, v: PosSettings[K]) => setS((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    if (serialOk) hasSerialPrinter().then((ok) => setPrinter(ok ? 'connected' : 'none'));
  }, [serialOk]);
  useEffect(() => {
    desktop
      ?.getPrinters()
      .then(setPrinters)
      .catch(() => setPrinters([]));
  }, [desktop]);

  const connect = async () => {
    setMsg(null);
    try {
      await connectSerialPrinter();
      setPrinter('connected');
    } catch (e) {
      setMsg(e instanceof Error && e.name !== 'NotFoundError' ? e.message : 'No printer selected.');
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(s);
      }}
      className="space-y-4 text-[13px]"
    >
      <p className="rounded-lg bg-bg px-3 py-2 text-[12px] text-sub">
        Store name, address, GSTIN, invoice prefix and receipt message are set in the{' '}
        <a href="/business-profile" className="font-semibold text-blue">
          Business profile
        </a>
        . These settings are for this counter only.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <F label="Cashier">
          <select value={s.cashier} onChange={(e) => set('cashier', e.target.value)} className={inputCls}>
            {cashiers.map((c) => (
              <option key={c.name}>{c.name}</option>
            ))}
          </select>
        </F>
        <F label="Counter">
          <select value={s.counter} onChange={(e) => set('counter', e.target.value)} className={inputCls}>
            {counters.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </F>
      </div>
      <F label="Store UPI ID" hint="(shown in the payment QR)">
        <input value={s.upiId} onChange={(e) => set('upiId', e.target.value.trim())} className={inputCls} />
      </F>

      <div className="rounded-xl border border-line p-3">
        <div className="mb-3 font-bold text-ink">Thermal printer</div>
        <div className="grid gap-3 sm:grid-cols-[150px_1fr]">
          <F label="Paper roll">
            <Toggle
              label="Paper width"
              value={s.paperWidth}
              onChange={(v) => set('paperWidth', v)}
              options={[
                { value: 58, label: '58 mm' },
                { value: 80, label: '80 mm' },
              ]}
            />
          </F>
          <F label="Print using">
            <Toggle
              label="Print method"
              value={s.printMethod}
              onChange={(v) => set('printMethod', v)}
              options={[
                ...(desktop ? [{ value: 'desktop' as const, label: 'Desktop printer' }] : []),
                { value: 'browser', label: 'Print dialog' },
                { value: 'serial', label: 'Direct ESC/POS', disabled: !serialOk },
              ]}
            />
          </F>
        </div>
        {s.printMethod === 'desktop' && desktop && (
          <div className="mt-3 space-y-1.5">
            <F label="Printer" hint="(receipts print straight to it — no dialog)">
              <select value={s.desktopPrinter} onChange={(e) => set('desktopPrinter', e.target.value)} className={inputCls}>
                <option value="">System default printer</option>
                {printers.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.displayName}
                    {p.isDefault ? ' (default)' : ''}
                  </option>
                ))}
                {s.desktopPrinter && !printers.some((p) => p.name === s.desktopPrinter) && (
                  <option value={s.desktopPrinter}>{s.desktopPrinter} (not found)</option>
                )}
              </select>
            </F>
            <p className="text-[11px] text-mute">
              Uses the printer&apos;s Windows driver. To open the cash drawer automatically, use Direct ESC/POS instead.
            </p>
          </div>
        )}
        {s.printMethod === 'serial' && (
          <div className="mt-3 space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-lg bg-bg px-3 py-2">
              <span className={printer === 'connected' ? 'text-teal' : 'text-sub'}>
                {printer === 'connected' ? '● Printer connected' : '○ No printer connected yet'}
              </span>
              <button type="button" onClick={connect} className="h-8 rounded-lg border border-line px-3 text-[12px] font-semibold hover:border-blue">
                {printer === 'connected' ? 'Change printer' : 'Connect printer'}
              </button>
            </div>
            <F label="Baud rate" hint="(USB printers usually ignore this)">
              <select value={s.baudRate} onChange={(e) => set('baudRate', Number(e.target.value))} className={inputCls}>
                {[9600, 19200, 38400, 115200].map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </F>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.openDrawer} onChange={(e) => set('openDrawer', e.target.checked)} />
              Open the cash drawer on cash sales
            </label>
          </div>
        )}
        {!serialOk && !desktop && (
          <p className="mt-2 text-[11px] text-mute">Direct printing needs Chrome or Edge on a desktop, or the BillSynix desktop app. The print dialog works everywhere.</p>
        )}
        {msg && <p className="mt-2 text-[12px] text-coral">{msg}</p>}
        <label className="mt-3 flex items-center gap-2">
          <input type="checkbox" checked={s.autoPrint} onChange={(e) => set('autoPrint', e.target.checked)} />
          Print the receipt automatically after payment
        </label>
      </div>
      <Buttons
        onCancel={onCancel}
        submitLabel="Save settings"
        extra={
          <button type="button" onClick={() => onTestPrint(s)} className="mr-auto text-[12px] font-semibold text-blue">
            Print test receipt
          </button>
        }
      />
    </form>
  );
}
