'use client';

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Plus, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { Field, fieldCls } from '@/components/suppliers/SupplierForms';
import { money } from '@/lib/pos/billing';
import { gstRates, type GstRate } from '@/lib/pos/catalog';
import { suggestedOrder } from '@/lib/inventory-data';
import { useBusinessProfile } from '@/lib/business-profile';
import {
  TODAY,
  addDays,
  billBalance,
  fmtDate,
  gstFor,
  lineFor,
  lineTaxable,
  matchBill,
  payModes,
  poProgress,
  poStatus,
  priceHistory,
  productBySku,
  products,
  returnReasons,
  supplierById,
  suppliers,
  totalsOf,
  type Grn,
  type GrnLine,
  type Line,
  type PayMode,
  type PurchaseOrder,
  type PurchaseReturn,
  type PurchaseState,
  type ReturnReason,
  type SupplierBill,
  type SupplierPayment,
} from '@/lib/purchase-data';

/* =====================================================================
   Shared bits
   ===================================================================== */

const cell = 'h-9 w-full rounded-lg border border-line bg-surface px-2 text-right tabular-nums outline-none focus:border-blue';

function Actions({ onCancel, children }: { onCancel: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
      <button type="button" onClick={onCancel} className="h-10 rounded-xl card px-4 font-semibold">
        Cancel
      </button>
      {children}
    </div>
  );
}

const Primary = ({ children, ...p }: { children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button {...p} className="h-10 rounded-xl gbv px-5 font-semibold text-onbrand shadow-md shadow-blue/20 disabled:opacity-50">
    {children}
  </button>
);
const Secondary = ({ children, ...p }: { children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button {...p} className="h-10 rounded-xl border border-line px-4 font-semibold text-ink hover:border-blue disabled:opacity-50">
    {children}
  </button>
);

function Problem({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-xl bg-coral/10 px-3 py-2 text-[12.5px] text-coral">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function SupplierSelect({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={`${fieldCls} border-line`}>
      <option value="">Choose supplier…</option>
      {suppliers.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
          {!s.gstin ? ' (unregistered)' : ''}
        </option>
      ))}
    </select>
  );
}

