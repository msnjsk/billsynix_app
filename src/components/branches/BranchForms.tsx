'use client';

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Plus, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { Field, borderCls, fieldCls } from '@/components/suppliers/SupplierForms';
import { money } from '@/lib/pos/billing';
import { gstStates, gstinProblem, useBusinessProfile } from '@/lib/business-profile';
import {
  TARGET_STOCK,
  TODAY,
  branchById,
  catalogue,
  itemBySku,
  lowAt,
  stockAt,
  transferDoc,
  type Branch,
  type BranchState,
  type Transfer,
} from '@/lib/branch-data';
import { slug } from '@/lib/suppliers-data';

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

/* =====================================================================
   Branch
   ===================================================================== */

export function BranchForm({
  state,
  initial,
  onSubmit,
  onCancel,
}: {
  state: BranchState;
  initial?: Branch | undefined;
  onSubmit: (b: Branch) => void;
  onCancel: () => void;
}) {
  const profile = useBusinessProfile();
  const hq = state.branches.find((b) => b.isHq);
  const registered = profile.registration !== 'unregistered';
  const [b, setB] = useState<Branch>(
    initial ?? {
      id: '',
      code: '',
      name: '',
      kind: 'store',
      isHq: false,
      address: { line1: '', city: '', pincode: '', stateCode: hq?.address.stateCode ?? profile.address.stateCode },
      phone: '',
      gstin: hq?.gstin ?? '',
      manager: '',
      openedOn: TODAY,
      active: true,
      monthlyTarget: 0,
    }
  );
  const [tried, setTried] = useState(false);
  const set = <K extends keyof Branch>(k: K, v: Branch[K]) => setB((x) => ({ ...x, [k]: v }));
  const setAddr = (k: keyof Branch['address'], v: string) => setB((x) => ({ ...x, address: { ...x.address, [k]: v } }));

  // A registration already held in this state — branches in one state share one GSTIN.
  const sameState = state.branches.find((x) => x.id !== b.id && x.address.stateCode === b.address.stateCode && x.gstin);

  const errors: Partial<Record<'name' | 'code' | 'line1' | 'city' | 'pincode' | 'gstin', string>> = {};
  if (!b.name.trim()) errors.name = 'Enter a name';
  const code = b.code.trim().toUpperCase();
  if (!b.isHq && !/^[A-Z0-9]{2,4}$/.test(code)) errors.code = '2–4 letters or digits, e.g. TNG (GST bill numbers max 16 characters)';
  else if (state.branches.some((x) => x.id !== b.id && x.code.toUpperCase() === code)) errors.code = 'Another branch uses this code';
  if (!b.address.line1.trim()) errors.line1 = 'Enter the address';
  if (!b.address.city.trim()) errors.city = 'Enter the city';
  if (!/^\d{6}$/.test(b.address.pincode.trim())) errors.pincode = '6-digit PIN code';
  if (registered) {
    const g = b.gstin.trim().toUpperCase();
    const problem = gstinProblem(g);
    if (problem) errors.gstin = problem;
    else if (g.slice(0, 2) !== b.address.stateCode) errors.gstin = `This GSTIN is for ${gstStates[g.slice(0, 2)]} — a branch in ${gstStates[b.address.stateCode]} needs that state's registration`;
  }
  const bad = Object.keys(errors).length > 0;
  const err = (k: keyof typeof errors) => (tried ? errors[k] : undefined);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (bad) return;
    let id = b.id;
    if (!id) {
      id = slug(b.name) || code.toLowerCase();
      while (state.branches.some((x) => x.id === id)) id += '-2';
    }
    onSubmit({ ...b, id, code, name: b.name.trim(), gstin: registered ? b.gstin.trim().toUpperCase() : '' });
  };

  return (
    <form onSubmit={submit} className="space-y-4 text-[13px]">
      <div className="grid gap-3 sm:grid-cols-[1fr_120px_160px]">
        <Field label="Branch name" error={err('name')}>
          <input value={b.name} onChange={(e) => set('name', e.target.value)} className={`${fieldCls} ${borderCls(!!err('name'))}`} placeholder="e.g. Velachery" autoFocus />
        </Field>
        <Field label="Code" hint="(bill prefix)" error={err('code')}>
          <input
            value={b.code}
            onChange={(e) => set('code', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
            disabled={b.isHq}
            className={`${fieldCls} ${borderCls(!!err('code'))} uppercase disabled:opacity-60`}
            placeholder="VEL"
          />
        </Field>
        <Field label="Type">
          <select value={b.kind} onChange={(e) => set('kind', e.target.value as Branch['kind'])} disabled={b.isHq} className={`${fieldCls} border-line disabled:opacity-60`}>
            <option value="store">Store (sells)</option>
            <option value="warehouse">Warehouse (stock only)</option>
          </select>
        </Field>
      </div>

      <Field label="Address" error={err('line1')}>
        <input value={b.address.line1} onChange={(e) => setAddr('line1', e.target.value)} className={`${fieldCls} ${borderCls(!!err('line1'))}`} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="City" error={err('city')}>
          <input value={b.address.city} onChange={(e) => setAddr('city', e.target.value)} className={`${fieldCls} ${borderCls(!!err('city'))}`} />
        </Field>
        <Field label="PIN code" error={err('pincode')}>
          <input value={b.address.pincode} onChange={(e) => setAddr('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" className={`${fieldCls} ${borderCls(!!err('pincode'))}`} />
        </Field>
        <Field label="State">
          <select
            value={b.address.stateCode}
            onChange={(e) => {
              const sc = e.target.value;
              setB((x) => {
                const reg = state.branches.find((o) => o.id !== x.id && o.address.stateCode === sc && o.gstin);
                return { ...x, address: { ...x.address, stateCode: sc }, gstin: reg ? reg.gstin : x.gstin.slice(0, 2) === sc ? x.gstin : '' };
              });
            }}
            className={`${fieldCls} border-line`}
          >
            {Object.entries(gstStates).map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {registered ? (
          <Field label="GSTIN for this branch" error={err('gstin')}>
            <input value={b.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase().slice(0, 15))} className={`${fieldCls} ${borderCls(!!err('gstin'))} font-mono uppercase`} />
            <span className="mt-1 block text-[11px] text-mute">
              {sameState
                ? `Same state as ${sameState.name} — use the same GSTIN.`
                : 'New state: register this branch under your PAN in that state and enter the new GSTIN.'}
            </span>
          </Field>
        ) : (
          <div className="rounded-xl bg-bg p-3 text-[12px] text-sub">Your business is not GST registered, so branches don&apos;t need a GSTIN.</div>
        )}
        <Field label="Phone">
          <input value={b.phone} onChange={(e) => set('phone', e.target.value)} className={`${fieldCls} border-line`} inputMode="tel" />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Manager">
          <input value={b.manager} onChange={(e) => set('manager', e.target.value)} className={`${fieldCls} border-line`} />
        </Field>
        <Field label="Opened on">
          <input type="date" value={b.openedOn} onChange={(e) => set('openedOn', e.target.value)} className={`${fieldCls} border-line`} />
        </Field>
        {b.kind === 'store' && (
          <Field label="Monthly sales target" hint="(₹)">
            <input
              value={b.monthlyTarget || ''}
              onChange={(e) => set('monthlyTarget', Number(e.target.value.replace(/\D/g, '')) || 0)}
              inputMode="numeric"
              className={`${fieldCls} border-line text-right tabular-nums`}
            />
          </Field>
        )}
      </div>

      {!b.isHq && (
        <label className="flex items-center gap-2 text-sub">
          <input type="checkbox" checked={b.active} onChange={(e) => set('active', e.target.checked)} className="size-4 accent-[var(--blue)]" />
          Active — uncheck to close the branch (its history is kept)
        </label>
      )}

      <Actions onCancel={onCancel}>
        <Primary type="submit" disabled={tried && bad}>
          {initial ? 'Save branch' : 'Add branch'}
        </Primary>
      </Actions>
    </form>
  );
}

/* =====================================================================
   Stock transfer
   ===================================================================== */

export type TransferDraft = Omit<Transfer, 'id' | 'status' | 'dispatchedOn' | 'receivedOn'>;

export function TransferForm({
  state,
  initial,
  requestedBy,
  onSubmit,
  onCancel,
}: {
  state: BranchState;
  initial?: { from?: string | undefined; to?: string | undefined; lines?: { sku: string; qty: number }[] | undefined } | undefined;
  requestedBy: string;
  onSubmit: (t: TransferDraft) => void;
  onCancel: () => void;
}) {
  const active = state.branches.filter((b) => b.active);
  const [from, setFrom] = useState(initial?.from ?? active.find((b) => b.kind === 'warehouse')?.id ?? active[0]?.id ?? '');
  const [to, setTo] = useState(initial?.to ?? active.find((b) => b.id !== from && b.kind === 'store')?.id ?? '');
  const [lines, setLines] = useState<{ sku: string; qty: number }[]>(initial?.lines ?? []);
  const [pick, setPick] = useState('');
  const [notes, setNotes] = useState('');
  const [tried, setTried] = useState(false);

  const doc = from && to ? transferDoc(state, { from, to }) : null;
  const short = lines.filter((l) => l.qty > stockAt(state, from, l.sku));
  const value = lines.reduce((s, l) => s + l.qty * (itemBySku(l.sku)?.cost ?? 0), 0);
  const problems = [
    ...(from === to ? ['Pick two different branches.'] : []),
    ...(!lines.length ? ['Add at least one item.'] : []),
    ...(lines.some((l) => !(l.qty > 0)) ? ['Every quantity must be more than zero.'] : []),
    ...(short.length ? [`${branchById(state, from)?.name} only has ${short.map((l) => `${stockAt(state, from, l.sku)} × ${itemBySku(l.sku)?.name}`).join(', ')}.`] : []),
  ];

  const lowAtDest = useMemo(() => (to ? lowAt(state, to).filter((c) => !lines.some((l) => l.sku === c.sku)) : []), [state, to, lines]);
  const add = (sku: string, qty = 1) => sku && setLines((ls) => (ls.some((l) => l.sku === sku) ? ls : [...ls, { sku, qty }]));
  const fillLow = () =>
    lowAtDest.forEach((c) => {
      const q = Math.min(TARGET_STOCK - stockAt(state, to, c.sku), stockAt(state, from, c.sku));
      if (q > 0) add(c.sku, q);
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problems.length) return;
    onSubmit({ from, to, date: TODAY, requestedBy, notes: notes.trim(), lines: lines.map((l) => ({ ...l, received: null })) });
  };

  return (
    <form onSubmit={submit} className="space-y-4 text-[13px]">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From">
          <select value={from} onChange={(e) => setFrom(e.target.value)} className={`${fieldCls} border-line`}>
            {active.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.kind === 'warehouse' ? ' (warehouse)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="To">
          <select value={to} onChange={(e) => setTo(e.target.value)} className={`${fieldCls} border-line`}>
            {active
              .filter((b) => b.id !== from)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </select>
        </Field>
      </div>

      {doc && from !== to && (
        <p className={`rounded-xl px-3 py-2 text-[12px] ${doc.crossGstin ? 'bg-amber/15 text-ink' : 'bg-bg text-sub'}`}>
          <b>{doc.label}.</b> {doc.note}
          {doc.crossGstin && value > 50000 && ' Goods worth over ₹50,000 — generate an e-way bill before dispatch.'}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select value={pick} onChange={(e) => { add(e.target.value); setPick(''); }} aria-label="Add item" className={`${fieldCls} border-line max-w-xs`}>
          <option value="">Add an item…</option>
          {catalogue
            .filter((c) => !lines.some((l) => l.sku === c.sku))
            .map((c) => (
              <option key={c.sku} value={c.sku}>
                {c.name} — {stockAt(state, from, c.sku)} at source
              </option>
            ))}
        </select>
        {lowAtDest.length > 0 && (
          <button type="button" onClick={fillLow} className="flex h-10 items-center gap-1.5 rounded-xl border border-line px-3 font-semibold text-blue hover:border-blue">
            <Sparkles className="size-4" /> Add {lowAtDest.length} low-stock item{lowAtDest.length === 1 ? '' : 's'} at {branchById(state, to)?.name}
          </button>
        )}
      </div>

      {lines.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                <th className="pb-2 font-medium">Item</th>
                <th className="pb-2 text-right font-medium">At source</th>
                <th className="pb-2 text-right font-medium">At destination</th>
                <th className="w-24 pb-2 text-right font-medium">Send</th>
                <th className="pb-2 text-right font-medium">Value</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const it = itemBySku(l.sku);
                const over = l.qty > stockAt(state, from, l.sku);
                return (
                  <tr key={l.sku} className="h-11 border-t border-line">
                    <td className="text-ink">{it?.name}</td>
                    <td className={`text-right tabular-nums ${over ? 'font-semibold text-coral' : 'text-sub'}`}>{stockAt(state, from, l.sku)}</td>
                    <td className="text-right tabular-nums text-sub">{stockAt(state, to, l.sku)}</td>
                    <td className="pl-3">
                      <input
                        value={l.qty || ''}
                        onChange={(e) => {
                          const q = Number(e.target.value.replace(/[^\d.]/g, '')) || 0;
                          setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: q } : x)));
                        }}
                        inputMode="decimal"
                        aria-label={`Quantity of ${it?.name}`}
                        className={`${cell} ${over ? 'border-coral' : ''}`}
                      />
                    </td>
                    <td className="text-right tabular-nums text-ink">{money(l.qty * (it?.cost ?? 0))}</td>
                    <td className="text-right">
                      <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`Remove ${it?.name}`} className="p-1 text-mute hover:text-coral">
                        <Trash2 className="size-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-line font-extrabold text-ink">
                <td colSpan={4} className="pt-2 text-right">
                  Value at cost
                </td>
                <td className="pt-2 text-right tabular-nums">{money(value)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <p className="flex items-center justify-center gap-2 rounded-xl bg-bg py-8 text-sub">
          <Plus className="size-4" /> Add the items to move
        </p>
      )}

      <Field label="Notes" hint="(optional)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className={`${fieldCls} border-line`} placeholder="e.g. weekend promotion stock" />
      </Field>

      {tried && problems.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-coral/10 p-3 text-[12px] text-coral">
          {problems.map((p) => (
            <li key={p} className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {p}
            </li>
          ))}
        </ul>
      )}

      <Actions onCancel={onCancel}>
        <Primary type="submit" disabled={tried && problems.length > 0}>
          Request transfer
        </Primary>
      </Actions>
    </form>
  );
}

/** Count what arrived. Anything short stays recorded on the transfer. */
export function ReceiveForm({ transfer, onSubmit, onCancel }: { transfer: Transfer; onSubmit: (received: Record<string, number>) => void; onCancel: () => void }) {
  const [got, setGot] = useState<Record<string, number>>(Object.fromEntries(transfer.lines.map((l) => [l.sku, l.qty])));
  const bad = transfer.lines.some((l) => (got[l.sku] ?? 0) < 0 || (got[l.sku] ?? 0) > l.qty);
  const shortBy = transfer.lines.reduce((s, l) => s + Math.max(0, l.qty - (got[l.sku] ?? 0)), 0);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!bad) onSubmit(got);
      }}
      className="space-y-4 text-[13px]"
    >
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
            <th className="pb-2 font-medium">Item</th>
            <th className="pb-2 text-right font-medium">Sent</th>
            <th className="w-28 pb-2 text-right font-medium">Received</th>
          </tr>
        </thead>
        <tbody>
          {transfer.lines.map((l) => {
            const v = got[l.sku] ?? 0;
            return (
              <tr key={l.sku} className="h-11 border-t border-line">
                <td className="text-ink">{itemBySku(l.sku)?.name}</td>
                <td className="text-right tabular-nums text-sub">{l.qty}</td>
                <td className="pl-3">
                  <input
                    value={String(v)}
                    onChange={(e) => setGot((g) => ({ ...g, [l.sku]: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 }))}
                    inputMode="decimal"
                    aria-label={`Received ${itemBySku(l.sku)?.name}`}
                    className={`${cell} ${v > l.qty ? 'border-coral' : v < l.qty ? 'border-amber' : ''}`}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shortBy > 0 && !bad && (
        <p className="rounded-xl bg-amber/15 px-3 py-2 text-[12px] text-ink">
          {shortBy} unit{shortBy === 1 ? '' : 's'} short. Only what arrived is added to stock; the shortfall is recorded on the transfer for follow-up.
        </p>
      )}
      {bad && <p className="text-[12px] text-coral">Received can&apos;t be more than was sent.</p>}
      <Actions onCancel={onCancel}>
        <Primary type="submit" disabled={bad}>
          Receive into stock
        </Primary>
      </Actions>
    </form>
  );
}
