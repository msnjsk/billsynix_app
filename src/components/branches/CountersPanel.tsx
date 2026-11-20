'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, LoaderCircle, Monitor, Pencil, Plus, Power, X } from 'lucide-react';
import { api, errorMessage } from '@/lib/api/client';
import type { Counter } from '@/lib/api/types';
import { can } from '@/lib/live/session';

type Device = { id: string; counterId: string; name: string; lastSeenAt: string | null; status: 'ACTIVE' | 'REVOKED'; createdAt: string };

/**
 * Billing counters of a branch and the POS computers registered to them (connected mode).
 * Counter numbers 1–9 are part of the invoice series (e.g. ANR1/2627/00042), so a number is never
 * reused for another counter; a counter is disabled rather than deleted.
 */
export function CountersPanel({ storeId, storeCode, notify }: { storeId: string; storeCode: string; notify: (text: string, bad?: boolean) => void }) {
  const [counters, setCounters] = useState<Counter[] | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [registering, setRegistering] = useState<{ counterId: string; name: string } | null>(null);
  const [issuedKey, setIssuedKey] = useState<{ device: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = can('counters:manage');
  const register = can('devices:register');

  const load = useCallback(async () => {
    try {
      const [c, d] = await Promise.all([
        api<{ data: Counter[] }>('GET', `/stores/${storeId}/counters`),
        register ? api<{ data: Device[] }>('GET', `/stores/${storeId}/devices`) : Promise.resolve({ data: [] as Device[] }),
      ]);
      setCounters(c.data);
      setDevices(d.data);
    } catch (e) {
      notify(errorMessage(e), true);
      setCounters([]);
    }
  }, [storeId, register, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      notify(done);
      await load();
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  };

  const addCounter = () => {
    const name = newName.trim() || `Counter ${(counters?.length ?? 0) + 1}`;
    void run(() => api('POST', `/stores/${storeId}/counters`, { body: { name } }), `${name} added`).then(() => setNewName(''));
  };

  const registerDevice = async () => {
    if (!registering) return;
    setBusy(true);
    try {
      const r = await api<{ device: Device; deviceKey: string }>('POST', `/counters/${registering.counterId}/devices`, {
        body: { name: registering.name.trim() || 'POS computer' },
      });
      setIssuedKey({ device: r.device.name, key: r.deviceKey });
      setRegistering(null);
      await load();
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  };

  const field = 'h-9 rounded-xl border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-blue';

  if (!counters)
    return (
      <div className="flex items-center gap-2 py-8 text-sub">
        <LoaderCircle className="size-4 animate-spin" /> Loading counters…
      </div>
    );

  return (
    <div className="space-y-4 text-[13px]">
      {issuedKey && (
        <div role="status" className="rounded-xl border border-amber/40 bg-amber/10 p-3">
          <p className="font-bold text-ink">
            <KeyRound className="mr-1 inline size-4 text-amber" /> Device key for “{issuedKey.device}” — shown only once
          </p>
          <p className="mt-1 text-sub">Enter it in the POS app on that computer. It can’t be shown again; if it’s lost, revoke the device and register it again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-2 py-1.5 font-mono text-[12px] text-ink">{issuedKey.key}</code>
            <button
              onClick={() => void navigator.clipboard?.writeText(issuedKey.key).then(() => notify('Device key copied'))}
              className="flex h-8 items-center gap-1 rounded-lg border border-line px-2.5 font-semibold text-ink hover:border-blue"
            >
              <Copy className="size-3.5" /> Copy
            </button>
            <button onClick={() => setIssuedKey(null)} aria-label="Dismiss" className="grid size-8 place-items-center rounded-lg text-mute hover:text-ink">
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      {counters.length === 0 && <p className="rounded-xl bg-bg p-3 text-sub">No counters yet — add one to start billing at this branch.</p>}

      <ul className="divide-y divide-line rounded-xl border border-line">
        {counters.map((c) => {
          const mine = devices.filter((d) => d.counterId === c.id);
          const active = c.status === 'ACTIVE';
          return (
            <li key={c.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid size-8 place-items-center rounded-lg bg-blue/10 font-extrabold text-blue">{c.number}</span>
                {editing?.id === c.id ? (
                  <input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className={`${field} w-44`} maxLength={40} />
                ) : (
                  <span className="font-bold text-ink">{c.name}</span>
                )}
                <span className="font-mono text-[11.5px] text-mute">
                  {storeCode}
                  {c.number}/…
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${active ? 'bg-teal/15 text-teal' : 'bg-line text-sub'}`}>{active ? 'Active' : 'Disabled'}</span>
                <span className="ml-auto flex gap-1.5">
                  {manage &&
                    (editing?.id === c.id ? (
                      <button
                        disabled={busy || !editing.name.trim()}
                        onClick={() => void run(() => api('PATCH', `/counters/${c.id}`, { body: { name: editing.name.trim() } }), 'Counter renamed').then(() => setEditing(null))}
                        className="flex h-8 items-center gap-1 rounded-lg gbv px-2.5 font-semibold text-onbrand disabled:opacity-60"
                      >
                        <Check className="size-3.5" /> Save
                      </button>
                    ) : (
                      <button onClick={() => setEditing({ id: c.id, name: c.name })} className="flex h-8 items-center gap-1 rounded-lg border border-line px-2.5 font-semibold text-ink hover:border-blue">
                        <Pencil className="size-3.5" /> Rename
                      </button>
                    ))}
                  {manage && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (active && !window.confirm(`Disable ${c.name}? Its registered devices are signed out and revoked.`)) return;
                        void run(() => api('PATCH', `/counters/${c.id}`, { body: { status: active ? 'DISABLED' : 'ACTIVE' } }), active ? `${c.name} disabled` : `${c.name} enabled`);
                      }}
                      className="flex h-8 items-center gap-1 rounded-lg border border-line px-2.5 font-semibold text-ink hover:border-coral disabled:opacity-60"
                    >
                      <Power className="size-3.5" /> {active ? 'Disable' : 'Enable'}
                    </button>
                  )}
                </span>
              </div>

              {register && (
                <div className="ml-10 space-y-1.5">
                  {mine.map((d) => (
                    <div key={d.id} className="flex items-center gap-2 text-[12.5px]">
                      <Monitor className="size-3.5 text-mute" />
                      <span className={d.status === 'ACTIVE' ? 'font-semibold text-ink' : 'text-mute line-through'}>{d.name}</span>
                      <span className="text-mute">
                        {d.status === 'REVOKED' ? 'revoked' : d.lastSeenAt ? `last used ${new Date(d.lastSeenAt).toLocaleString('en-IN')}` : 'not used yet'}
                      </span>
                      {d.status === 'ACTIVE' && (
                        <button
                          disabled={busy}
                          onClick={() => {
                            if (!window.confirm(`Revoke ${d.name}? It is signed out at once and can’t bill until registered again.`)) return;
                            void run(() => api('POST', `/devices/${d.id}/revoke`), `${d.name} revoked`);
                          }}
                          className="ml-auto text-[12px] font-semibold text-coral hover:underline"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                  {active &&
                    (registering?.counterId === c.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input autoFocus placeholder="Computer name, e.g. Till 1" value={registering.name} onChange={(e) => setRegistering({ ...registering, name: e.target.value })} className={`${field} w-52`} maxLength={60} />
                        <button disabled={busy} onClick={() => void registerDevice()} className="flex h-8 items-center gap-1 rounded-lg gbv px-2.5 font-semibold text-onbrand disabled:opacity-60">
                          <KeyRound className="size-3.5" /> Register
                        </button>
                        <button onClick={() => setRegistering(null)} className="h-8 px-2 font-semibold text-sub hover:text-ink">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button onClick={() => setRegistering({ counterId: c.id, name: '' })} className="flex items-center gap-1 text-[12.5px] font-semibold text-blue hover:underline">
                        <Plus className="size-3.5" /> Register a POS computer
                      </button>
                    ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {manage && counters.length < 9 && (
        <div className="flex flex-wrap items-center gap-2">
          <input placeholder={`Counter ${counters.length + 1}`} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addCounter()} className={`${field} w-56`} maxLength={40} />
          <button disabled={busy} onClick={addCounter} className="flex h-9 items-center gap-1.5 rounded-xl gbv px-3.5 font-semibold text-onbrand shadow-md shadow-blue/20 disabled:opacity-60">
            <Plus className="size-4" /> Add counter
          </button>
          <span className="text-[12px] text-mute">Up to 9 per branch — the number is part of each invoice number.</span>
        </div>
      )}
    </div>
  );
}