/** Totals box with the GST split that applies to this supplier. */
function TotalsBox({ lines, supplierId, label = 'Total' }: { lines: Line[]; supplierId: string; label?: string }) {
  const { gstApplies, interState } = gstFor(supplierById(supplierId));
  const t = totalsOf(lines, gstApplies, interState);
  return (
    <div className="ml-auto w-full max-w-[300px] space-y-1 rounded-xl bg-bg p-3 text-[12.5px]">
      <Row k="Taxable value" v={money(t.taxable)} />
      {gstApplies ? (
        interState ? (
          <Row k="IGST" v={money(t.igst)} />
        ) : (
          <>
            <Row k="CGST" v={money(t.cgst)} />
            <Row k="SGST" v={money(t.sgst)} />
          </>
        )
      ) : (
        <Row k="GST" v="Not charged (unregistered supplier)" />
      )}
      {t.roundOff !== 0 && <Row k="Round off" v={money(t.roundOff)} />}
      <div className="flex justify-between border-t border-line pt-1.5 text-[14px] font-extrabold text-ink">
        <span>{label}</span>
        <span className="tabular-nums">{money(t.total)}</span>
      </div>
      {gstApplies && <div className="text-right text-[11px] text-teal">Input tax credit {money(t.tax)}</div>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 text-sub">
      <span>{k}</span>
      <span className="text-right tabular-nums">{v}</span>
    </div>
  );
}

/** Product → qty × rate − discount, with GST. Used by POs and supplier bills. */
function LineEditor({
  lines,
  setLines,
  supplierId,
  lastRate,
  showDiscount = true,
}: {
  lines: Line[];
  setLines: (fn: (l: Line[]) => Line[]) => void;
  supplierId: string;
  lastRate: (sku: string) => number | undefined;
  showDiscount?: boolean;
}) {
  const supplierName = supplierById(supplierId)?.name;
  const sorted = useMemo(
    () => [...products].sort((a, b) => Number(b.supplier === supplierName) - Number(a.supplier === supplierName) || a.name.localeCompare(b.name)),
    [supplierName]
  );
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[12.5px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
              <th className="pb-1.5 font-medium">Item</th>
              <th className="w-20 pb-1.5 text-right font-medium">Qty</th>
              <th className="w-24 pb-1.5 text-right font-medium">Rate ₹</th>
              {showDiscount && <th className="w-16 pb-1.5 text-right font-medium">Disc %</th>}
              <th className="w-20 pb-1.5 text-right font-medium">GST</th>
              <th className="w-24 pb-1.5 text-right font-medium">Amount</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const last = lastRate(l.sku);
              const higher = last !== undefined && l.rate > last * 1.005;
              return (
                <tr key={i} className="border-t border-line align-top">
                  <td className="py-1.5 pr-2">
                    <select
                      value={l.sku}
                      onChange={(e) => {
                        const n = lineFor(e.target.value, l.qty, lastRate(e.target.value));
                        set(i, n);
                      }}
                      className="h-9 w-full rounded-lg border border-line bg-surface px-2 outline-none focus:border-blue"
                    >
                      {sorted.map((p) => (
                        <option key={p.sku} value={p.sku}>
                          {p.name}
                          {p.supplier !== supplierName ? ` · ${p.supplier}` : ''}
                        </option>
                      ))}
                    </select>
                    {higher && <div className="mt-0.5 text-[11px] font-semibold text-amber">▲ above last cost ₹{last}</div>}
                  </td>
                  <td className="py-1.5 pr-2">
                    <input type="number" min={0} value={l.qty} onChange={(e) => set(i, { qty: Number(e.target.value) })} aria-label="Quantity" className={cell} />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input type="number" min={0} step="0.01" value={l.rate} onChange={(e) => set(i, { rate: Number(e.target.value) })} aria-label="Rate" className={cell} />
                  </td>
                  {showDiscount && (
                    <td className="py-1.5 pr-2">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step="0.1"
                        value={l.discountPct}
                        onChange={(e) => set(i, { discountPct: Number(e.target.value) })}
                        aria-label="Discount %"
                        className={cell}
                      />
                    </td>
                  )}
                  <td className="py-1.5 pr-2">
                    <select value={l.gst} onChange={(e) => set(i, { gst: Number(e.target.value) as GstRate })} aria-label="GST rate" className={`${cell} text-left`}>
                      {gstRates.map((r) => (
                        <option key={r} value={r}>
                          {r}%
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1.5 pr-2 text-right font-semibold tabular-nums leading-9 text-ink">{money(lineTaxable(l))}</td>
                  <td className="py-1.5">
                    <button
                      type="button"
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      aria-label={`Remove ${l.name}`}
                      className="grid size-9 place-items-center rounded-lg text-mute hover:bg-coral/10 hover:text-coral"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={() => {
          const first = sorted[0];
          if (first) setLines((ls) => [...ls, lineFor(first.sku, 1, lastRate(first.sku))]);
        }}
        className="flex items-center gap-1.5 text-[12.5px] font-semibold text-blue"
      >
        <Plus className="size-4" /> Add item
      </button>
    </div>
  );
}

const lineProblems = (lines: Line[]) =>
  !lines.length
    ? 'Add at least one item.'
    : lines.some((l) => !(l.qty > 0))
      ? 'Every line needs a quantity above 0.'
      : lines.some((l) => !(l.rate >= 0) || l.discountPct < 0 || l.discountPct > 100)
        ? 'Check the rates and discounts.'
        : new Set(lines.map((l) => l.sku)).size !== lines.length
          ? 'The same item is listed twice — combine them.'
          : null;

/** Most recent cost for an item (from price history, else the catalogue cost). */
const useLastRate = (state: PurchaseState) => (sku: string) => {
  const h = priceHistory(sku, state);
  return h.length ? h[h.length - 1]!.rate : productBySku(sku)?.cost;
};

/* =====================================================================
   Purchase order
   ===================================================================== */

export function PoForm({
  state,
  initial,
  onSubmit,
  onCancel,
}: {
  state: PurchaseState;
  initial?: PurchaseOrder | undefined;
  onSubmit: (po: Omit<PurchaseOrder, 'id'>) => void;
  onCancel: () => void;
}) {
  const lastRate = useLastRate(state);
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? '');
  const [date, setDate] = useState(initial?.date ?? TODAY);
  const [expected, setExpected] = useState(initial?.expected ?? addDays(TODAY, 2));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [lines, setLinesState] = useState<Line[]>(initial?.lines ?? []);
  const [tried, setTried] = useState(false);
  const setLines = (fn: (l: Line[]) => Line[]) => setLinesState(fn);
  const s = supplierById(supplierId);
  const lowStock = products.filter((p) => p.supplier === s?.name && suggestedOrder(p) > 0 && !lines.some((l) => l.sku === p.sku));

  const problem = !supplierId ? 'Choose a supplier.' : expected < date ? 'Expected date is before the order date.' : lineProblems(lines);

  const submit = (status: 'draft' | 'sent') => (e?: FormEvent) => {
    e?.preventDefault();
    setTried(true);
    if (problem) return;
    onSubmit({ supplierId, date, expected, status, lines, notes: notes.trim() });
  };

  return (
    <form onSubmit={submit('sent')} className="space-y-4 text-[13px]">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Supplier">
          <SupplierSelect value={supplierId} onChange={setSupplierId} />
        </Field>
        <Field label="Order date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${fieldCls} border-line`} />
        </Field>
        <Field label="Expected delivery">
          <input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} className={`${fieldCls} border-line`} />
        </Field>
      </div>
      {s && lowStock.length > 0 && (
        <button
          type="button"
          onClick={() => setLines((ls) => [...ls, ...lowStock.map((p) => lineFor(p.sku, suggestedOrder(p), lastRate(p.sku)))])}
          className="flex w-full items-center gap-2 rounded-xl border border-dashed border-blue/40 bg-blue/5 px-3 py-2.5 text-left text-[12.5px] font-semibold text-blue hover:bg-blue/10"
        >
          <Sparkles className="size-4" /> Add {lowStock.length} low-stock item{lowStock.length === 1 ? '' : 's'} from {s.name} with suggested quantities
        </button>
      )}
      {supplierId && <LineEditor lines={lines} setLines={setLines} supplierId={supplierId} lastRate={lastRate} showDiscount={false} />}
      {supplierId && lines.length > 0 && <TotalsBox lines={lines} supplierId={supplierId} label="Order value" />}
      <Field label="Notes" hint="(optional, printed on the PO)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className={`${fieldCls} border-line`} />
      </Field>
      {tried && problem && <Problem>{problem}</Problem>}
      <Actions onCancel={onCancel}>
        <Secondary type="button" onClick={() => submit('draft')()}>
          Save as draft
        </Secondary>
        <Primary type="submit">Save &amp; mark sent</Primary>
      </Actions>
    </form>
  );
}

/* =====================================================================
   Goods received note
   ===================================================================== */

export function GrnForm({
  state,
  initialPoId,
  receivedBy,
  onSubmit,
  onCancel,
}: {
  state: PurchaseState;
  initialPoId?: string | undefined;
  receivedBy: string;
  onSubmit: (grn: Omit<Grn, 'id'>, returnRejected: boolean) => void;
  onCancel: () => void;
}) {
  const profile = useBusinessProfile();
  const expiryRequired = profile.modules.expiry && profile.businessType === 'pharmacy';
  const initialPo = state.pos.find((p) => p.id === initialPoId);
  const [supplierId, setSupplierId] = useState(initialPo?.supplierId ?? '');
  const [poId, setPoId] = useState<string>(initialPo?.id ?? '');
  const [date, setDate] = useState(TODAY);
  const [by, setBy] = useState(receivedBy);
  const [challan, setChallan] = useState('');
  const [notes, setNotes] = useState('');
  const [returnRejected, setReturnRejected] = useState(true);
  const [tried, setTried] = useState(false);

  const linesFromPo = (id: string): GrnLine[] => {
    const po = state.pos.find((p) => p.id === id);
    if (!po) return [];
    return poProgress(po, state.grns)
      .lines.filter((l) => l.pending > 0)
      .map((l) => ({ sku: l.sku, name: l.name, ordered: l.pending, received: l.pending, rejected: 0, rejectReason: '', batch: '', expiry: '', rate: l.rate }));
  };
  const [lines, setLines] = useState<GrnLine[]>(() => (initialPo ? linesFromPo(initialPo.id) : []));

  const openPos = state.pos.filter(
    (p) => p.supplierId === supplierId && ['sent', 'partial'].includes(poStatus(p, state.grns))
  );
  const set = (i: number, patch: Partial<GrnLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const anyRejected = lines.some((l) => l.rejected > 0);

  const problem = !supplierId
    ? 'Choose a supplier.'
    : !lines.length
      ? 'Add the items that arrived.'
      : lines.some((l) => l.received < 0 || l.rejected < 0 || l.rejected > l.received)
        ? 'Rejected can’t be more than received.'
        : !lines.some((l) => l.received > 0)
          ? 'Enter the quantity received.'
          : lines.some((l) => l.rejected > 0 && !l.rejectReason)
            ? 'Give a reason for rejected items.'
            : expiryRequired && lines.some((l) => l.received - l.rejected > 0 && (!l.batch || !l.expiry))
              ? 'Batch number and expiry date are required for every medicine received.'
              : lines.some((l) => l.expiry && l.expiry <= date)
                ? 'An item is already expired on arrival — reject it instead.'
                : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (problem) return;
        onSubmit(
          { supplierId, poId: poId || null, date, receivedBy: by.trim(), supplierChallan: challan.trim(), lines: lines.filter((l) => l.received > 0), notes: notes.trim() },
          anyRejected && returnRejected
        );
      }}
      className="space-y-4 text-[13px]"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supplier">
          <SupplierSelect
            value={supplierId}
            disabled={!!initialPo}
            onChange={(id) => {
              setSupplierId(id);
              setPoId('');
              setLines([]);
            }}
          />
        </Field>
        <Field label="Against purchase order">
          <select
            value={poId}
            disabled={!supplierId || !!initialPo}
            onChange={(e) => {
              setPoId(e.target.value);
              setLines(e.target.value ? linesFromPo(e.target.value) : []);
            }}
            className={`${fieldCls} border-line`}
          >
            <option value="">No PO — direct delivery</option>
            {(initialPo ? [initialPo] : openPos).map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {fmtDate(p.date)} · {poProgress(p, state.grns).pct}% received
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Received on">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${fieldCls} border-line`} />
        </Field>
        <Field label="Received by">
          <input value={by} onChange={(e) => setBy(e.target.value)} className={`${fieldCls} border-line`} />
        </Field>
        <Field label="Supplier challan no." hint="(optional)">
          <input value={challan} onChange={(e) => setChallan(e.target.value)} className={`${fieldCls} border-line`} />
        </Field>
      </div>

      {supplierId && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                <th className="min-w-[170px] pb-1.5 pr-2 font-medium">Item</th>
                <th className="w-14 pb-1.5 pr-2 text-right font-medium">Due</th>
                <th className="w-20 pb-1.5 pr-2 text-right font-medium">Received</th>
                <th className="w-20 pb-1.5 pr-2 text-right font-medium">Rejected</th>
                <th className="w-32 pb-1.5 pl-1 pr-2 font-medium">Reason</th>
                <th className="w-28 pb-1.5 pr-2 font-medium">Batch{expiryRequired ? ' *' : ''}</th>
                <th className="w-36 pb-1.5 pr-2 font-medium">Expiry{expiryRequired ? ' *' : ''}</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={`${l.sku}-${i}`} className="border-t border-line">
                  <td className="py-1.5 pr-2">
                    {l.ordered === null ? (
                      <select
                        value={l.sku}
                        onChange={(e) => {
                          const p = productBySku(e.target.value)!;
                          set(i, { sku: p.sku, name: p.name, rate: p.cost });
                        }}
                        className="h-9 w-full rounded-lg border border-line bg-surface px-2 outline-none focus:border-blue"
                      >
                        {products.map((p) => (
                          <option key={p.sku} value={p.sku}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="font-semibold text-ink">{l.name}</span>
                    )}
                    {l.ordered !== null && l.received > l.ordered && <div className="text-[11px] font-semibold text-amber">More than ordered</div>}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-sub">{l.ordered ?? '—'}</td>
                  <td className="py-1.5 pr-2">
                    <input type="number" min={0} value={l.received} onChange={(e) => set(i, { received: Number(e.target.value) })} aria-label={`Received ${l.name}`} className={cell} />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      type="number"
                      min={0}
                      value={l.rejected}
                      onChange={(e) => set(i, { rejected: Number(e.target.value) })}
                      aria-label={`Rejected ${l.name}`}
                      className={`${cell} ${l.rejected > 0 ? 'border-coral/50 text-coral' : ''}`}
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <select
                      value={l.rejectReason}
                      disabled={!l.rejected}
                      onChange={(e) => set(i, { rejectReason: e.target.value })}
                      className="h-9 w-full rounded-lg border border-line bg-surface px-1.5 outline-none focus:border-blue disabled:opacity-40"
                    >
                      <option value="">—</option>
                      {returnReasons.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1.5 pr-2">
                    <input value={l.batch} onChange={(e) => set(i, { batch: e.target.value.toUpperCase() })} placeholder="Batch" className="h-9 w-full rounded-lg border border-line bg-surface px-2 font-mono text-[12px] outline-none focus:border-blue" />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input type="date" value={l.expiry} onChange={(e) => set(i, { expiry: e.target.value })} aria-label={`Expiry ${l.name}`} className="h-9 w-full rounded-lg border border-line bg-surface px-2 outline-none focus:border-blue" />
                  </td>
                  <td className="py-1.5">
                    <button
                      type="button"
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      aria-label={`Remove ${l.name}`}
                      className="grid size-9 place-items-center rounded-lg text-mute hover:bg-coral/10 hover:text-coral"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!poId && (
            <button
              type="button"
              onClick={() => {
                const p = products.find((x) => x.supplier === supplierById(supplierId)?.name) ?? products[0]!;
                setLines((ls) => [...ls, { sku: p.sku, name: p.name, ordered: null, received: 1, rejected: 0, rejectReason: '', batch: '', expiry: '', rate: p.cost }]);
              }}
              className="mt-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-blue"
            >
              <Plus className="size-4" /> Add item
            </button>
          )}
        </div>
      )}
      {anyRejected && (
        <label className="flex items-center gap-2 rounded-xl bg-amber/10 px-3 py-2.5 text-[12.5px] text-ink">
          <input type="checkbox" checked={returnRejected} onChange={(e) => setReturnRejected(e.target.checked)} />
          Create a purchase return (debit note) for the rejected items
        </label>
      )}
      <Field label="Notes" hint="(optional)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. one crate crushed in transit" className={`${fieldCls} border-line`} />
      </Field>
      {tried && problem && <Problem>{problem}</Problem>}
      <Actions onCancel={onCancel}>
        <Primary type="submit">Save goods receipt</Primary>
      </Actions>
    </form>
  );
}

/* =====================================================================
   Supplier bill (purchase invoice)
   ===================================================================== */

export function BillForm({
  state,
  initialGrnIds,
  onSubmit,
  onCancel,
}: {
  state: PurchaseState;
  initialGrnIds?: string[] | undefined;
  onSubmit: (bill: Omit<SupplierBill, 'id'>) => void;
  onCancel: () => void;
}) {
  const lastRate = useLastRate(state);
  const billedGrns = new Set(state.bills.flatMap((b) => b.grnIds));
  const firstGrn = state.grns.find((g) => g.id === initialGrnIds?.[0]);
  const [supplierId, setSupplierId] = useState(firstGrn?.supplierId ?? '');
  const [number, setNumber] = useState('');
  const [date, setDate] = useState(TODAY);
  const s = supplierById(supplierId);
  const [dueDate, setDueDate] = useState(addDays(TODAY, s?.creditDays ?? 7));
  const [grnIds, setGrnIds] = useState<string[]>(initialGrnIds ?? []);
  const [accept, setAccept] = useState(false);
  const [tried, setTried] = useState(false);

  const linesFromGrns = (ids: string[]): Line[] => {
    const grns = state.grns.filter((g) => ids.includes(g.id));
    const m = new Map<string, Line>();
    for (const g of grns) {
      const po = state.pos.find((p) => p.id === g.poId);
      for (const l of g.lines) {
        const qty = l.received - l.rejected;
        if (qty <= 0) continue;
        const poRate = po?.lines.find((x) => x.sku === l.sku)?.rate;
        const prev = m.get(l.sku);
        m.set(l.sku, prev ? { ...prev, qty: prev.qty + qty } : lineFor(l.sku, qty, poRate ?? l.rate));
      }
    }
    return [...m.values()];
  };
  const [lines, setLinesState] = useState<Line[]>(() => linesFromGrns(initialGrnIds ?? []));
  const setLines = (fn: (l: Line[]) => Line[]) => setLinesState(fn);

  const candidateGrns = state.grns.filter((g) => g.supplierId === supplierId && (!billedGrns.has(g.id) || grnIds.includes(g.id)));
  const poId = state.grns.find((g) => grnIds.includes(g.id))?.poId ?? null;
  const { gstApplies, interState } = gstFor(s);
  const issues = matchBill({ lines, grnIds, poId }, state);
  const duplicate = state.bills.some((b) => b.supplierId === supplierId && b.number.trim().toLowerCase() === number.trim().toLowerCase());

  const problem = !supplierId
    ? 'Choose a supplier.'
    : !number.trim()
      ? "Enter the supplier's invoice number."
      : duplicate
        ? `Bill ${number} from ${s?.name} is already entered.`
        : dueDate < date
          ? 'Due date is before the bill date.'
          : lineProblems(lines) ?? (issues.length && !accept ? 'The bill doesn’t match what was received — tick “Accept with differences” or correct it.' : null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (problem) return;
        onSubmit({ supplierId, number: number.trim(), date, dueDate, poId, grnIds, lines, gstApplies, interState });
      }}
      className="space-y-4 text-[13px]"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supplier">
          <SupplierSelect
            value={supplierId}
            disabled={!!firstGrn}
            onChange={(id) => {
              setSupplierId(id);
              setGrnIds([]);
              setLinesState([]);
              setDueDate(addDays(date, supplierById(id)?.creditDays ?? 7));
            }}
          />
        </Field>
        <Field label="Supplier's invoice no.">
          <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="As printed on their bill" className={`${fieldCls} border-line font-mono`} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Bill date">
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setDueDate(addDays(e.target.value, s?.creditDays ?? 7));
            }}
            className={`${fieldCls} border-line`}
          />
        </Field>
        <Field label="Payment due" hint={s ? `(${s.creditDays}-day credit)` : ''}>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={`${fieldCls} border-line`} />
        </Field>
        <Field label="GST">
          <div className="flex h-10 items-center rounded-xl bg-bg px-3 text-[12px] text-sub">
            {!s ? '—' : !gstApplies ? 'Unregistered — no GST' : interState ? 'Other state — IGST' : 'Same state — CGST + SGST'}
          </div>
        </Field>
      </div>

      {supplierId && (
        <div>
          <div className="mb-1.5 font-semibold text-ink">Goods receipts on this bill</div>
          {candidateGrns.length === 0 ? (
            <p className="rounded-xl bg-bg px-3 py-2.5 text-[12.5px] text-sub">No unbilled goods receipts from this supplier — add the items below.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {candidateGrns.map((g) => {
                const on = grnIds.includes(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => {
                      const ids = on ? grnIds.filter((x) => x !== g.id) : [...grnIds, g.id];
                      setGrnIds(ids);
                      setLinesState(linesFromGrns(ids));
                    }}
                    className={`flex items-center gap-1.5 rounded-lg border-2 px-3 py-1.5 text-[12px] font-semibold ${on ? 'border-blue bg-blue/5 text-blue' : 'border-line text-sub hover:border-blue/40'}`}
                  >
                    {on && <Check className="size-3.5" />} {g.id} · {fmtDate(g.date)}
                    {g.poId && <span className="font-normal text-mute">· {g.poId}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {supplierId && <LineEditor lines={lines} setLines={setLines} supplierId={supplierId} lastRate={lastRate} />}

      {issues.length > 0 && (
        <div className="space-y-2 rounded-xl border border-amber/40 bg-amber/10 p-3 text-[12.5px]">
          <div className="flex items-center gap-2 font-bold text-amber">
            <TriangleAlert className="size-4" /> Doesn’t match the PO / goods receipt
          </div>
          <ul className="space-y-0.5 text-ink">
            {issues.map((i) => (
              <li key={`${i.sku}-${i.kind}`}>
                <b>{i.name}</b> — {i.detail}
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-ink">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
            Accept with differences (raise a return / debit note for the difference)
          </label>
        </div>
      )}
      {grnIds.length > 0 && issues.length === 0 && lines.length > 0 && (
        <p className="flex items-center gap-2 rounded-xl bg-teal/10 px-3 py-2 text-[12.5px] font-semibold text-teal">
          <Check className="size-4" /> Matches the purchase order and goods receipt
        </p>
      )}
      {supplierId && lines.length > 0 && <TotalsBox lines={lines} supplierId={supplierId} label="Bill total" />}
      {tried && problem && <Problem>{problem}</Problem>}
      <Actions onCancel={onCancel}>
        <Primary type="submit">Save supplier bill</Primary>
      </Actions>
    </form>
  );
}

/* =====================================================================
   Purchase return (debit note)
   ===================================================================== */

export function ReturnForm({
  state,
  initial,
  onSubmit,
  onCancel,
}: {
  state: PurchaseState;
  initial?: { billId?: string | undefined; grnId?: string | undefined } | undefined;
  onSubmit: (r: Omit<PurchaseReturn, 'id'>) => void;
  onCancel: () => void;
}) {
  const initBill = state.bills.find((b) => b.id === initial?.billId);
  const initGrn = state.grns.find((g) => g.id === initial?.grnId);
  const [supplierId, setSupplierId] = useState(initBill?.supplierId ?? initGrn?.supplierId ?? '');
  const [billId, setBillId] = useState(initBill?.id ?? '');
  const [date, setDate] = useState(TODAY);
  const [settlement, setSettlement] = useState<'adjust' | 'refund'>('adjust');
  const [tried, setTried] = useState(false);

  /** Units of each item already returned against a bill. */
  const returnedOn = (bId: string) => {
    const m = new Map<string, number>();
    for (const r of state.returns.filter((x) => x.billId === bId)) for (const l of r.lines) m.set(l.sku, (m.get(l.sku) ?? 0) + l.qty);
    return m;
  };
  const fromBill = (bId: string) => {
    const b = state.bills.find((x) => x.id === bId);
    if (!b) return [];
    const done = returnedOn(bId);
    return b.lines.map((l) => ({ ...l, qty: 0, max: l.qty - (done.get(l.sku) ?? 0), reason: 'Damaged' as ReturnReason }));
  };
  const fromGrnRejects = (g: Grn) =>
    g.lines
      .filter((l) => l.rejected > 0)
      .map((l) => ({ ...lineFor(l.sku, l.rejected, l.rate), max: l.rejected, reason: (returnReasons.includes(l.rejectReason as ReturnReason) ? l.rejectReason : 'Damaged') as ReturnReason }));

  const [lines, setLines] = useState<(Line & { max: number; reason: ReturnReason })[]>(() =>
    initBill ? fromBill(initBill.id) : initGrn ? fromGrnRejects(initGrn) : []
  );
  const s = supplierById(supplierId);
  const { gstApplies, interState } = gstFor(s);
  const bills = state.bills.filter((b) => b.supplierId === supplierId);
  const chosen = lines.filter((l) => l.qty > 0);
  const set = (i: number, patch: Partial<Line & { reason: ReturnReason }>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const problem = !supplierId
    ? 'Choose a supplier.'
    : !chosen.length
      ? 'Enter the quantity to return.'
      : lines.some((l) => l.qty < 0 || l.qty > l.max)
        ? 'You can’t return more than was billed / rejected.'
        : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (problem) return;
        onSubmit({
          supplierId,
          billId: billId || null,
          grnId: initGrn?.id ?? null,
          date,
          lines: chosen.map(({ max: _m, ...l }) => l),
          status: 'pending',
          settlement,
          gstApplies,
          interState,
        });
      }}
      className="space-y-4 text-[13px]"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Supplier">
          <SupplierSelect
            value={supplierId}
            disabled={!!initBill || !!initGrn}
            onChange={(id) => {
              setSupplierId(id);
              setBillId('');
              setLines([]);
            }}
          />
        </Field>
        <Field label="Against bill">
          <select
            value={billId}
            disabled={!supplierId || !!initBill}
            onChange={(e) => {
              setBillId(e.target.value);
              if (e.target.value) setLines(fromBill(e.target.value));
            }}
            className={`${fieldCls} border-line`}
          >
            <option value="">{initGrn ? `Rejected on ${initGrn.id}` : 'Choose bill…'}</option>
            {bills.map((b) => (
              <option key={b.id} value={b.id}>
                {b.number} · {fmtDate(b.date)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Return date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${fieldCls} border-line`} />
        </Field>
      </div>

      {lines.length > 0 && (
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
              <th className="pb-1.5 font-medium">Item</th>
              <th className="w-20 pb-1.5 text-right font-medium">Rate</th>
              <th className="w-24 pb-1.5 text-right font-medium">Return qty</th>
              <th className="w-36 pb-1.5 font-medium">Reason</th>
              <th className="w-24 pb-1.5 text-right font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.sku} className="border-t border-line">
                <td className="py-1.5 pr-2">
                  <div className="font-semibold text-ink">{l.name}</div>
                  <div className="text-[11px] text-mute">up to {l.max}</div>
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-sub">{money(l.rate)}</td>
                <td className="py-1.5 pr-2">
                  <input type="number" min={0} max={l.max} value={l.qty} onChange={(e) => set(i, { qty: Number(e.target.value) })} aria-label={`Return ${l.name}`} className={cell} />
                </td>
                <td className="py-1.5 pr-2">
                  <select value={l.reason} onChange={(e) => set(i, { reason: e.target.value as ReturnReason })} className="h-9 w-full rounded-lg border border-line bg-surface px-1.5 outline-none focus:border-blue">
                    {returnReasons.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </td>
                <td className="py-1.5 text-right font-semibold tabular-nums text-ink">{money(lineTaxable(l))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Field label="Settle by">
        <div className="flex h-10 rounded-xl bg-bg p-1" role="radiogroup" aria-label="Settlement">
          {(
            [
              ['adjust', billId ? 'Reduce what we owe on this bill' : 'Adjust against future bills'],
              ['refund', 'Supplier refunds the money'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={settlement === v}
              onClick={() => setSettlement(v)}
              className={`flex-1 rounded-lg text-[12px] ${settlement === v ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-sub'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </Field>
      {supplierId && chosen.length > 0 && <TotalsBox lines={chosen} supplierId={supplierId} label="Debit note value" />}
      {tried && problem && <Problem>{problem}</Problem>}
      <Actions onCancel={onCancel}>
        <Primary type="submit">Create debit note</Primary>
      </Actions>
    </form>
  );
}

/* =====================================================================
   Supplier payment
   ===================================================================== */

export function PaymentForm({
  state,
  initial,
  onSubmit,
  onCancel,
}: {
  state: PurchaseState;
  initial?: { supplierId?: string | undefined; billId?: string | undefined } | undefined;
  onSubmit: (p: Omit<SupplierPayment, 'id'>) => void;
  onCancel: () => void;
}) {
  const initBill = state.bills.find((b) => b.id === initial?.billId);
  const [supplierId, setSupplierId] = useState(initBill?.supplierId ?? initial?.supplierId ?? '');
  const openBills = (id: string) =>
    state.bills
      .filter((b) => b.supplierId === id && billBalance(b, state) > 0.5)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const bills = openBills(supplierId);
  const outstanding = bills.reduce((s, b) => s + billBalance(b, state), 0);

  /** Oldest due first, up to the amount. */
  const autoAllocate = (amount: number, list = bills, prefer?: string) => {
    let left = amount;
    const ordered = prefer ? [...list.filter((b) => b.id === prefer), ...list.filter((b) => b.id !== prefer)] : list;
    const out: Record<string, number> = {};
    for (const b of ordered) {
      const take = Math.min(left, billBalance(b, state));
      out[b.id] = Math.round(take * 100) / 100;
      left -= take;
    }
    return out;
  };

  const startAmount = initBill ? billBalance(initBill, state) : outstanding;
  const [amountText, setAmountText] = useState(startAmount ? String(startAmount) : '');
  const [alloc, setAlloc] = useState<Record<string, number>>(() => autoAllocate(startAmount, bills, initBill?.id));
  const [date, setDate] = useState(TODAY);
  const [mode, setMode] = useState<PayMode>('Bank transfer');
  const [ref, setRef] = useState('');
  const [notes, setNotes] = useState('');
  const [tried, setTried] = useState(false);
  const amount = Number(amountText);
  const allocated = Object.values(alloc).reduce((s, v) => s + (v || 0), 0);
  const advance = Math.round((amount - allocated) * 100) / 100;

  const problem = !supplierId
    ? 'Choose a supplier.'
    : !(amount > 0)
      ? 'Enter the amount paid.'
      : allocated > amount + 0.005
        ? 'Allocated more than the amount paid.'
        : bills.some((b) => (alloc[b.id] ?? 0) > billBalance(b, state) + 0.005 || (alloc[b.id] ?? 0) < 0)
          ? 'An allocation is more than that bill’s balance.'
          : (mode === 'Cheque' || mode === 'Bank transfer') && !ref.trim()
            ? `Enter the ${mode === 'Cheque' ? 'cheque number' : 'UTR / reference'}.`
            : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (problem) return;
        onSubmit({
          supplierId,
          date,
          amount: Math.round(amount * 100) / 100,
          mode,
          ref: ref.trim(),
          notes: notes.trim(),
          allocations: Object.entries(alloc)
            .filter(([, v]) => v > 0)
            .map(([billId, v]) => ({ billId, amount: v })),
        });
      }}
      className="space-y-4 text-[13px]"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supplier">
          <SupplierSelect
            value={supplierId}
            disabled={!!initBill}
            onChange={(id) => {
              setSupplierId(id);
              const list = openBills(id);
              const total = list.reduce((s, b) => s + billBalance(b, state), 0);
              setAmountText(total ? String(Math.round(total * 100) / 100) : '');
              setAlloc(autoAllocate(total, list));
            }}
          />
        </Field>
        <Field label="Amount paid (₹)">
          <input
            type="number"
            min={0}
            step="0.01"
            value={amountText}
            onChange={(e) => {
              setAmountText(e.target.value);
              setAlloc(autoAllocate(Number(e.target.value) || 0, bills, initBill?.id));
            }}
            className={`${fieldCls} border-line text-[15px] font-bold tabular-nums`}
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Paid on">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${fieldCls} border-line`} />
        </Field>
        <Field label="Mode">
          <select value={mode} onChange={(e) => setMode(e.target.value as PayMode)} className={`${fieldCls} border-line`}>
            {payModes.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label={mode === 'Cheque' ? 'Cheque no.' : mode === 'Cash' ? 'Receipt no.' : 'UTR / reference'} hint={mode === 'Cash' || mode === 'UPI' ? '(optional)' : ''}>
          <input value={ref} onChange={(e) => setRef(e.target.value)} className={`${fieldCls} border-line font-mono`} />
        </Field>
      </div>

      {supplierId && (
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-semibold text-ink">Apply to bills</span>
            <span className="text-[12px] text-sub">Outstanding {money(outstanding)}</span>
          </div>
          {bills.length === 0 ? (
            <p className="rounded-xl bg-bg px-3 py-2.5 text-[12.5px] text-sub">No unpaid bills — this payment will be kept as an advance.</p>
          ) : (
            <table className="w-full text-[12.5px]">
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id} className="border-t border-line">
                    <td className="py-1.5">
                      <div className="font-semibold text-ink">{b.number}</div>
                      <div className="text-[11px] text-mute">
                        Due {fmtDate(b.dueDate)} · balance {money(billBalance(b, state))}
                      </div>
                    </td>
                    <td className="w-32 py-1.5">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={alloc[b.id] ?? 0}
                        onChange={(e) => setAlloc((a) => ({ ...a, [b.id]: Number(e.target.value) }))}
                        aria-label={`Apply to ${b.number}`}
                        className={cell}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {advance > 0.005 && amount > 0 && (
            <p className="mt-2 rounded-lg bg-blue/5 px-3 py-2 text-[12px] text-sub">
              {money(advance)} not applied to a bill — kept as an advance with {s(supplierId)}.
            </p>
          )}
        </div>
      )}
      <Field label="Notes" hint="(optional)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className={`${fieldCls} border-line`} />
      </Field>
      {tried && problem && <Problem>{problem}</Problem>}
      <Actions onCancel={onCancel}>
        <Primary type="submit">Record payment</Primary>
      </Actions>
    </form>
  );
}

const s = (id: string) => supplierById(id)?.name ?? 'the supplier';
