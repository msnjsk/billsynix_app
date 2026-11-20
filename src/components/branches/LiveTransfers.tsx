'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Plus, Trash2, Truck } from 'lucide-react';
import { errorMessage } from '@/lib/api/client';
import { can } from '@/lib/live/session';
import { currentStoreId, live } from '@/lib/live/hydrate';
import { useBranches } from '@/lib/branch-data';
import type { Product } from '@/lib/api/types';
import {
  cancelTransfer,
  createTransfer,
  dispatchTransfer,
  listTransfers,
  qtyFmt,
  receiveTransfer,
  type Transfer,
  type TransferStatus,
} from '@/lib/live/stockops';
import { ProductPicker } from '@/components/live/ProductPicker';
import { Badge, Btn, Empty, ErrorLine, Loading, Modal, fieldCls, inr2, labelCls, whenFmt } from '@/components/live/kit';

const statusOf: Record<TransferStatus, [string, 'blue' | 'amber' | 'teal' | 'mute']> = {
  REQUESTED: ['Requested', 'blue'],
  IN_TRANSIT: ['On the way', 'amber'],
  RECEIVED: ['Received', 'teal'],
  CANCELLED: ['Cancelled', 'mute'],
};

/** Opens the new-transfer form, e.g. from a suggested transfer (lines by SKU). */
export type TransferStart = { from?: string | undefined; to?: string | undefined; lines?: { sku: string; qty: number }[] | undefined; key: number };

