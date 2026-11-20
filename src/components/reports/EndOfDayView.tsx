'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CloudOff,
  CreditCard,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { PageHead } from '@/components/AppShell';
import { errorMessage } from '@/lib/api/client';
import { can, isLive } from '@/lib/live/session';
import { stores, useBranches } from '@/lib/branch-data';
import { TODAY } from '@/lib/suppliers-data';
import {
  acknowledgeIssue,
  decidePayment,
  discardIssue,
  listDrawers,
  pendingPayments,
  retryIssue,
  reviewDrawer,
  rupees,
  syncIssues,
  type Drawer,
  type PendingPayment,
  type SyncIssue,
} from '@/lib/live/shift';

type Tab = 'drawers' | 'payments' | 'sync';
const n = (v: string | number | null | undefined) => Number(v ?? 0);
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—');
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The manager's end of day: drawers to sign off, UPI/card payments to check against the bank or
 * terminal, and offline bills the server couldn't accept as they were.
 */
export function EndOfDayView() {
  const branches = useBranches();
  const shops = stores(branches);
  const branchName = (id: string) => shops.find((b) => b.id === id)?.name ?? 'Branch';
  const allowed = isLive() && can('cash:reconcile');

  const [tab, setTab] = useState<Tab>('drawers');
  const [date, setDate] = useState(TODAY);
  const [drawers, setDrawers] = useState<Drawer[] | null>(null);
  const [toReview, setToReview] = useState<Drawer[]>([]);
  const [payments, setPayments] = useState<PendingPayment[] | null>(null);
  const [issues, setIssues] = useState<SyncIssue[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    setError('');
    try {
      const [d, r, p, s] = await Promise.all([
        listDrawers({ date }),
        listDrawers({ status: 'PENDING_REVIEW' }),
        pendingPayments(),
        syncIssues(),
      ]);
      setDrawers(d.data);
      setToReview(r.data);
      setPayments(p);
      setIssues(s.data);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [allowed, date]);
  useEffect(() => {
    void load();
  }, [load]);

  // Drawers waiting for sign-off show whatever day they were closed; the rest are the chosen day's.
  const shown = useMemo(() => {
    const ids = new Set(toReview.map((d) => d.id));
    return [...toReview, ...(drawers ?? []).filter((d) => !ids.has(d.id))];
  }, [drawers, toReview]);
  const open = shown.filter((d) => d.status === 'OPEN').length;
  const variance = (drawers ?? []).filter((d) => d.status !== 'OPEN').reduce((s, d) => s + n(d.variance), 0);
  const failed = (issues ?? []).filter((i) => i.status === 'FAILED').length;

  if (!isLive())
    return (
      <Shell>
        <Blocked icon={<CloudOff className="size-6" />} title="Connect to the server">
          Drawers, payment checks and offline sync are kept on the server. Set NEXT_PUBLIC_API_URL in .env.local and restart the app.
        </Blocked>
      </Shell>
    );
  if (!allowed)
    return (
      <Shell>
        <Blocked icon={<Lock className="size-6" />} title="Managers only">
          Signing off drawers and verifying payments needs the “Reconcile cash” permission.
        </Blocked>
      </Shell>
    );

  return (
    <Shell
      action={
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-semibold hover:bg-bg"
        >
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh
        </button>
      }
    >
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat tone="amber" icon={<ShieldCheck className="size-5" />} label="Drawers to sign off" value={toReview.length} onClick={() => setTab('drawers')}>
          Closed with a large difference
        </Stat>
        <Stat tone="blue" icon={<Wallet className="size-5" />} label="Drawers open" value={open} onClick={() => setTab('drawers')}>
          {date === TODAY ? 'Still open today' : `On ${date}`} · net difference {variance >= 0 ? '+' : '−'}
          {rupees(Math.abs(variance))}
        </Stat>
        <Stat tone="vio" icon={<CreditCard className="size-5" />} label="Payments to verify" value={payments?.length ?? 0} onClick={() => setTab('payments')}>
          UPI / card not yet confirmed
        </Stat>
        <Stat tone="coral" icon={<CloudOff className="size-5" />} label="Offline bills to fix" value={issues?.length ?? 0} onClick={() => setTab('sync')}>
          {failed} failed · {(issues?.length ?? 0) - failed} with warnings
        </Stat>
      </section>

      {error && (
        <div className="flex items-center gap-2 rounded-xl bg-coral/10 px-4 py-3 text-sm text-coral">
          <AlertTriangle className="size-4 shrink-0" /> {error}
        </div>
      )}

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-line px-3 pt-3">
          <div className="flex gap-1 overflow-x-auto">
            {(
              [
                ['drawers', `Drawers (${shown.length})`],
                ['payments', `Payments to verify (${payments?.length ?? 0})`],
                ['sync', `Offline sync (${issues?.length ?? 0})`],
              ] as [Tab, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`-mb-px whitespace-nowrap border-b-2 px-3 pb-2.5 text-sm font-semibold ${tab === k ? 'border-blue text-ink' : 'border-transparent text-sub hover:text-ink'}`}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'drawers' && (
            <label className="mb-2 flex items-center gap-2 text-xs text-sub">
              Day
              <input
                type="date"
                value={date}
                max={TODAY}
                onChange={(e) => e.target.value && setDate(e.target.value)}
                className="h-8 rounded-lg border border-line bg-surface px-2 text-sm text-ink"
              />
            </label>
          )}
        </div>
        {drawers === null ? (
          <Empty>
            <Loader2 className="mx-auto size-5 animate-spin" />
          </Empty>
        ) : tab === 'drawers' ? (
          <Drawers rows={shown} branchName={branchName} multi={shops.length > 1} onChanged={load} />
        ) : tab === 'payments' ? (
          <Payments rows={payments ?? []} branchName={branchName} multi={shops.length > 1} onChanged={load} />
        ) : (
          <Sync rows={issues ?? []} branchName={branchName} multi={shops.length > 1} onChanged={load} />
        )}
      </section>
    </Shell>
  );
}

/* ---------- drawers ---------- */

const statusBadge: Record<Drawer['status'], [string, string]> = {
  OPEN: ['Open', 'bg-blue/10 text-blue'],
  PENDING_REVIEW: ['Needs sign-off', 'bg-amber/15 text-amber'],
  CLOSED: ['Closed', 'bg-teal/10 text-teal'],
};

function Drawers({ rows, branchName, multi, onChanged }: { rows: Drawer[]; branchName: (id: string) => string; multi: boolean; onChanged: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!rows.length) return <Empty>No drawers were opened on this day.</Empty>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((d) => {
        const v = n(d.variance);
        const [label, cls] = statusBadge[d.status];
        const isOpen = openId === d.id;
        return (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => setOpenId(isOpen ? null : d.id)}
              className="grid w-full grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 text-left text-sm hover:bg-bg/60 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))_120px_20px]"
            >
              <div className="min-w-0">
                <div className="truncate font-semibold">{d.cashier ?? 'Cashier'}</div>
                <div className="truncate text-xs text-mute">
                  {d.counter?.name ?? 'Counter'}
                  {multi && ` · ${branchName(d.storeId)}`} · {time(d.openedAt)}–{d.closedAt ? time(d.closedAt) : 'now'}
                </div>
              </div>
              <Cell label="Expected" value={rupees(d.expectedCash)} />
              <Cell label="Counted" value={d.countedCash ? rupees(d.countedCash) : '—'} />
              <Cell
                label="Difference"
                value={d.variance === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${rupees(Math.abs(v))}`}
                tone={d.variance === null || v === 0 ? '' : 'text-coral'}
              />
              <span className={`hidden justify-self-start rounded-full px-2.5 py-0.5 text-xs font-semibold md:inline ${cls}`}>{label}</span>
              <ChevronDown className={`hidden size-4 text-mute transition md:block ${isOpen ? 'rotate-180' : ''}`} />
            </button>
            {isOpen && <DrawerDetail d={d} onChanged={onChanged} />}
          </li>
        );
      })}
    </ul>
  );
}

function DrawerDetail({ d, onChanged }: { d: Drawer; onChanged: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signOff = async () => {
    setBusy(true);
    setError('');
    try {
      await reviewDrawer(d.id, note.trim());
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-4 bg-bg/50 px-4 py-4 text-sm md:grid-cols-3">
      <div>
        <Head>Cash</Head>
        <Row k="Opening float" v={rupees(d.openingFloat)} />
        <Row k="Cash sales" v={`+ ${rupees(d.cashSales)}`} />
        <Row k="Cash refunds" v={`− ${rupees(d.cashRefunds)}`} />
        <Row k="Cash put in" v={`+ ${rupees(d.payIn)}`} />
        <Row k="Cash taken out" v={`− ${rupees(d.payOut)}`} />
        <Row k="Expected" v={rupees(d.expectedCash)} strong />
      </div>
      <div>
        <Head>Shift</Head>
        <Row k="Bills" v={`${d.sales.count} · ${rupees(d.sales.total)}`} />
        <Row k="Cancelled bills" v={String(d.sales.voided)} />
        <Row k="Refunds" v={`${d.refunds.count} · ${rupees(d.refunds.total)}`} />
        <Row k="UPI" v={`${rupees(d.upi.settled)}${n(d.upi.pending) ? ` (+${rupees(d.upi.pending)} to verify)` : ''}`} />
        <Row k="Card" v={`${rupees(d.card.settled)}${n(d.card.pending) ? ` (+${rupees(d.card.pending)} to verify)` : ''}`} />
        {d.denominations && (
          <Row
            k="Notes counted"
            v={Object.entries(d.denominations)
              .sort((a, b) => Number(b[0]) - Number(a[0]))
              .map(([k, q]) => `₹${k}×${q}`)
              .join(' ')}
          />
        )}
      </div>
      <div className="space-y-2">
        <Head>Notes</Head>
        {d.movements.map((m) => (
          <div key={m.id} className="text-xs text-sub">
            {time(m.createdAt)} · {m.type === 'PAY_IN' ? 'Put in' : 'Taken out'} {rupees(m.amount)} — {m.reason}
          </div>
        ))}
        <p className="text-xs text-sub">{d.closingNote ? `Cashier: “${d.closingNote}”` : 'No closing note.'}</p>
        {d.review && (
          <p className="flex items-start gap-1.5 text-xs text-teal">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> Signed off by {d.review.by ?? 'a manager'} at {when(d.review.at)}
            {d.review.note ? ` — “${d.review.note}”` : ''}
          </p>
        )}
        {d.status === 'PENDING_REVIEW' && (
          <div className="space-y-2 rounded-xl border border-amber/40 bg-surface p-3">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              placeholder="What happened? (required)"
              className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm outline-none focus:border-blue"
            />
            {error && <p className="text-xs text-coral">{error}</p>}
            <button
              type="button"
              disabled={!note.trim() || busy}
              onClick={() => void signOff()}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-amber px-3 text-sm font-semibold text-onbrand disabled:opacity-50"
            >
              {busy && <Loader2 className="size-4 animate-spin" />} Sign off drawer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- payments ---------- */

function Payments({
  rows,
  branchName,
  multi,
  onChanged,
}: {
  rows: PendingPayment[];
  branchName: (id: string) => string;
  multi: boolean;
  onChanged: () => void;
}) {
  if (!rows.length) return <Empty>Every UPI and card payment is confirmed.</Empty>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((p) => (
        <PaymentRow key={p.id} p={p} where={multi ? branchName(p.storeId) : null} onChanged={onChanged} />
      ))}
    </ul>
  );
}

function PaymentRow({ p, where, onChanged }: { p: PendingPayment; where: string | null; onChanged: () => void }) {
  const [ref, setRef] = useState(p.reference ?? '');
  const [busy, setBusy] = useState<'ok' | 'fail' | null>(null);
  const [error, setError] = useState('');
  const decide = async (ok: boolean) => {
    if (!ok && !window.confirm(`Mark ${rupees(p.amount)} on ${p.invoiceNo} as NOT received? The bill becomes due.`)) return;
    setBusy(ok ? 'ok' : 'fail');
    setError('');
    try {
      await decidePayment(p.id, ok, ref, '');
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
      <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${p.method === 'UPI' ? 'bg-blue/10 text-blue' : 'bg-vio/10 text-vio'}`}>{p.method}</span>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-xs font-semibold">{p.invoiceNo}</div>
        <div className="text-xs text-mute">
          {when(p.createdAt)}
          {where && ` · ${where}`}
        </div>
      </div>
      <b className="tabular-nums">{rupees(p.amount)}</b>
      <input
        value={ref}
        onChange={(e) => setRef(e.target.value)}
        maxLength={60}
        placeholder={p.method === 'UPI' ? 'UTR / ref no.' : 'Approval code'}
        aria-label="Reference"
        className="h-9 w-40 rounded-lg border border-line bg-surface px-2 text-sm outline-none focus:border-blue"
      />
      <button
        type="button"
        disabled={!!busy}
        onClick={() => void decide(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-teal px-3 text-sm font-semibold text-onbrand disabled:opacity-50"
      >
        {busy === 'ok' ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Received
      </button>
      <button
        type="button"
        disabled={!!busy}
        onClick={() => void decide(false)}
        className="h-9 rounded-lg border border-line px-3 text-sm font-semibold text-coral hover:border-coral disabled:opacity-50"
      >
        Not received
      </button>
      {error && <p className="w-full text-xs text-coral">{error}</p>}
    </li>
  );
}

/* ---------- offline sync ---------- */

const typeLabel: Record<string, string> = {
  SALE: 'Offline bill',
  CASH_SESSION_OPEN: 'Drawer opened offline',
};

function Sync({ rows, branchName, multi, onChanged }: { rows: SyncIssue[]; branchName: (id: string) => string; multi: boolean; onChanged: () => void }) {
  if (!rows.length) return <Empty>Every offline bill synced cleanly. Nothing to fix.</Empty>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((i) => (
        <IssueRow key={i.id} i={i} where={multi ? branchName(i.storeId) : null} onChanged={onChanged} />
      ))}
    </ul>
  );
}

function IssueRow({ i, where, onChanged }: { i: SyncIssue; where: string | null; onChanged: () => void }) {
  const [mode, setMode] = useState<'retry' | 'discard' | 'ack' | null>(null);
  const [note, setNote] = useState('');
  const [renumber, setRenumber] = useState(i.error?.code === 'NUMBER_IN_USE' || i.error?.code === 'NUMBER_NOT_RESERVED');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const failed = i.status === 'FAILED';

  const go = async () => {
    setBusy(true);
    setError('');
    try {
      if (mode === 'retry') {
        const r = await retryIssue(i.id, renumber, note);
        if (r.status === 'FAILED') throw new Error(r.error?.message ?? 'It failed again.');
      } else if (mode === 'discard') await discardIssue(i.id, note.trim());
      else await acknowledgeIssue(i.id, note);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-start gap-3">
        <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${failed ? 'bg-coral/10 text-coral' : 'bg-amber/15 text-amber'}`}>
          {failed ? 'Failed' : 'Warning'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {typeLabel[i.type] ?? i.type}
            {i.invoiceNo && <span className="ml-2 font-mono text-xs">{i.invoiceNo}</span>}
            {i.payable && <span className="ml-2 tabular-nums">{rupees(i.payable)}</span>}
          </div>
          <div className="text-xs text-mute">
            {when(i.occurredAt)} · {i.cashier.name ?? 'Cashier'} · {i.device.name ?? 'Device'}
            {where && ` · ${where}`}
            {i.attempts > 1 && ` · tried ${i.attempts}×`}
          </div>
          {i.error && <p className="mt-1 text-xs text-coral">{i.error.message ?? i.error.code}</p>}
          {i.warnings.map((w, k) => (
            <p key={k} className="mt-1 text-xs text-amber">
              {w.message}
            </p>
          ))}
        </div>
        {!mode && (
          <div className="flex gap-2">
            {failed ? (
              <>
                <button type="button" onClick={() => setMode('retry')} className="h-8 rounded-lg bg-blue px-3 text-xs font-semibold text-onbrand">
                  Try again
                </button>
                <button type="button" onClick={() => setMode('discard')} className="h-8 rounded-lg border border-line px-3 text-xs font-semibold text-coral hover:border-coral">
                  Discard
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setMode('ack')} className="h-8 rounded-lg bg-teal px-3 text-xs font-semibold text-onbrand">
                Mark reviewed
              </button>
            )}
          </div>
        )}
      </div>
      {mode && (
        <div className="mt-3 space-y-2 rounded-xl border border-line bg-bg/50 p-3">
          {mode === 'retry' && (
            <>
              <p className="text-xs text-sub">Fix the cause first (open the drawer, restore the product, add stock…), then run it again.</p>
              {i.type === 'SALE' && (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={renumber} onChange={(e) => setRenumber(e.target.checked)} className="accent-[var(--blue)]" />
                  Record it under the counter’s next bill number (use when the printed number can’t be used)
                </label>
              )}
            </>
          )}
          {mode === 'discard' && (
            <p className="text-xs text-coral">It will not be recorded — no sale, no stock change. Say why, for the audit trail.</p>
          )}
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            placeholder={mode === 'discard' ? 'Reason (required)' : 'Note (optional)'}
            className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm outline-none focus:border-blue"
          />
          {error && <p className="text-xs text-coral">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setMode(null)} className="h-8 rounded-lg px-3 text-xs font-semibold text-sub hover:bg-surface">
              Back
            </button>
            <button
              type="button"
              disabled={busy || (mode === 'discard' && !note.trim())}
              onClick={() => void go()}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-onbrand disabled:opacity-50 ${
                mode === 'discard' ? 'bg-coral' : mode === 'retry' ? 'bg-blue' : 'bg-teal'
              }`}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {mode === 'retry' ? 'Run again' : mode === 'discard' ? 'Discard it' : 'Mark reviewed'}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/* ---------- bits ---------- */

function Shell({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageHead title="End of day" sub="Sign off drawers, confirm UPI and card payments, and fix offline bills">
        {action}
      </PageHead>
      {children}
    </div>
  );
}

const toneCls = {
  blue: 'bg-blue/10 text-blue',
  amber: 'bg-amber/10 text-amber',
  vio: 'bg-vio/10 text-vio',
  coral: 'bg-coral/10 text-coral',
} as const;

function Stat({
  icon,
  tone,
  label,
  value,
  onClick,
  children,
}: {
  icon: ReactNode;
  tone: keyof typeof toneCls;
  label: string;
  value: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className="card p-4 text-left transition hover:border-blue/40">
      <div className="flex items-center gap-3">
        <span className={`grid size-10 place-items-center rounded-xl ${toneCls[tone]}`}>{icon}</span>
        <span className="text-sm font-semibold text-sub">{label}</span>
      </div>
      <div className={`mt-3 text-[26px] font-extrabold tabular-nums ${value > 0 && tone !== 'blue' ? toneCls[tone].split(' ')[1] : ''}`}>{value}</div>
      <div className="mt-0.5 text-xs text-mute">{children}</div>
    </button>
  );
}

function Cell({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="hidden md:block">
      <div className="text-[11px] uppercase tracking-wide text-mute">{label}</div>
      <div className={`font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

const Head = ({ children }: { children: ReactNode }) => <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-mute">{children}</div>;

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 py-0.5 ${strong ? 'mt-1 border-t border-line pt-1.5 font-bold' : 'text-sub'}`}>
      <span>{k}</span>
      <span className="text-right tabular-nums text-ink">{v}</span>
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <div className="px-4 py-14 text-center text-sm text-sub">{children}</div>;

function Blocked({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="card grid place-items-center px-6 py-16 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-blue/10 text-blue">{icon}</span>
      <h2 className="mt-4 text-lg font-bold">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-sub">{children}</p>
    </section>
  );
}
