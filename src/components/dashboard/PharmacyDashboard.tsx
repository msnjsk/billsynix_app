'use client';

import Link from 'next/link';
import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
import {
  ArrowRight,
  Ban,
  CalendarClock,
  Check,
  CircleCheck,
  ClipboardList,
  Download,
  MessageCircle,
  PackageX,
  Pill,
  RotateCcw,
  ScanBarcode,
  Snowflake,
  Thermometer,
  TriangleAlert,
  Truck,
} from 'lucide-react';
import { downloadCsv } from '@/components/AppShell';
import { SalesPerformanceChart, Sparkline } from '@/components/dashboard/Charts';
import { inr } from '@/lib/store-data';
import { useBusinessProfile } from '@/lib/business-profile';
import { greetingName, useSession } from '@/lib/auth';
import { dialable } from '@/lib/customers-data';
import {
  FRIDGE_MAX,
  FRIDGE_MIN,
  NEXT_FRIDGE_CHECK,
  TODAY,
  areaMix,
  batchRows,
  bySku,
  daysFromToday,
  daysLeft,
  distributorDues,
  expiryBands,
  fmtDate,
  fridgeLog,
  h1Today,
  marginPct,
  medicines,
  pharmaSales,
  refillDue,
  refills,
  shortItems,
  stockOf,
  suggestedQty,
  today,
  topMolecules,
  type ExpiryBand,
  type H1Entry,
  type Schedule,
} from '@/lib/pharmacy-data';

type IconType = ComponentType<{ className?: string | undefined }>;

const sum = <T,>(rows: T[], pick: (r: T) => number) => rows.reduce((s, r) => s + pick(r), 0);
/** % change; 0 when there is nothing earlier to compare with (never "Infinity%"). */
const pct = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : 0);

const scheduleBadge: Record<Schedule, string> = {
  H1: 'bg-coral/15 text-coral',
  H: 'bg-amber/15 text-amber',
  OTC: 'bg-teal/15 text-teal',
};

const bandTone: Record<ExpiryBand, { pill: string; text: string }> = {
  expired: { pill: 'bg-coral text-onbrand', text: 'text-coral' },
  d30: { pill: 'bg-coral/15 text-coral', text: 'text-coral' },
  d90: { pill: 'bg-amber/15 text-amber', text: 'text-amber' },
  d180: { pill: 'bg-sky/15 text-sky', text: 'text-sky' },
};

const areaColor = ['var(--blue)', 'var(--vio)', 'var(--coral)', 'var(--amber)', 'var(--teal)', 'var(--sky)', 'var(--lime)', 'var(--cyan)', 'var(--mute)', 'var(--sub)'];

const expiryText = (days: number) =>
  days < 0 ? `Expired ${-days}d ago` : days === 0 ? 'Expires today' : days < 60 ? `${days} days left` : `${Math.round(days / 30)} months left`;

const h1Missing = (e: H1Entry) =>
  [!e.patient && 'patient', !e.patientAddress && 'patient address', !e.doctor && 'doctor', !e.doctorRegNo && 'doctor reg. no.'].filter(Boolean) as string[];

/* ---------- small pieces ---------- */