/** Stock moved between branches and warehouses, as the server records it (connected mode). */
export function LiveTransfers({ start = null }: { start?: TransferStart | null }) {
  const branches = useBranches();
  const places = branches.branches.filter((b) => b.active);
  const [filter, setFilter] = useState<TransferStatus | ''>('');
  const [rows, setRows] = useState<Transfer[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState<TransferStart | null>(null);
  useEffect(() => {
    if (start) setCreating(start);
  }, [start]);
  const [receiving, setReceiving] = useState<Transfer | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setError('');
    listTransfers(filter || undefined)
      .then((r) => setRows(r.data))
      .catch((e) => {
        setRows([]);
        setError(errorMessage(e));
      });
  }, [filter]);
  useEffect(load, [load]);

  const act = async (t: Transfer, k: 'dispatch' | 'cancel') => {
    if (k === 'cancel' && !window.confirm('Cancel this transfer?')) return;
    setBusy(`${t.id}:${k}`);
    setError('');
    try {
      if (k === 'dispatch') await dispatchTransfer(t.id);
      else await cancelTransfer(t.id);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (places.length < 2)
    return (
      <div className="card">
        <Empty>Add a second branch or a warehouse to move stock between them.</Empty>
      </div>
    );

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex flex-wrap gap-1 rounded-xl bg-bg p-1">
          {(
            [
              ['', 'All'],
              ['REQUESTED', 'Requested'],
              ['IN_TRANSIT', 'On the way'],
              ['RECEIVED', 'Received'],
            ] as [TransferStatus | '', string][]
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
        {can('transfers:request') && (
          <Btn tone="primary" size="sm" onClick={() => setCreating({ key: Date.now() })}>
            <Plus className="size-4" /> New transfer
          </Btn>
        )}
      </div>
      <div className="px-4 pt-3">
        <ErrorLine>{error}</ErrorLine>
      </div>
      {rows === null ? (
        <Loading />
      ) : !rows.length ? (
        <Empty>No transfers here.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((t) => {
            const [label, tone] = statusOf[t.status];
            const units = t.items.reduce((s, i) => s + Number(i.dispatchedQty ?? i.requestedQty), 0);
            const lost = t.items.reduce((s, i) => s + Number(i.lostQty ?? 0), 0);
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="grid size-9 place-items-center rounded-xl bg-blue/10 text-blue">
                  <Truck className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                    {t.fromStore.name} <ArrowRight className="size-3.5 text-mute" /> {t.toStore.name}
                  </div>
                  <div className="truncate text-xs text-mute">
                    {whenFmt(t.createdAt)} · {t.items.length} product{t.items.length === 1 ? '' : 's'}, {qtyFmt(units)} units
                    {t.dispatchedValue && ` · ${inr2(t.dispatchedValue)}`}
                    {lost > 0 && <span className="text-coral"> · {qtyFmt(lost)} short on arrival</span>}
                    {t.note && ` · ${t.note}`}
                  </div>
                  {t.crossGstin && t.status !== 'CANCELLED' && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-amber">
                      <AlertTriangle className="size-3.5" /> Different GSTINs — this is a taxable supply: issue a tax invoice (and e-way bill above ₹50,000).
                    </div>
                  )}
                </div>
                <Badge tone={tone}>{label}</Badge>
                <div className="flex gap-2">
                  {t.status === 'REQUESTED' && can('transfers:dispatch') && (
                    <Btn size="sm" tone="primary" busy={busy === `${t.id}:dispatch`} onClick={() => void act(t, 'dispatch')}>
                      Dispatch
                    </Btn>
                  )}
                  {t.status === 'IN_TRANSIT' && can('transfers:receive') && (
                    <Btn size="sm" tone="good" onClick={() => setReceiving(t)}>
                      Receive
                    </Btn>
                  )}
                  {t.status === 'REQUESTED' && can('transfers:request') && (
                    <Btn size="sm" tone="quiet" busy={busy === `${t.id}:cancel`} onClick={() => void act(t, 'cancel')}>
                      Cancel
                    </Btn>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {creating && (
        <NewTransfer
          places={places.map((p) => ({ id: p.id, name: p.name, kind: p.kind }))}
          start={creating}
          onClose={() => setCreating(null)}
          onSaved={() => {
            setCreating(null);
            setFilter('');
            load();
          }}
        />
      )}
      {receiving && (
        <Receive
          t={receiving}
          onClose={() => setReceiving(null)}
          onDone={() => {
            setReceiving(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function NewTransfer({
  places,
  start,
  onClose,
  onSaved,
}: {
  places: { id: string; name: string; kind: string }[];
  start: TransferStart;
  onClose: () => void;
  onSaved: () => void;
}) {
  const here = currentStoreId();
  const [from, setFrom] = useState(start.from ?? places.find((p) => p.kind === 'warehouse')?.id ?? places.find((p) => p.id !== here)?.id ?? places[0]!.id);
  const [to, setTo] = useState(start.to ?? places.find((p) => p.id !== from)?.id ?? '');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<{ p: Product; qty: string }[]>(() =>
    (start.lines ?? []).flatMap((l) => {
      const p = live.products.get(l.sku);
      return p ? [{ p, qty: String(l.qty) }] : [];
    })
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ok = from && to && from !== to && lines.length > 0 && lines.every((l) => Number(l.qty) > 0);

  return (
    <Modal open onClose={onClose} wide title="New stock transfer" sub="Request stock to move between branches. The sending branch dispatches it; the receiving branch confirms what arrived.">
      <div className="space-y-3">
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <label className={labelCls}>
            From
            <select
              value={from}
              onChange={(e) => {
                const f = e.target.value;
                setFrom(f);
                if (to === f || !to) setTo(places.find((p) => p.id !== f)?.id ?? '');
              }}
              className={`${fieldCls} mt-1`}
            >
              {places.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <ArrowRight className="mb-3 hidden size-4 text-mute sm:block" />
          <label className={labelCls}>
            To
            <select value={to} onChange={(e) => setTo(e.target.value)} className={`${fieldCls} mt-1`}>
              {places
                .filter((p) => p.id !== from)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
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
                <input
                  value={l.qty}
                  inputMode="decimal"
                  onChange={(e) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, qty: e.target.value.replace(/[^\d.]/g, '') } : x)))}
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
        <label className={labelCls}>
          Note
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={`${fieldCls} mt-1`} placeholder="Optional — e.g. for the weekend rush" />
        </label>
        <ErrorLine>{error}</ErrorLine>
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn
            tone="primary"
            disabled={!ok}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await createTransfer(
                  from,
                  to,
                  lines.map((l) => ({ productId: l.p.id, qty: Number(l.qty) })),
                  note
                );
                onSaved();
              } catch (e) {
                setError(errorMessage(e));
                setBusy(false);
              }
            }}
          >
            Request transfer
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

function Receive({ t, onClose, onDone }: { t: Transfer; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(t.items.map((i) => [i.id, String(Number(i.dispatchedQty ?? 0))])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const short = t.items.some((i) => Number(qty[i.id] ?? 0) < Number(i.dispatchedQty ?? 0));
  return (
    <Modal open onClose={onClose} wide title={`Receive from ${t.fromStore.name}`} sub="Check what arrived. Anything short is booked as lost in transit.">
      <div className="space-y-3 text-sm">
        <ul className="divide-y divide-line rounded-xl border border-line">
          {t.items.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{i.product.name}</span>
                <span className="text-xs text-mute">
                  Sent {qtyFmt(i.dispatchedQty)}
                  {i.batch && ` · batch ${i.batch.batchNo}`}
                </span>
              </span>
              <span className="text-xs text-sub">Arrived</span>
              <input
                value={qty[i.id] ?? ''}
                inputMode="decimal"
                onChange={(e) => setQty((s) => ({ ...s, [i.id]: e.target.value.replace(/[^\d.]/g, '') }))}
                className="h-9 w-24 rounded-lg border border-line bg-surface px-2 text-right tabular-nums outline-none focus:border-blue"
                aria-label={`Arrived ${i.product.name}`}
              />
            </li>
          ))}
        </ul>
        {short && <p className="text-amber">Some items are short — the difference will be written off as lost in transit.</p>}
        <ErrorLine>{error}</ErrorLine>
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn
            tone="good"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await receiveTransfer(t.id, short ? t.items.map((i) => ({ itemId: i.id, receivedQty: Number(qty[i.id] || 0) })) : undefined);
                onDone();
              } catch (e) {
                setError(errorMessage(e));
                setBusy(false);
              }
            }}
          >
            Confirm received
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
