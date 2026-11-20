'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ClipboardList, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { PageHead } from '@/components/AppShell';
import { errorMessage } from '@/lib/api/client';
import { can, currentMe, isLive } from '@/lib/live/session';
import { currentStoreId, live } from '@/lib/live/hydrate';
import { stores, useBranches } from '@/lib/branch-data';
import { api, newKey } from '@/lib/api/client';
import {
  ADJUSTMENT_REASON_LABEL,
  approveAdjustment,
  cancelAdjustment,
  cancelCount,
  createCount,
  getCount,
  listAdjustments,
  listCounts,
  postCount,
  qtyFmt,
  recordCount,
  rejectAdjustment,
  submitCount,
  type Adjustment,
  type AdjustmentStatus,
  type CountStatus,
  type CountSummary,
  type StockCount,
} from '@/lib/live/stockops';
import { reload } from '@/lib/live/hydrate';
import type { Product } from '@/lib/api/types';
import { ProductPicker } from '@/components/live/ProductPicker';
import { Badge, Blocked, Btn, Empty, ErrorLine, Loading, Modal, Tabs, fieldCls, fieldFixed, inr2, labelCls, whenFmt } from '@/components/live/kit';

type Tab = 'adjustments' | 'counts';

/** Stock corrections that wait for a manager, and full or partial stock takes. */
export function StockControlView() {
  const [tab, setTab] = useState<Tab>('adjustments');
  const allowed = isLive() && can('inventory:read');
  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageHead title="Stock control" sub="Approve stock corrections and run stock counts" />
      {!isLive() ? (
        <Blocked kind="offline" />
      ) : !allowed ? (
        <Blocked kind="denied" />
      ) : (
        <section className="card overflow-hidden">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              ['adjustments', 'Adjustments'],
              ['counts', 'Stock counts'],
            ]}
          />
          {tab === 'adjustments' ? <Adjustments /> : <Counts />}
        </section>
      )}
    </div>
  );
}

/* =================== adjustments =================== */

const adjStatus: Record<AdjustmentStatus, [string, 'amber' | 'teal' | 'coral' | 'mute']> = {
  PENDING_APPROVAL: ['Waiting for approval', 'amber'],
  POSTED: ['Posted', 'teal'],
  REJECTED: ['Rejected', 'coral'],
  CANCELLED: ['Cancelled', 'mute'],
};

function Adjustments() {
  const [filter, setFilter] = useState<AdjustmentStatus | ''>('PENDING_APPROVAL');
  const [rows, setRows] = useState<Adjustment[] | null>(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const me = currentMe()?.user.id;

  const load = useCallback(() => {
    setError('');
    listAdjustments(filter || undefined)
      .then((r) => setRows(r.data))
      .catch((e) => {
        setRows([]);
        setError(errorMessage(e));
      });
  }, [filter]);
  useEffect(load, [load]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex flex-wrap gap-1 rounded-xl bg-bg p-1">
          {(
            [
              ['PENDING_APPROVAL', 'Waiting'],
              ['POSTED', 'Posted'],
              ['REJECTED', 'Rejected'],
              ['', 'All'],
            ] as [AdjustmentStatus | '', string][]
          ).map(([k, l]) => (
            <button
              key={l}
              type="button"
              onClick={() => setFilter(k)}
              className={`h-8 rounded-lg px-3 text-sm font-semibold ${filter === k ? 'bg-surface text-ink shadow-sm' : 'text-sub hover:text-ink'}`}
            >
              {l}
            </button>
          ))}
        </div>
        {can('inventory:adjust') && (
          <Btn tone="primary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> New adjustment
          </Btn>
        )}
      </div>
      <div className="px-4 pt-3">
        <ErrorLine>{error}</ErrorLine>
      </div>
      {rows === null ? (
        <Loading />
      ) : !rows.length ? (
        <Empty>{filter === 'PENDING_APPROVAL' ? 'Nothing waiting for approval.' : 'No adjustments here.'}</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((a) => {
            const [label, tone] = adjStatus[a.status];
            const net = a.items.reduce((s, i) => s + Number(i.qty), 0);
            const open = openId === a.id;
            return (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : a.id)}
                  className="grid w-full grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 text-left text-sm hover:bg-bg/60 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_120px_150px_20px]"
                >
                  <div className="min-w-0">
                    <div className="font-semibold">{ADJUSTMENT_REASON_LABEL[a.reason] ?? a.reason}</div>
                    <div className="truncate text-xs text-mute">
                      {whenFmt(a.createdAt)} · {a.store.name}
                      {a.note && ` · ${a.note}`}
                    </div>
                  </div>
                  <div className="hidden truncate text-sub md:block">
                    {a.items.length} item{a.items.length === 1 ? '' : 's'} · {a.items.slice(0, 2).map((i) => i.product.name).join(', ')}
                    {a.items.length > 2 ? '…' : ''}
                  </div>
                  <div className={`hidden text-right font-semibold tabular-nums md:block ${net < 0 ? 'text-coral' : 'text-teal'}`}>
                    {net > 0 ? '+' : ''}
                    {qtyFmt(net)} units{a.value !== undefined && <div className="text-xs font-normal text-mute">{inr2(a.value)}</div>}
                  </div>
                  <span className="justify-self-start">
                    <Badge tone={tone}>{label}</Badge>
                  </span>
                  <ChevronDown className={`hidden size-4 text-mute transition md:block ${open ? 'rotate-180' : ''}`} />
                </button>
                {open && <AdjustmentDetail a={a} mine={a.createdByUserId === me} onChanged={load} />}
              </li>
            );
          })}
        </ul>
      )}
      {adding && (
        <NewAdjustment
          onClose={() => setAdding(false)}
          onSaved={(pending) => {
            setAdding(false);
            setFilter(pending ? 'PENDING_APPROVAL' : 'POSTED');
            load();
          }}
        />
      )}
    </div>
  );
}

