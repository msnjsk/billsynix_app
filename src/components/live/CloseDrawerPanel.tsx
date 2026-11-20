'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, Clock3, Loader2, LogOut, TriangleAlert, Wallet } from 'lucide-react';
import { errorMessage } from '@/lib/api/client';
import { DENOMINATIONS, cashMovement, closeDrawer, myDrawer, rupees, type Drawer } from '@/lib/live/shift';

const n = (v: string | number | null | undefined) => Number(v ?? 0);
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

/**
 * End of shift for the signed-in cashier: what the drawer should hold, cash put in or taken out,
 * counting the notes, and closing it. A large difference waits for a manager to sign it off.
 */
export function CloseDrawerPanel({ onClose, onSignOut }: { onClose: () => void; onSignOut: () => void }) {
  const [drawer, setDrawer] = useState<Drawer | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [closed, setClosed] = useState<Drawer | null>(null);

  const load = useCallback(() => {
    myDrawer()
      .then(setDrawer)
      .catch((e) => {
        setDrawer(null);
        setError(errorMessage(e));
      });
  }, []);
  useEffect(load, [load]);

  if (closed) return <Closed d={closed} onDone={onClose} onSignOut={onSignOut} />;
  if (drawer === undefined)
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sub">
        <Loader2 className="size-5 animate-spin" aria-hidden="true" /> Loading your drawer…
      </div>
    );
  if (!drawer)
    return (
      <div className="space-y-4 py-6 text-center text-[13px]">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-bg text-sub">
          <Wallet className="size-6" aria-hidden="true" />
        </span>
        <p className="text-sub">{error || 'You don’t have a cash drawer open. One opens with your first bill of the shift.'}</p>
        <button type="button" onClick={onClose} className="h-10 rounded-xl border border-line px-4 font-semibold hover:bg-bg">
          OK
        </button>
      </div>
    );
  return <Count d={drawer} onChanged={load} onClosed={setClosed} onCancel={onClose} />;
}