function Panel({
  title,
  sub,
  icon: I,
  action,
  children,
  className = '',
  id,
}: {
  title: string;
  sub?: string;
  icon?: IconType;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`card scroll-mt-20 p-4 ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          {I && (
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-blue/10 text-blue">
              <I className="size-4" />
            </span>
          )}
          <div>
            <h2 className="text-[15px] font-bold text-ink">{title}</h2>
            {sub && <p className="mt-0.5 text-[12px] text-sub">{sub}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Kpi({
  label,
  value,
  foot,
  delta,
  spark,
  tone,
}: {
  label: string;
  value: string;
  foot: string;
  delta?: number;
  spark?: number[];
  tone?: 'alert';
}) {
  const alert = tone === 'alert';
  return (
    <div className={`rounded-2xl p-3.5 ${alert ? 'gco text-onbrand shadow-lg shadow-coral/25' : 'card'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className={alert ? 'text-onbrand/85' : 'text-sub'}>{label}</span>
        {spark && <Sparkline points={spark} color={alert ? 'var(--onbrand)' : (delta ?? 0) >= 0 ? 'var(--teal)' : 'var(--coral)'} />}
      </div>
      <div className={`mt-2 text-[19px] font-extrabold tabular-nums ${alert ? '' : 'text-ink'}`}>{value}</div>
      <div className={`mt-0.5 text-[11px] ${alert ? 'text-onbrand/85' : 'text-sub'}`}>
        {delta !== undefined && (
          <span className={`font-semibold ${alert ? '' : delta >= 0 ? 'text-teal' : 'text-coral'}`}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%{' '}
          </span>
        )}
        {foot}
      </div>
    </div>
  );
}

function ScheduleTag({ s }: { s: Schedule }) {
  return <span className={`rounded px-1.5 py-px text-[10px] font-bold ${scheduleBadge[s]}`}>{s === 'OTC' ? 'OTC' : `Sch ${s}`}</span>;
}

/* ---------- sections ---------- */

function ActionCenter({
  expired,
  h1Open,
  outOfStock,
  refillsDue,
}: {
  expired: number;
  h1Open: number;
  outOfStock: number;
  refillsDue: number;
}) {
  const items: { icon: IconType; label: string; detail: string; href: string; tone: string }[] = [
    { icon: Ban, label: `${expired} expired batch${expired === 1 ? '' : 'es'} on the shelf`, detail: 'Pull them before they are sold', href: '#expiry', tone: 'text-coral' },
    { icon: TriangleAlert, label: `${h1Open} H1 register ${h1Open === 1 ? 'entry' : 'entries'} incomplete`, detail: 'Add the missing doctor / patient details', href: '#h1', tone: 'text-amber' },
    { icon: PackageX, label: `${outOfStock} item${outOfStock === 1 ? '' : 's'} out of stock`, detail: 'Order before the evening rush', href: '#short', tone: 'text-coral' },
    { icon: CalendarClock, label: `${refillsDue} refill${refillsDue === 1 ? '' : 's'} due this week`, detail: 'Remind regular patients on WhatsApp', href: '#refills', tone: 'text-blue' },
    { icon: Thermometer, label: `Fridge check due at ${NEXT_FRIDGE_CHECK}`, detail: `Keep insulin between ${FRIDGE_MIN}–${FRIDGE_MAX} °C`, href: '#cold', tone: 'text-sky' },
  ].filter((i) => !i.label.startsWith('0 '));

  return (
    <section className="gbv rounded-2xl p-5 text-onbrand shadow-lg shadow-blue/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-[19px] font-extrabold">{items.length} things need attention today</h2>
          <p className="mt-0.5 text-onbrand/80">Compliance and stock first — then sales.</p>
        </div>
        <div className="flex gap-6 text-right">
          <div>
            <div className="text-[11px] text-onbrand/70">Sales so far</div>
            <div className="text-[22px] font-extrabold tabular-nums">{inr(today.revenue)}</div>
          </div>
          <div>
            <div className="text-[11px] text-onbrand/70">Prescriptions</div>
            <div className="text-[22px] font-extrabold tabular-nums">
              {today.rxBills}
              <span className="text-[13px] font-semibold text-onbrand/70"> / {today.bills} bills</span>
            </div>
          </div>
        </div>
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {items.map(({ icon: I, label, detail, href, tone }) => (
          <li key={label}>
            <a
              href={href}
              className="group flex h-full items-start gap-2.5 rounded-xl bg-surface p-3 text-ink shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <span className={`mt-0.5 ${tone}`}>
                <I className="size-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-bold leading-snug">{label}</span>
                <span className="block text-[11px] text-sub">{detail}</span>
              </span>
              <ArrowRight className="mt-0.5 size-4 shrink-0 text-mute transition group-hover:translate-x-0.5 group-hover:text-blue" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ExpiryPanel() {
  const [band, setBand] = useState<ExpiryBand>('expired');
  const [returned, setReturned] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const live = batchRows.filter((r) => r.band && !returned.has(r.id));
  const rows = live.filter((r) => r.band === band);
  const counts = Object.fromEntries((Object.keys(expiryBands) as ExpiryBand[]).map((k) => [k, live.filter((r) => r.band === k)])) as Record<
    ExpiryBand,
    typeof rows
  >;
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.id));

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const exportReturns = () => {
    const list = live.filter((r) => r.band === 'expired' || r.band === 'd30').sort((a, b) => a.med.distributor.localeCompare(b.med.distributor));
    downloadCsv(`expiry-returns-${TODAY}.csv`, [
      ['Distributor', 'Medicine', 'Molecule', 'Batch', 'Expiry', 'Qty (packs)', 'PTR', 'Value'],
      ...list.map((r) => [r.med.distributor, r.med.brand, r.med.molecule, r.batch, r.expiry, r.qty, r.med.ptr, r.value]),
    ]);
  };

  return (
    <Panel
      id="expiry"
      title="Expiry & returns"
      sub="Value at purchase rate (PTR). Distributors take back short-expiry stock — return it before it becomes a loss."
      icon={CalendarClock}
      className="xl:col-span-2"
      action={
        <button onClick={exportReturns} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12px] font-semibold hover:border-blue">
          <Download className="size-3.5" /> Return list
        </button>
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4" role="tablist" aria-label="Expiry band">
        {(Object.keys(expiryBands) as ExpiryBand[]).map((k) => {
          const list = counts[k];
          const active = band === k;
          return (
            <button
              key={k}
              role="tab"
              aria-selected={active}
              onClick={() => {
                setBand(k);
                setPicked(new Set());
              }}
              className={`rounded-xl border-2 p-2.5 text-left transition ${active ? 'border-blue bg-blue/5' : 'border-line hover:border-blue/40'}`}
            >
              <span className={`text-[11px] font-bold ${bandTone[k].text}`}>{expiryBands[k].label}</span>
              <span className="mt-0.5 block text-[17px] font-extrabold tabular-nums text-ink">{inr(sum(list, (r) => r.value))}</span>
              <span className="block text-[11px] text-mute">
                {list.length} batch{list.length === 1 ? '' : 'es'} · {sum(list, (r) => r.qty)} packs
              </span>
            </button>
          );
        })}
      </div>
      <p className="mb-2 text-[12px] text-sub">{expiryBands[band].hint}</p>

      {rows.length === 0 ? (
        <p className="rounded-xl bg-bg py-8 text-center text-sub">
          <CircleCheck className="mx-auto mb-1 size-6 text-teal" />
          Nothing in this band.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                <th className="w-8 pb-2 font-medium">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allPicked}
                    onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)))}
                  />
                </th>
                <th className="pb-2 font-medium">Medicine</th>
                <th className="pb-2 font-medium">Batch · rack</th>
                <th className="pb-2 font-medium">Expiry</th>
                <th className="pb-2 text-right font-medium">Packs</th>
                <th className="pb-2 text-right font-medium">Value</th>
                <th className="pb-2 font-medium">Distributor</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`h-11 border-t border-line ${picked.has(r.id) ? 'bg-blue/5' : ''}`}>
                  <td>
                    <input type="checkbox" aria-label={`Select ${r.med.brand} ${r.batch}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  <td>
                    <div className="flex items-center gap-1.5 font-semibold text-ink">
                      {r.med.brand} <ScheduleTag s={r.med.schedule} />
                      {r.med.coldChain && <Snowflake className="size-3.5 text-sky" aria-label="Cold chain" />}
                    </div>
                    <div className="text-[11px] text-mute">{r.med.molecule}</div>
                  </td>
                  <td className="font-mono text-[11.5px] text-sub">
                    {r.batch} · {r.med.rack}
                  </td>
                  <td>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${bandTone[r.band!].pill}`}>{expiryText(r.days)}</span>
                    <div className="mt-0.5 text-[11px] text-mute">{fmtDate(r.expiry)}</div>
                  </td>
                  <td className="text-right tabular-nums">{r.qty}</td>
                  <td className="text-right font-semibold tabular-nums text-ink">{inr(r.value)}</td>
                  <td className="text-sub">{r.med.distributor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {picked.size > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-bg px-3 py-2">
          <span className="text-[12.5px] text-sub">
            {picked.size} selected · {inr(sum(rows.filter((r) => picked.has(r.id)), (r) => r.value))}
          </span>
          <button
            onClick={() => {
              setReturned((s) => new Set([...s, ...picked]));
              setPicked(new Set());
            }}
            className="flex h-8 items-center gap-1.5 rounded-lg gbv px-3 text-[12px] font-semibold text-onbrand"
          >
            <RotateCcw className="size-3.5" /> Mark returned to distributor
          </button>
        </div>
      )}
      {returned.size > 0 && (
        <p className="mt-2 text-[11.5px] text-teal">
          {returned.size} batch{returned.size === 1 ? '' : 'es'} marked returned this session.{' '}
          <button onClick={() => setReturned(new Set())} className="font-semibold underline">
            Undo
          </button>
        </p>
      )}
    </Panel>
  );
}

