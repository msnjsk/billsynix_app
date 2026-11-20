'use client';

/**
 * Offline POS (Phase 9) at the counter: a header chip showing whether this counter is online and
 * how many bills are waiting, and a panel listing them — including any the server refused, which
 * stay here (and on the server) until a manager deals with them — plus this computer's
 * registration as a counter.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  CloudOff,
  CloudUpload,
  LoaderCircle,
  MonitorSmartphone,
  RefreshCw,
  TriangleAlert,
  Wifi,
} from 'lucide-react';
import { errorMessage } from '@/lib/api/client';
import { live } from '@/lib/live/hydrate';
import { can, currentMe } from '@/lib/live/session';
import {
  deviceInfo,
  forgetThisDevice,
  getDeviceKey,
  registerThisDevice,
  type DeviceInfo,
} from '@/lib/offline/device';
import { syncNow } from '@/lib/offline/engine';
import { queueRows, useSyncStatus } from '@/lib/offline/outbox';
import type { OutboxRow } from '@/lib/offline/db';

const ago = (iso: string | null) => {
  if (!iso) return '—';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min ago` : `${Math.floor(h / 24)} d ago`;
};

/** The header chip. Shown only on a registered counter (cashier PIN session). */
export function SyncChip({ onOpen }: { onOpen: () => void }) {
  const s = useSyncStatus();
  if (!currentMe()?.session.device) return null;
  const tone = s.failed
    ? 'bg-coral/15 text-coral'
    : !s.online
      ? 'bg-amber/15 text-amber'
      : s.pending
        ? 'bg-blue/15 text-blue'
        : 'bg-teal/15 text-teal';
  const Icon = !s.online
    ? CloudOff
    : s.syncing
      ? LoaderCircle
      : s.pending
        ? CloudUpload
        : Wifi;
  const text = !s.online
    ? `Offline${s.pending ? ` · ${s.pending} to send` : ''}`
    : s.failed
      ? `${s.failed} refused`
      : s.pending
        ? `${s.pending} to send`
        : 'Online';
  return (
    <button
      onClick={onOpen}
      title={s.lastError ?? 'Offline billing and sync'}
      className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[11px] font-semibold ${tone}`}
    >
      <Icon className={`size-3.5 ${s.syncing ? 'animate-spin' : ''}`} />
      {text}
    </button>
  );
}

const STATUS: Record<OutboxRow['status'], string> = {
  pending: 'Waiting',
  failed: 'Refused',
  synced: 'Sent',
  discarded: 'Discarded',
};

/** The sync panel (opened from the chip or POS settings). */
export function SyncPanel({ storeId }: { storeId: string }) {
  const s = useSyncStatus();
  const [rows, setRows] = useState<OutboxRow[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void queueRows().then(setRows);
  }, []);
  useEffect(load, [load, s.pending, s.failed]);

  const sync = async () => {
    setBusy(true);
    await syncNow().catch(() => undefined);
    setBusy(false);
    load();
  };

  return (
    <div className="space-y-4 text-[13px]">
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="Connection"
          value={s.online ? 'Online' : 'Offline'}
          tone={s.online ? 'text-teal' : 'text-amber'}
        />
        <Stat
          label="Waiting to send"
          value={String(s.pending)}
          hint={
            s.oldestPendingAt ? `oldest ${ago(s.oldestPendingAt)}` : undefined
          }
        />
        <Stat
          label="Refused"
          value={String(s.failed)}
          tone={s.failed ? 'text-coral' : undefined}
        />
      </div>
      {s.lastError && (
        <p className="rounded-lg bg-amber/10 px-3 py-2 text-[12px] text-amber">
          {s.lastError}
        </p>
      )}
      {s.failed > 0 && (
        <p className="flex gap-2 rounded-lg bg-coral/10 px-3 py-2 text-[12px] text-coral">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          The server refused these bills. They are kept here and on the server —
          a manager re-runs or discards them (Sync issues). Don&apos;t bill them
          again.
        </p>
      )}
      <div className="max-h-[260px] overflow-auto rounded-xl border border-line">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-mute">
            Nothing waiting — every bill from this counter is on the server.
          </p>
        ) : (
          <table className="w-full text-left text-[12px]">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-semibold tabular-nums">{r.label}</div>
                    {r.lastError && (
                      <div className="text-coral">{r.lastError.message}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-mute">{ago(r.createdAt)}</td>
                  <td
                    className={`px-3 py-2 text-right font-semibold ${r.status === 'failed' ? 'text-coral' : 'text-sub'}`}
                  >
                    {STATUS[r.status]}
                    {r.status === 'pending' && r.attempts > 0 && (
                      <span className="block text-[11px] font-normal text-mute">
                        tried {r.attempts}×
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-mute">
          Last sent {ago(s.lastSyncAt)}
        </span>
        <button
          type="button"
          onClick={sync}
          disabled={busy}
          className="flex h-9 items-center gap-2 rounded-lg bg-blue px-4 font-semibold text-onbrand disabled:opacity-60"
        >
          <RefreshCw className={`size-4 ${busy ? 'animate-spin' : ''}`} /> Sync
          now
        </button>
      </div>
      <DeviceSection storeId={storeId} />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  tone?: string | undefined;
}) {
  return (
    <div className="rounded-xl bg-bg px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-mute">
        {label}
      </div>
      <div
        className={`text-[18px] font-extrabold tabular-nums ${tone ?? 'text-ink'}`}
      >
        {value}
      </div>
      {hint && <div className="text-[11px] text-mute">{hint}</div>}
    </div>
  );
}

/** This computer as a counter: registered (and to which counter), or register it (managers). */
function DeviceSection({ storeId }: { storeId: string }) {
  const [state, setState] = useState<'loading' | 'none' | DeviceInfo>(
    'loading'
  );
  const [counterId, setCounterId] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const counters = live.counters.filter(
    (c) => c.storeId === storeId && c.status === 'ACTIVE'
  );

  useEffect(() => {
    void (async () => {
      if (!(await getDeviceKey())) return setState('none');
      setState((await deviceInfo().catch(() => null)) ?? 'none');
    })();
  }, []);

  const register = async () => {
    setMsg(null);
    try {
      await registerThisDevice(
        counterId || counters[0]!.id,
        name.trim() || 'Counter PC'
      );
      setState((await deviceInfo()) ?? 'none');
      setMsg(
        'Registered. Cashiers can now sign in here with their PIN, and this counter can bill offline.'
      );
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };
  const forget = async () => {
    setMsg(null);
    try {
      await forgetThisDevice();
      setState('none');
      setMsg(
        'This computer is no longer a counter. Revoke it on the server too (Branches → devices).'
      );
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };

  return (
    <div className="rounded-xl border border-line p-3">
      <div className="mb-2 flex items-center gap-2 font-bold text-ink">
        <MonitorSmartphone className="size-4 text-blue" /> This computer
      </div>
      {state === 'loading' ? (
        <p className="text-mute">Checking…</p>
      ) : state !== 'none' ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sub">
            Registered as <b className="text-ink">{state.device.name}</b> on{' '}
            {state.counter.name}, {state.store.name}. Bills here keep working
            without a connection.
          </span>
          {can('devices:register') && (
            <button
              type="button"
              onClick={forget}
              className="shrink-0 text-[12px] font-semibold text-coral"
            >
              Stop using as counter
            </button>
          )}
        </div>
      ) : can('devices:register') && counters.length ? (
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <select
            value={counterId || counters[0]!.id}
            onChange={(e) => setCounterId(e.target.value)}
            className="h-9 rounded-lg border border-line bg-surface px-2"
          >
            {counters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name, e.g. Till 1 PC"
            className="h-9 rounded-lg border border-line bg-surface px-2"
          />
          <button
            type="button"
            onClick={register}
            className="h-9 rounded-lg border border-blue px-3 font-semibold text-blue"
          >
            Register as counter
          </button>
        </div>
      ) : (
        <p className="text-mute">
          Not registered as a counter. A manager can register it here, so
          cashiers sign in with a PIN and billing works offline.
        </p>
      )}
      {msg && <p className="mt-2 text-[12px] text-sub">{msg}</p>}
    </div>
  );
}