function Count({ d, onChanged, onClosed, onCancel }: { d: Drawer; onChanged: () => void; onClosed: (d: Drawer) => void; onCancel: () => void }) {
  const [notes, setNotes] = useState<Record<string, number>>({});
  const [loose, setLoose] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const expected = n(d.expectedCash);
  const byNotes = useMemo(() => Object.entries(notes).reduce((s, [k, q]) => s + Number(k) * q, 0), [notes]);
  const counted = byNotes + n(loose);
  // Counted ₹0 is a real count: nothing was expected, or the cashier says the drawer is empty.
  const [empty, setEmpty] = useState(false);
  const touched = byNotes > 0 || loose !== '' || empty || expected === 0;
  const variance = Math.round((counted - expected) * 100) / 100;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      // Notes are sent only when they are the whole count (the server checks they add up).
      onClosed(await closeDrawer(d.id, counted, loose === '' ? notes : {}, note));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-sub">
        <span className="inline-flex items-center gap-1">
          <Clock3 className="size-3.5" aria-hidden="true" /> Opened {time(d.openedAt)}
        </span>
        <span>· {d.counter?.name ?? 'Counter'}</span>
        <span>
          · {d.sales.count} bill{d.sales.count === 1 ? '' : 's'} · {rupees(d.sales.total)}
        </span>
        {d.sales.voided > 0 && <span className="text-coral">· {d.sales.voided} cancelled</span>}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {/* expected cash */}
        <section className="rounded-2xl border border-line p-3">
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-mute">Cash in the drawer</h3>
          <Line label="Opening float" value={d.openingFloat} />
          <Line label="Cash sales (after change)" value={d.cashSales} sign="+" />
          {n(d.cashRefunds) > 0 && <Line label="Cash refunds" value={d.cashRefunds} sign="−" />}
          {n(d.payIn) > 0 && <Line label="Cash put in" value={d.payIn} sign="+" />}
          {n(d.payOut) > 0 && <Line label="Cash taken out" value={d.payOut} sign="−" />}
          <div className="mt-2 flex items-baseline justify-between border-t border-line pt-2">
            <span className="font-semibold">Should be in the drawer</span>
            <b className="text-[18px] tabular-nums">{rupees(expected)}</b>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
            <Tender label="UPI" settled={d.upi.settled} pending={d.upi.pending} />
            <Tender label="Card" settled={d.card.settled} pending={d.card.pending} />
          </div>
          <PayInOut d={d} onDone={onChanged} />
        </section>

        {/* count */}
        <section className="rounded-2xl border border-line p-3">
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-mute">Count the cash</h3>
          <div className="grid grid-cols-3 gap-1.5">
            {DENOMINATIONS.map((k) => (
              <label key={k} className="flex items-center gap-1.5 rounded-lg bg-bg px-2 py-1">
                <span className="w-9 text-right text-[12px] font-bold text-sub">₹{k}</span>
                <span className="text-mute">×</span>
                <input
                  inputMode="numeric"
                  value={notes[k] || ''}
                  onChange={(e) => {
                    const q = Math.min(100000, Number(e.target.value.replace(/\D/g, '')) || 0);
                    setNotes((s) => ({ ...s, [k]: q }));
                    setEmpty(false);
                  }}
                  aria-label={`Number of ₹${k}`}
                  placeholder="0"
                  className="h-7 w-full min-w-0 rounded-md border border-line bg-surface px-1.5 text-right tabular-nums outline-none focus:border-blue"
                />
              </label>
            ))}
          </div>
          <label className="mt-2 flex items-center justify-between gap-2 text-[12px] text-sub">
            Loose coins / other
            <input
              inputMode="decimal"
              value={loose}
              onChange={(e) => {
                setLoose(e.target.value.replace(/[^\d.]/g, ''));
                setEmpty(false);
              }}
              placeholder="₹0"
              className="h-8 w-28 rounded-md border border-line bg-surface px-2 text-right tabular-nums outline-none focus:border-blue"
            />
          </label>
          {expected > 0 && (
            <button
              type="button"
              onClick={() => {
                setNotes({});
                setLoose('');
                setEmpty(true);
              }}
              className={`mt-2 w-full rounded-lg border px-2 py-1.5 text-[12px] font-semibold transition ${
                empty ? 'border-coral bg-coral/10 text-coral' : 'border-line text-sub hover:border-blue/50'
              }`}
            >
              Drawer is empty (₹0)
            </button>
          )}
          <div className="mt-3 flex items-baseline justify-between border-t border-line pt-2">
            <span className="font-semibold">Counted</span>
            <b className="text-[18px] tabular-nums">{rupees(counted)}</b>
          </div>
          {touched && (
            <div
              className={`mt-2 flex items-center gap-2 rounded-xl px-3 py-2 font-semibold ${
                variance === 0 ? 'bg-teal/10 text-teal' : Math.abs(variance) <= 50 ? 'bg-amber/10 text-amber' : 'bg-coral/10 text-coral'
              }`}
            >
              {variance === 0 ? <CheckCircle2 className="size-4" /> : <TriangleAlert className="size-4" />}
              {variance === 0 ? 'Matches exactly' : `${variance > 0 ? 'Over' : 'Short'} by ${rupees(Math.abs(variance))}`}
            </div>
          )}
        </section>
      </div>

      <label className="block text-[12px] text-sub">
        Note {touched && variance !== 0 && <span className="text-coral">— say why the cash doesn’t match</span>}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
          placeholder="Optional"
          className="mt-1 h-10 w-full rounded-xl border border-line bg-surface px-3 text-ink outline-none focus:border-blue"
        />
      </label>

      {error && <p className="rounded-xl bg-coral/10 px-3 py-2 text-coral">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="h-10 rounded-xl border border-line px-4 font-semibold hover:bg-bg">
          Not now
        </button>
        <button
          type="button"
          disabled={!touched || busy}
          onClick={() => void submit()}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-blue px-4 font-semibold text-onbrand disabled:opacity-50"
        >
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          Close drawer · {rupees(counted)}
        </button>
      </div>
    </div>
  );
}