function ShortSupply() {
  const byDistributor = useMemo(() => {
    const m = new Map<string, typeof shortItems>();
    for (const s of shortItems) m.set(s.distributor, [...(m.get(s.distributor) ?? []), s]);
    return [...m.entries()];
  }, []);

  return (
    <Panel
      id="short"
      title="Short supply"
      sub="At or below reorder level · order covers 3 weeks"
      icon={PackageX}
      action={
        <button
          onClick={() =>
            downloadCsv(`order-list-${TODAY}.csv`, [
              ['Distributor', 'Medicine', 'Molecule', 'Pack', 'In stock', 'Order qty', 'PTR', 'Value'],
              ...shortItems.map((m) => [m.distributor, m.brand, m.molecule, m.pack, stockOf(m), suggestedQty(m), m.ptr, suggestedQty(m) * m.ptr]),
            ])
          }
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12px] font-semibold hover:border-blue"
        >
          <Download className="size-3.5" /> Order list
        </button>
      }
    >
      <div className="space-y-4">
        {byDistributor.map(([dist, items]) => (
          <div key={dist}>
            <div className="mb-1.5 flex items-center justify-between text-[11px] font-bold uppercase tracking-wide text-mute">
              <span className="flex items-center gap-1.5">
                <Truck className="size-3.5" /> {dist}
              </span>
              <span className="tabular-nums">{inr(sum(items, (m) => suggestedQty(m) * m.ptr))}</span>
            </div>
            <ul className="space-y-1.5">
              {items.map((m) => {
                const stock = stockOf(m);
                const left = daysLeft(m);
                return (
                  <li key={m.sku} className="flex items-center gap-2.5 rounded-lg bg-bg px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 truncate font-semibold text-ink">
                        {m.brand} <ScheduleTag s={m.schedule} />
                      </div>
                      <div className={`text-[11px] ${stock === 0 ? 'font-semibold text-coral' : 'text-sub'}`}>
                        {stock === 0 ? 'Out of stock' : `${stock} left · ~${left} day${left === 1 ? '' : 's'}`}
                      </div>
                    </div>
                    <span className="rounded-md bg-surface px-2 py-1 text-[11.5px] font-bold tabular-nums text-blue shadow-sm">+{suggestedQty(m)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <Link href="/suppliers" className="mt-3 flex items-center gap-1 text-[12px] font-semibold text-blue">
        Place orders with distributors <ArrowRight className="size-3.5" />
      </Link>
    </Panel>
  );
}

function H1Register() {
  const [entries, setEntries] = useState(h1Today);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<H1Entry>>({});
  const open = entries.filter((e) => h1Missing(e).length).length;

  return (
    <Panel
      id="h1"
      title="Schedule H1 register · today"
      sub="Prescriber, patient, drug and quantity must be recorded for every H1 sale and kept for 3 years."
      icon={ClipboardList}
      className="xl:col-span-2"
      action={
        <button
          onClick={() =>
            downloadCsv(`h1-register-${TODAY}.csv`, [
              ['Date', 'Time', 'Bill', 'Drug', 'Molecule', 'Qty', 'Patient', 'Patient address', 'Prescriber', 'Prescriber reg. no.'],
              ...entries.map((e) => {
                const m = bySku(e.sku);
                return [TODAY, e.time, e.bill, m?.brand ?? e.sku, m?.molecule ?? '', e.qty, e.patient, e.patientAddress, e.doctor, e.doctorRegNo];
              }),
            ])
          }
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12px] font-semibold hover:border-blue"
        >
          <Download className="size-3.5" /> Export register
        </button>
      }
    >
      <div className={`mb-3 flex items-center gap-2 rounded-xl px-3 py-2 text-[12.5px] ${open ? 'bg-amber/10 text-amber' : 'bg-teal/10 text-teal'}`}>
        {open ? <TriangleAlert className="size-4" /> : <CircleCheck className="size-4" />}
        {open ? `${open} of ${entries.length} entries are missing details — complete them before closing today.` : `All ${entries.length} entries are complete.`}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[12.5px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
              <th className="pb-2 font-medium">Time · bill</th>
              <th className="pb-2 font-medium">Drug</th>
              <th className="pb-2 font-medium">Patient</th>
              <th className="pb-2 font-medium">Prescriber</th>
              <th className="pb-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const m = bySku(e.sku);
              const missing = h1Missing(e);
              const isEditing = editing === e.id;
              return (
                <tr key={e.id} className={`border-t border-line align-top ${missing.length ? 'bg-amber/[0.06]' : ''}`}>
                  <td className="py-2.5 tabular-nums text-sub">
                    {e.time}
                    <div className="text-[11px] text-mute">#{e.bill}</div>
                  </td>
                  <td className="py-2.5">
                    <div className="font-semibold text-ink">
                      {m?.brand} × {e.qty}
                    </div>
                    <div className="text-[11px] text-mute">{m?.molecule}</div>
                  </td>
                  <td className="py-2.5">
                    {isEditing && !e.patientAddress ? (
                      <>
                        <div className="text-ink">{e.patient}</div>
                        <input
                          autoFocus
                          placeholder="Patient address"
                          value={draft.patientAddress ?? ''}
                          onChange={(ev) => setDraft((d) => ({ ...d, patientAddress: ev.target.value }))}
                          className="mt-1 h-8 w-full rounded-lg border border-line bg-surface px-2 outline-none focus:border-blue"
                        />
                      </>
                    ) : (
                      <>
                        <div className="text-ink">{e.patient}</div>
                        <div className={`text-[11px] ${e.patientAddress ? 'text-mute' : 'font-semibold text-amber'}`}>{e.patientAddress || 'Address missing'}</div>
                      </>
                    )}
                  </td>
                  <td className="py-2.5">
                    <div className="text-ink">{e.doctor}</div>
                    {isEditing && !e.doctorRegNo ? (
                      <input
                        autoFocus={!!e.patientAddress}
                        placeholder="Reg. no., e.g. KMC 48211"
                        value={draft.doctorRegNo ?? ''}
                        onChange={(ev) => setDraft((d) => ({ ...d, doctorRegNo: ev.target.value }))}
                        className="mt-1 h-8 w-full rounded-lg border border-line bg-surface px-2 outline-none focus:border-blue"
                      />
                    ) : (
                      <div className={`text-[11px] ${e.doctorRegNo ? 'font-mono text-mute' : 'font-semibold text-amber'}`}>{e.doctorRegNo || 'Reg. no. missing'}</div>
                    )}
                  </td>
                  <td className="py-2.5 text-right">
                    {isEditing ? (
                      <span className="inline-flex gap-1">
                        <button
                          onClick={() => {
                            setEntries((list) =>
                              list.map((x) =>
                                x.id === e.id
                                  ? { ...x, patientAddress: x.patientAddress || (draft.patientAddress ?? '').trim(), doctorRegNo: x.doctorRegNo || (draft.doctorRegNo ?? '').trim() }
                                  : x
                              )
                            );
                            setEditing(null);
                          }}
                          className="h-8 rounded-lg gbv px-3 text-[12px] font-semibold text-onbrand"
                        >
                          Save
                        </button>
                        <button onClick={() => setEditing(null)} className="h-8 rounded-lg px-2 text-[12px] font-semibold text-sub">
                          Cancel
                        </button>
                      </span>
                    ) : missing.length ? (
                      <button
                        onClick={() => {
                          setEditing(e.id);
                          setDraft({});
                        }}
                        className="h-8 rounded-lg border border-amber/50 px-3 text-[12px] font-semibold text-amber hover:bg-amber/10"
                      >
                        Complete
                      </button>
                    ) : (
                      <Check className="ml-auto size-4 text-teal" aria-label="Complete" />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ColdChain() {
  const [log, setLog] = useState(fridgeLog);
  const [reading, setReading] = useState('');
  const last = log[log.length - 1];
  const inRange = (t: number) => t >= FRIDGE_MIN && t <= FRIDGE_MAX;
  const coldItems = medicines.filter((m) => m.coldChain);
  const n = Number(reading);

  return (
    <Panel id="cold" title="Cold chain" sub={`Fridge must stay ${FRIDGE_MIN}–${FRIDGE_MAX} °C`} icon={Snowflake}>
      <div className="flex items-center gap-4 rounded-xl bg-bg p-3">
        <div className={`grid size-16 shrink-0 place-items-center rounded-2xl ${last && inRange(last.temp) ? 'bg-teal/15 text-teal' : 'bg-coral/15 text-coral'}`}>
          <span className="text-[20px] font-extrabold tabular-nums">{last?.temp.toFixed(1)}°</span>
        </div>
        <div className="text-[12.5px]">
          <div className="font-semibold text-ink">{last && inRange(last.temp) ? 'In range' : 'Out of range — move stock and check the fridge'}</div>
          <div className="text-sub">
            Last logged {last?.time} by {last?.by}
          </div>
          <div className="text-sub">Next check due {NEXT_FRIDGE_CHECK}</div>
        </div>
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!reading || !Number.isFinite(n)) return;
          const now = new Date();
          setLog((l) => [...l, { time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, temp: n, by: 'You' }]);
          setReading('');
        }}
      >
        <input
          value={reading}
          onChange={(e) => setReading(e.target.value)}
          inputMode="decimal"
          placeholder="Reading °C"
          aria-label="Fridge temperature in °C"
          className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 outline-none focus:border-blue"
        />
        <button className="h-9 rounded-lg border border-line px-3 text-[12px] font-semibold hover:border-blue">Log</button>
      </form>
      {reading && Number.isFinite(n) && !inRange(n) && (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] font-semibold text-coral">
          <TriangleAlert className="size-3.5" /> Outside {FRIDGE_MIN}–{FRIDGE_MAX} °C
        </p>
      )}
      <ul className="mt-3 space-y-1.5 text-[12.5px]">
        {coldItems.map((m) => (
          <li key={m.sku} className="flex justify-between gap-2">
            <span className="truncate text-ink">{m.brand}</span>
            <span className="tabular-nums text-sub">{stockOf(m)} in fridge</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Refills() {
  const storeName = useBusinessProfile().displayName;
  const [reminded, setReminded] = useState<Set<string>>(new Set());
  const due = refills
    .map((r) => ({ ...r, due: refillDue(r), med: bySku(r.sku)! }))
    .filter((r) => r.due <= 7)
    .sort((a, b) => a.due - b.due);

  return (
    <Panel
      id="refills"
      title="Refills due"
      sub="Regular patients whose monthly medicines run out within a week"
      icon={CalendarClock}
      className="xl:col-span-2"
    >
      <ul className="divide-y divide-line">
        {due.map((r) => {
          const done = reminded.has(r.id);
          const msg = `Hello ${r.patient}, this is ${storeName}. Your ${r.med.brand} (${r.packs} × ${r.med.pack}) is due for refill${
            r.due < 0 ? '' : ` on ${fmtDate(new Date(Date.parse(r.lastBought) + r.supplyDays * 86400000).toISOString().slice(0, 10))}`
          }. Reply YES and we will keep it ready for you.`;
          return (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-vio/15 text-[12px] font-bold text-vio">
                {r.patient
                  .split(/\s+/)
                  .map((w) => w[0])
                  .join('')
                  .slice(0, 2)}
              </span>
              <div className="min-w-[180px] flex-1">
                <div className="font-semibold text-ink">
                  {r.patient} <span className="font-normal text-mute">· {r.condition}</span>
                </div>
                <div className="text-[11.5px] text-sub">
                  {r.med.brand} · {r.packs} × {r.med.pack}
                </div>
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${r.due < 0 ? 'bg-coral/15 text-coral' : r.due <= 2 ? 'bg-amber/15 text-amber' : 'bg-sky/15 text-sky'}`}
              >
                {r.due < 0 ? `${-r.due}d overdue` : r.due === 0 ? 'Due today' : `Due in ${r.due}d`}
              </span>
              <span className="w-20 text-right font-semibold tabular-nums text-ink">{inr(r.packs * r.med.mrp)}</span>
              {done ? (
                <span className="flex h-8 w-[104px] items-center justify-center gap-1 text-[12px] font-semibold text-teal">
                  <Check className="size-4" /> Reminded
                </span>
              ) : (
                <a
                  href={`https://wa.me/${dialable(r.phone)}?text=${encodeURIComponent(msg)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setReminded((s) => new Set([...s, r.id]))}
                  className="flex h-8 w-[104px] items-center justify-center gap-1.5 rounded-lg border border-line text-[12px] font-semibold hover:border-blue"
                >
                  <MessageCircle className="size-3.5 text-teal" /> Remind
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11.5px] text-mute">
        {due.length} patients · {inr(sum(due, (r) => r.packs * r.med.mrp))} of repeat sales this week
      </p>
    </Panel>
  );
}

function AreaMix() {
  const max = Math.max(...areaMix.map((a) => a.pct));
  return (
    <Panel title="Sales by therapy area" sub="Last 30 days" icon={Pill}>
      <ul className="space-y-2.5">
        {areaMix.map((a, i) => (
          <li key={a.area}>
            <div className="flex justify-between text-[12.5px]">
              <span className="text-ink">{a.area}</span>
              <span className="tabular-nums text-sub">{a.pct}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full" style={{ width: `${(a.pct / max) * 100}%`, background: areaColor[i % areaColor.length] }} />
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-4 rounded-xl bg-bg p-3">
        <div className="flex justify-between text-[12.5px]">
          <span className="font-semibold text-ink">Generic share</span>
          <span className="font-bold tabular-nums text-teal">{today.genericSharePct}%</span>
        </div>
        <div className="mt-1.5 flex h-2 overflow-hidden rounded-full">
          <div className="bg-teal" style={{ width: `${today.genericSharePct}%` }} />
          <div className="flex-1 bg-blue/40" />
        </div>
        <p className="mt-1.5 text-[11px] text-sub">Generics earn ~2× the margin of branded medicines — offer them when the prescription allows.</p>
      </div>
    </Panel>
  );
}

function TopMolecules() {
  return (
    <Panel title="Top medicines" sub="Last 30 days, by sales value">
      <ul className="space-y-2.5">
        {topMolecules.map((m, i) => (
          <li key={m.sku} className="flex items-center gap-3">
            <span className="w-4 text-[12px] font-bold tabular-nums text-mute">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 truncate font-semibold text-ink">
                {m.brand} <ScheduleTag s={m.schedule} />
              </div>
              <div className="truncate text-[11px] text-mute">
                {m.molecule} · margin {marginPct(m)}%
              </div>
            </div>
            <div className="text-right">
              <div className="font-semibold tabular-nums text-ink">{inr(m.sold30 * m.mrp)}</div>
              <div className="text-[11px] tabular-nums text-sub">{m.sold30} packs</div>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function DistributorDues() {
  return (
    <Panel title="Distributor payments" sub="Pharma distributors' credit" icon={Truck}>
      <ul className="space-y-2.5">
        {distributorDues.map((d) => {
          const days = daysFromToday(d.dueDate);
          return (
            <li key={d.name} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-semibold text-ink">{d.name}</div>
                <div className={`text-[11px] ${days < 0 ? 'font-semibold text-coral' : 'text-sub'}`}>
                  {days < 0 ? `Overdue by ${-days} days` : `Due ${fmtDate(d.dueDate)} · ${d.creditDays}-day credit`}
                </div>
              </div>
              <span className="font-bold tabular-nums text-ink">{inr(d.due)}</span>
            </li>
          );
        })}
      </ul>
      <Link href="/suppliers" className="mt-3 flex items-center gap-1 text-[12px] font-semibold text-blue">
        Pay distributors <ArrowRight className="size-3.5" />
      </Link>
    </Panel>
  );
}

/* ---------- page ---------- */

export function PharmacyDashboard() {
  const session = useSession();
  const profile = useBusinessProfile();
  const firstName = greetingName(session?.name ?? profile.ownerName);

  const risk90 = batchRows.filter((r) => r.band === 'expired' || r.band === 'd30' || r.band === 'd90');
  const expired = batchRows.filter((r) => r.band === 'expired');
  const outOfStock = shortItems.filter((m) => stockOf(m) === 0).length;
  const h1Open = h1Today.filter((e) => h1Missing(e).length).length;
  const refillsDue = refills.filter((r) => refillDue(r) <= 7).length;
  const last7 = pharmaSales.slice(-7).map((d) => d.revenue);

  return (
    <div className="space-y-4 p-5 lg:p-6">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-extrabold">Good morning, {firstName}</h1>
          <p className="mt-1 text-sub">
            Tue, 14 May 2024 · {profile.displayName}
            {profile.drugLicence && <span className="text-mute"> · D.L. {profile.drugLicence}</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="#h1" className="flex h-10 items-center gap-1.5 rounded-xl card px-4 font-semibold">
            <ClipboardList className="size-4" /> H1 register
          </a>
          <a href="#expiry" className="flex h-10 items-center gap-1.5 rounded-xl card px-4 font-semibold">
            <CalendarClock className="size-4" /> Expiry
          </a>
          <Link href="/pos" className="flex h-10 items-center gap-1.5 rounded-xl gbv px-5 font-semibold text-onbrand shadow-lg shadow-blue/25">
            <ScanBarcode className="size-4" /> New bill
          </Link>
        </div>
      </section>

      <ActionCenter expired={expired.length} h1Open={h1Open} outOfStock={outOfStock} refillsDue={refillsDue} />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <Kpi label="Today's sales" value={inr(today.revenue)} delta={pct(today.revenue, today.yesterday)} foot="vs yesterday" spark={last7} />
        <Kpi
          label="Bills"
          value={String(today.bills)}
          delta={pct(today.bills, today.billsYesterday)}
          foot={`· ${Math.round((today.rxBills / today.bills) * 100)}% with prescription`}
        />
        <Kpi label="Avg bill" value={inr(Math.round(today.revenue / today.bills))} foot="per customer today" />
        <Kpi
          label="Gross margin"
          value={`${today.marginPct}%`}
          delta={Math.round((today.marginPct - today.marginPctYesterday) * 10) / 10}
          foot="pts vs yesterday"
        />
        <Kpi
          label="Expiry risk · 90 days"
          value={inr(sum(risk90, (r) => r.value))}
          foot={`${risk90.length} batches · ${inr(sum(expired, (r) => r.value))} already expired`}
          tone="alert"
        />
        <Kpi label="Short supply" value={`${shortItems.length} items`} foot={`${outOfStock} out of stock`} />
      </section>

      <section className="grid gap-3 xl:grid-cols-3">
        <Panel title="Sales & margin" sub="Last 14 days — dashed line is the same days last month" className="xl:col-span-2">
          <div className="mb-2 flex flex-wrap gap-5 text-[12px]">
            <span>
              <span className="text-sub">Sales</span>{' '}
              <b className="tabular-nums text-ink">{inr(sum(pharmaSales, (d) => d.revenue))}</b>{' '}
              <span className="font-semibold text-teal">▲ {pct(sum(pharmaSales, (d) => d.revenue), sum(pharmaSales, (d) => d.previous))}%</span>
            </span>
            <span>
              <span className="text-sub">Gross profit</span> <b className="tabular-nums text-teal">{inr(sum(pharmaSales, (d) => d.profit))}</b>
            </span>
          </div>
          <SalesPerformanceChart data={pharmaSales.map((d) => ({ ...d, title: d.label }))} />
        </Panel>
        <AreaMix />
      </section>

      <section className="grid gap-3 xl:grid-cols-3">
        <ExpiryPanel />
        <ShortSupply />
      </section>

      <section className="grid gap-3 xl:grid-cols-3">
        <H1Register />
        <div className="space-y-3">
          <ColdChain />
          <DistributorDues />
        </div>
      </section>

      <section className="grid gap-3 xl:grid-cols-3">
        <Refills />
        <TopMolecules />
      </section>

      <p className="text-[11.5px] text-mute">
        Sample pharmacy data. Drug schedules shown are indicative — confirm them against the current Drugs Rules.
      </p>
    </div>
  );
}