function AdjustmentDetail({ a, mine, onChanged }: { a: Adjustment; mine: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<'approve' | 'reject' | 'cancel' | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const run = async (k: 'approve' | 'reject' | 'cancel') => {
    setBusy(k);
    setError('');
    try {
      if (k === 'approve') await approveAdjustment(a.id);
      else if (k === 'reject') await rejectAdjustment(a.id, reason.trim());
      else await cancelAdjustment(a.id);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };
  return (
    <div className="space-y-3 bg-bg/50 px-4 py-4 text-sm">
      <table className="w-full max-w-2xl text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-mute">
          <tr>
            <th className="py-1!">Product</th>
            <th className="py-1! text-right">Change</th>
            {a.value !== undefined && <th className="py-1! text-right">Cost / unit</th>}
          </tr>
        </thead>
        <tbody>
          {a.items.map((i) => (
            <tr key={i.id} className="border-t border-line">
              <td className="py-1.5!">
                {i.product.name} <span className="text-xs text-mute">{i.product.sku}</span>
              </td>
              <td className={`py-1.5! text-right font-semibold tabular-nums ${Number(i.qty) < 0 ? 'text-coral' : 'text-teal'}`}>
                {Number(i.qty) > 0 ? '+' : ''}
                {qtyFmt(i.qty)}
              </td>
              {a.value !== undefined && <td className="py-1.5! text-right tabular-nums text-sub">{i.unitCost ? inr2(i.unitCost) : '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {a.rejectionReason && <p className="text-coral">Rejected: “{a.rejectionReason}”</p>}
      {a.status === 'PENDING_APPROVAL' && (
        <div className="space-y-2">
          {rejecting && (
            <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Why is it rejected? (required)" className={`${fieldCls} max-w-md`} />
          )}
          <ErrorLine>{error}</ErrorLine>
          <div className="flex flex-wrap gap-2">
            {can('inventory:approve') && !rejecting && (
              <Btn tone="good" size="sm" busy={busy === 'approve'} onClick={() => void run('approve')}>
                Approve & post
              </Btn>
            )}
            {can('inventory:approve') &&
              (rejecting ? (
                <>
                  <Btn tone="danger" size="sm" disabled={!reason.trim()} busy={busy === 'reject'} onClick={() => void run('reject')}>
                    Reject
                  </Btn>
                  <Btn size="sm" onClick={() => setRejecting(false)}>
                    Back
                  </Btn>
                </>
              ) : (
                <Btn size="sm" onClick={() => setRejecting(true)}>
                  Reject…
                </Btn>
              ))}
            {mine && !rejecting && (
              <Btn size="sm" tone="quiet" busy={busy === 'cancel'} onClick={() => void run('cancel')}>
                Withdraw mine
              </Btn>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const NEW_REASONS = ['DAMAGE', 'EXPIRY', 'WASTAGE', 'THEFT', 'FOUND', 'COUNT_CORRECTION', 'OTHER'] as const;

function NewAdjustment({ onClose, onSaved }: { onClose: () => void; onSaved: (pending: boolean) => void }) {
  const branches = useBranches();
  const shops = stores(branches);
  const [storeId, setStoreId] = useState(currentStoreId() || shops[0]?.id || '');
  const [reason, setReason] = useState<(typeof NEW_REASONS)[number]>('DAMAGE');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<{ p: Product; qty: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const outgoing = reason !== 'FOUND';

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const sign = reason === 'FOUND' ? 1 : reason === 'COUNT_CORRECTION' || reason === 'OTHER' ? 1 : -1;
      const r = await api<{ status: string }>('POST', `/stores/${storeId}/stock-adjustments`, {
        idempotencyKey: newKey(),
        body: {
          reason,
          ...(note.trim() ? { note: note.trim() } : {}),
          items: lines.map((l) => ({ productId: l.p.id, qty: String(sign * Number(l.qty)) })),
        },
      });
      await reload();
      onSaved(r.status === 'PENDING_APPROVAL');
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const signed = reason === 'COUNT_CORRECTION' || reason === 'OTHER';
  const ok = storeId && lines.length > 0 && lines.every((l) => Number(l.qty) !== 0 && !Number.isNaN(Number(l.qty)));

  return (
    <Modal open onClose={onClose} wide title="New stock adjustment" sub="Write off damaged or expired stock, or correct a mistake. Big changes wait for a manager’s approval.">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={labelCls}>
            Reason
            <select value={reason} onChange={(e) => setReason(e.target.value as (typeof NEW_REASONS)[number])} className={`${fieldCls} mt-1`}>
              {NEW_REASONS.map((r) => (
                <option key={r} value={r}>
                  {ADJUSTMENT_REASON_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          {shops.length > 1 && (
            <label className={labelCls}>
              Branch
              <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={`${fieldCls} mt-1`}>
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className={`${labelCls} ${shops.length > 1 ? '' : 'sm:col-span-2'}`}>
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={`${fieldCls} mt-1`} placeholder="Optional" />
          </label>
        </div>
        <ProductPicker exclude={lines.map((l) => l.p.id)} onPick={(p) => setLines((ls) => [...ls, { p, qty: '1' }])} />
        {lines.length > 0 && (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {lines.map((l, i) => (
              <li key={l.p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {l.p.name} <span className="text-xs text-mute">{l.p.sku}</span>
                </span>
                <span className="text-xs text-sub">{signed ? 'Change (+ in / − out)' : outgoing ? 'Units out' : 'Units in'}</span>
                <input
                  value={l.qty}
                  inputMode="decimal"
                  onChange={(e) => {
                    const v = e.target.value.replace(signed ? /[^\d.-]/g : /[^\d.]/g, '');
                    setLines((ls) => ls.map((x, k) => (k === i ? { ...x, qty: v } : x)));
                  }}
                  className="h-9 w-24 rounded-lg border border-line bg-surface px-2 text-right tabular-nums outline-none focus:border-blue"
                  aria-label={`Quantity of ${l.p.name}`}
                />
                <span className="w-8 text-xs text-mute">{l.p.unit.code}</span>
                <button type="button" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))} className="text-mute hover:text-coral" aria-label="Remove">
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <ErrorLine>{error}</ErrorLine>
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn tone="primary" disabled={!ok} busy={busy} onClick={() => void save()}>
            Save adjustment
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

/* =================== counts =================== */

const countStatus: Record<CountStatus, [string, 'blue' | 'amber' | 'teal' | 'mute']> = {
  OPEN: ['Counting', 'blue'],
  SUBMITTED: ['Ready to post', 'amber'],
  POSTED: ['Posted', 'teal'],
  CANCELLED: ['Cancelled', 'mute'],
};

function Counts() {
  const [rows, setRows] = useState<CountSummary[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const load = useCallback(() => {
    listCounts()
      .then((r) => setRows(r.data))
      .catch((e) => {
        setRows([]);
        setError(errorMessage(e));
      });
  }, []);
  useEffect(load, [load]);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <p className="text-sm text-sub">Count what’s on the shelf; posting books the differences as stock corrections.</p>
        {can('inventory:adjust') && (
          <Btn tone="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New count
          </Btn>
        )}
      </div>
      <div className="px-4 pt-3">
        <ErrorLine>{error}</ErrorLine>
      </div>
      {rows === null ? (
        <Loading />
      ) : !rows.length ? (
        <Empty>No stock counts yet. Start one for a shelf, a category or the whole store.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((c) => {
            const [label, tone] = countStatus[c.status];
            return (
              <li key={c.id}>
                <button type="button" onClick={() => setOpenId(c.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-bg/60">
                  <span className="grid size-9 place-items-center rounded-xl bg-blue/10 text-blue">
                    <ClipboardList className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{c.name}</span>
                    <span className="block text-xs text-mute">
                      {c.store.name} · {c.lines} line{c.lines === 1 ? '' : 's'} · started {whenFmt(c.createdAt)}
                      {c.postedAt && ` · posted ${whenFmt(c.postedAt)}`}
                    </span>
                  </span>
                  <Badge tone={tone}>{label}</Badge>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {creating && (
        <NewCount
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            load();
            setOpenId(id);
          }}
        />
      )}
      {openId && <CountSheet id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

function NewCount({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const branches = useBranches();
  const shops = stores(branches);
  const [storeId, setStoreId] = useState(currentStoreId() || shops[0]?.id || '');
  const [categoryId, setCategoryId] = useState('');
  const cats = live.categories.filter((c) => c.isActive);
  const catName = cats.find((c) => c.id === categoryId)?.path.join(' › ');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const auto = `${catName ?? 'Full count'} · ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
  return (
    <Modal open onClose={onClose} title="New stock count" sub="The expected quantities are frozen now — keep selling while you count.">
      <div className="space-y-3">
        <label className={labelCls}>
          What to count
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={`${fieldCls} mt-1`}>
            <option value="">Everything in stock</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.path.join(' › ')}
              </option>
            ))}
          </select>
        </label>
        {shops.length > 1 && (
          <label className={labelCls}>
            Branch
            <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={`${fieldCls} mt-1`}>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={labelCls}>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={auto} className={`${fieldCls} mt-1`} />
        </label>
        <ErrorLine>{error}</ErrorLine>
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn
            tone="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const c = await createCount(storeId, name.trim() || auto, categoryId || undefined);
                onCreated(c.id);
              } catch (e) {
                setError(errorMessage(e));
                setBusy(false);
              }
            }}
          >
            Start count
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

function CountSheet({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [c, setC] = useState<StockCount | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [blind, setBlind] = useState(true);
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    getCount(id)
      .then((x) => {
        setC(x);
        setEdits({});
      })
      .catch((e) => setError(errorMessage(e)));
  }, [id]);
  useEffect(load, [load]);

  const key = (l: { product: { id: string }; batchId: string | null }) => `${l.product.id}:${l.batchId ?? ''}`;
  const editable = c?.status === 'OPEN';
  const lines = useMemo(() => {
    if (!c) return [];
    const s = q.trim().toLowerCase();
    return c.items.filter(
      (l) =>
        (!s || l.product.name.toLowerCase().includes(s) || l.product.sku.toLowerCase().includes(s)) &&
        (!onlyDiff || (l.difference !== null && Number(l.difference) !== 0))
    );
  }, [c, q, onlyDiff]);
  const dirty = Object.keys(edits).length;

  const saveCounts = async () => {
    if (!c) return;
    const items = Object.entries(edits)
      .filter(([, v]) => v.trim() !== '' && !Number.isNaN(Number(v)))
      .map(([k, v]) => {
        const [productId, batchId] = k.split(':');
        return { productId: productId!, batchId: batchId || null, countedQty: Number(v) };
      });
    for (let i = 0; i < items.length; i += 500) await recordCount(c.id, items.slice(i, i + 500));
  };

  const act = async (k: 'save' | 'submit' | 'post' | 'cancel') => {
    if (!c) return;
    if (k === 'cancel' && !window.confirm('Cancel this count? Nothing is changed in stock.')) return;
    setBusy(k);
    setError('');
    setMsg('');
    try {
      if (dirty && k !== 'cancel') await saveCounts();
      if (k === 'submit') await submitCount(c.id);
      if (k === 'post') {
        const r = await postCount(c.id);
        setMsg(`Posted — ${r.summary.differences} difference${r.summary.differences === 1 ? '' : 's'} booked to stock.`);
      }
      if (k === 'cancel') await cancelCount(c.id);
      if (k === 'save') setMsg('Counts saved.');
      load();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open onClose={onClose} wide title={c?.name ?? 'Stock count'} sub={c ? `${c.store.name} · ${countStatus[c.status][0]}` : undefined}>
      {!c ? (
        error ? <ErrorLine>{error}</ErrorLine> : <Loading />
      ) : (
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Mini label="Lines" value={String(c.summary.lines)} />
            <Mini label="Counted" value={`${c.summary.counted} of ${c.summary.lines}`} />
            <Mini label="Differences" value={String(c.summary.differences)} tone={c.summary.differences ? 'text-amber' : ''} />
            {c.summary.varianceValue !== undefined && <Mini label="Difference value" value={inr2(c.summary.varianceValue)} />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find product or SKU" className={`${fieldFixed} h-9 max-w-xs`} />
            <Btn size="sm" tone="quiet" onClick={() => setBlind((b) => !b)}>
              {blind ? <Eye className="size-4" /> : <EyeOff className="size-4" />} {blind ? 'Show expected' : 'Hide expected'}
            </Btn>
            <label className="flex items-center gap-1.5 text-xs text-sub">
              <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} className="accent-[var(--blue)]" /> Only differences
            </label>
          </div>
          <div className="max-h-[50vh] overflow-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface text-left text-xs uppercase tracking-wide text-mute">
                <tr>
                  <th className="px-3! py-2!">Product</th>
                  {!blind && <th className="px-3! py-2! text-right">Expected</th>}
                  <th className="px-3! py-2! text-right">Counted</th>
                  {!blind && <th className="px-3! py-2! text-right">Difference</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {lines.map((l) => {
                  const k = key(l);
                  const v = edits[k] ?? (l.countedQty !== null ? String(Number(l.countedQty)) : '');
                  const diff = v !== '' ? Number(v) - Number(l.systemQty) : null;
                  return (
                    <tr key={l.id}>
                      <td className="px-3! py-2!">
                        <div className="font-medium">{l.product.name}</div>
                        <div className="text-xs text-mute">
                          {l.product.sku}
                          {l.batchNo && ` · batch ${l.batchNo}`}
                        </div>
                      </td>
                      {!blind && <td className="px-3! py-2! text-right tabular-nums text-sub">{qtyFmt(l.systemQty)}</td>}
                      <td className="px-3! py-2! text-right">
                        {editable ? (
                          <input
                            value={v}
                            inputMode="decimal"
                            onChange={(e) => setEdits((s) => ({ ...s, [k]: e.target.value.replace(/[^\d.]/g, '') }))}
                            aria-label={`Counted ${l.product.name}`}
                            placeholder="—"
                            className="h-8 w-20 rounded-lg border border-line bg-surface px-2 text-right tabular-nums outline-none focus:border-blue"
                          />
                        ) : (
                          <span className="tabular-nums">{l.countedQty !== null ? qtyFmt(l.countedQty) : '—'}</span>
                        )}
                      </td>
                      {!blind && (
                        <td className={`px-3! py-2! text-right font-semibold tabular-nums ${diff ? (diff < 0 ? 'text-coral' : 'text-teal') : 'text-mute'}`}>
                          {diff === null ? '—' : `${diff > 0 ? '+' : ''}${qtyFmt(diff)}`}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {!lines.length && (
                  <tr>
                    <td colSpan={4} className="px-3! py-6! text-center text-sub">
                      No lines match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {c.summary.uncounted > 0 && c.status !== 'POSTED' && (
            <p className="text-xs text-mute">Lines left blank are not changed when the count is posted.</p>
          )}
          {msg && <p className="rounded-xl bg-teal/10 px-3 py-2 text-teal">{msg}</p>}
          <ErrorLine>{error}</ErrorLine>
          <div className="flex flex-wrap justify-end gap-2">
            {(c.status === 'OPEN' || c.status === 'SUBMITTED') && can('inventory:adjust') && (
              <Btn tone="quiet" busy={busy === 'cancel'} onClick={() => void act('cancel')}>
                Cancel count
              </Btn>
            )}
            {editable && (
              <Btn busy={busy === 'save'} disabled={!dirty} onClick={() => void act('save')}>
                Save counts{dirty ? ` (${dirty})` : ''}
              </Btn>
            )}
            {editable && !can('inventory:approve') && (
              <Btn tone="primary" busy={busy === 'submit'} onClick={() => void act('submit')}>
                Send for posting
              </Btn>
            )}
            {(c.status === 'OPEN' || c.status === 'SUBMITTED') && can('inventory:approve') && (
              <Btn tone="good" busy={busy === 'post'} onClick={() => void act('post')}>
                Post to stock
              </Btn>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Mini({ label, value, tone = '' }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl bg-bg px-3 py-2">
      <div className="text-[11px] text-mute">{label}</div>
      <div className={`font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}