function PayInOut({ d, onDone }: { d: Drawer; onDone: () => void }) {
  const [type, setType] = useState<'PAY_IN' | 'PAY_OUT' | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!type) return;
    setBusy(true);
    setError('');
    try {
      await cashMovement(d.id, type, Number(amount), reason.trim());
      setType(null);
      setAmount('');
      setReason('');
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 border-t border-line pt-3">
      {d.movements.length > 0 && (
        <ul className="mb-2 space-y-1 text-[12px]">
          {d.movements.map((m) => (
            <li key={m.id} className="flex justify-between gap-2 text-sub">
              <span className="truncate">
                {time(m.createdAt)} · {m.type === 'PAY_IN' ? 'Put in' : 'Taken out'} · {m.reason}
              </span>
              <span className={`tabular-nums ${m.type === 'PAY_IN' ? 'text-teal' : 'text-coral'}`}>
                {m.type === 'PAY_IN' ? '+' : '−'}
                {rupees(m.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {type ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              autoFocus
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="₹ Amount"
              className="h-9 w-28 rounded-lg border border-line bg-surface px-2 tabular-nums outline-none focus:border-blue"
            />
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={120}
              placeholder={type === 'PAY_IN' ? 'e.g. Change from the safe' : 'e.g. Paid for milk delivery'}
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 outline-none focus:border-blue"
            />
          </div>
          {error && <p className="text-[12px] text-coral">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setType(null)} className="h-8 rounded-lg px-3 text-[12px] font-semibold text-sub hover:bg-bg">
              Cancel
            </button>
            <button
              type="button"
              disabled={!(Number(amount) > 0) || !reason.trim() || busy}
              onClick={() => void save()}
              className="h-8 rounded-lg bg-ink px-3 text-[12px] font-semibold text-surface disabled:opacity-50"
            >
              Save {type === 'PAY_IN' ? 'cash in' : 'cash out'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <SmallBtn onClick={() => setType('PAY_IN')} icon={<ArrowDownLeft className="size-3.5 text-teal" />}>
            Cash in
          </SmallBtn>
          <SmallBtn onClick={() => setType('PAY_OUT')} icon={<ArrowUpRight className="size-3.5 text-coral" />}>
            Cash out
          </SmallBtn>
        </div>
      )}
    </div>
  );
}

function Closed({ d, onDone, onSignOut }: { d: Drawer; onDone: () => void; onSignOut: () => void }) {
  const v = n(d.variance);
  const review = d.status === 'PENDING_REVIEW';
  return (
    <div className="space-y-4 text-center text-[13px]">
      <span className={`mx-auto grid size-14 place-items-center rounded-2xl ${review ? 'bg-amber/15 text-amber' : 'bg-teal/15 text-teal'}`}>
        {review ? <TriangleAlert className="size-7" /> : <CheckCircle2 className="size-7" />}
      </span>
      <div>
        <h3 className="text-[18px] font-extrabold">Drawer closed</h3>
        <p className="mt-1 text-sub">
          {review
            ? `The cash is ${v > 0 ? 'over' : 'short'} by ${rupees(Math.abs(v))}. A manager will review it.`
            : v === 0
              ? 'The cash matched exactly.'
              : d.review
                ? `The cash was ${v > 0 ? 'over' : 'short'} by ${rupees(Math.abs(v))}. As a manager, your close is signed off straight away.`
                : `The cash was ${v > 0 ? 'over' : 'short'} by ${rupees(Math.abs(v))} — within the allowed limit.`}
        </p>
      </div>
      <div className="mx-auto grid max-w-sm grid-cols-3 gap-2 rounded-2xl bg-bg p-3 text-left">
        <Mini label="Expected" value={rupees(d.expectedCash)} />
        <Mini label="Counted" value={rupees(d.countedCash)} />
        <Mini label="Difference" value={`${v > 0 ? '+' : v < 0 ? '−' : ''}${rupees(Math.abs(v))}`} tone={v === 0 ? 'text-teal' : 'text-coral'} />
      </div>
      <p className="text-[12px] text-mute">The next bill on this counter opens a new drawer with its opening cash.</p>
      <div className="flex justify-center gap-2">
        <button type="button" onClick={onDone} className="h-10 rounded-xl border border-line px-4 font-semibold hover:bg-bg">
          Done
        </button>
        <button type="button" onClick={onSignOut} className="inline-flex h-10 items-center gap-2 rounded-xl bg-ink px-4 font-semibold text-surface">
          <LogOut className="size-4" aria-hidden="true" /> Sign out
        </button>
      </div>
    </div>
  );
}

/* ---------- bits ---------- */

function Line({ label, value, sign }: { label: string; value: string; sign?: '+' | '−' }) {
  return (
    <div className="flex justify-between py-0.5 text-sub">
      <span>{label}</span>
      <span className="tabular-nums text-ink">
        {sign && <span className={sign === '+' ? 'text-teal' : 'text-coral'}>{sign} </span>}
        {rupees(value)}
      </span>
    </div>
  );
}

function Tender({ label, settled, pending }: { label: string; settled: string; pending: string }) {
  return (
    <div className="rounded-lg bg-bg px-2 py-1.5">
      <div className="text-mute">{label}</div>
      <div className="font-semibold tabular-nums text-ink">{rupees(settled)}</div>
      {n(pending) > 0 && <div className="text-amber">{rupees(pending)} to verify</div>}
    </div>
  );
}

function Mini({ label, value, tone = 'text-ink' }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[11px] text-mute">{label}</div>
      <div className={`font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

function SmallBtn({ onClick, icon, children }: { onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[12px] font-semibold hover:border-blue/50">
      {icon}
      {children}
    </button>
  );
}
