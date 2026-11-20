'use client';

import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  ArrowRight,
  ArrowRightLeft,
  BarChart3,
  Building2,
  CircleCheck,
  Download,
  LayoutDashboard,
  MapPin,
  PackageCheck,
  Monitor,
  Pencil,
  Trash2,
  Phone,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Store,
  Tags,
  TriangleAlert,
  Truck,
  Warehouse,
  X,
} from 'lucide-react';
import { PageHead, downloadCsv } from '@/components/AppShell';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BranchForm, ReceiveForm, TransferForm } from '@/components/branches/BranchForms';
import { CountersPanel } from '@/components/branches/CountersPanel';
import { isLive } from '@/lib/live/session';
import { LivePriceLists } from './LivePriceLists';
import { LiveTransfers, type TransferStart } from './LiveTransfers';
import { money } from '@/lib/pos/billing';
import { useSession } from '@/lib/auth';
import { productCategories } from '@/lib/inventory-data';
import {
  REORDER_AT,
  branchById,
  branchMix,
  branchSales,
  cancelTransfer,
  deleteBlockers,
  deleteBranch,
  catalogue,
  createTransfer,
  currentBranch,
  dispatchTransfer,
  fmtDate,
  hasOverride,
  hasSales,
  itemBySku,
  listedAt,
  lowAt,
  priceAt,
  receiveTransfer,
  saveBranch,
  setBranchPrice,
  setCurrentBranch,
  setListed,
  stateName,
  stockAt,
  stockValue,
  stores,
  transferDoc,
  transferSuggestions,
  transferValue,
  useBranches,
  type Branch,
  type TransferStatus,
} from '@/lib/branch-data';

type IconType = ComponentType<{ className?: string | undefined }>;
type Tab = 'overview' | 'branches' | 'catalogue' | 'transfers' | 'sales';
type Modal =
  | { kind: 'branch'; id?: string | undefined }
  | { kind: 'transfer'; from?: string | undefined; to?: string | undefined; lines?: { sku: string; qty: number }[] | undefined }
  | { kind: 'receive'; id: string }
  | { kind: 'view'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'counters'; id: string };

const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
const inrShort = (n: number) => money(n).replace(/\.00$/, '');
const lakh = (n: number) => (n >= 100000 ? `₹${(n / 100000).toFixed(n >= 1000000 ? 1 : 2)} L` : inrShort(n));
const branchColors = ['var(--blue)', 'var(--vio)', 'var(--teal)', 'var(--amber)', 'var(--coral)', 'var(--cyan)', 'var(--lime)'];
/** Sample sales cover 1–14 May; a 31-day month. */
const MONTH_ELAPSED = 14 / 31;

const trfPill: Record<TransferStatus, string> = {
  requested: 'bg-blue/10 text-blue',
  'in-transit': 'bg-amber/15 text-amber',
  received: 'bg-teal/15 text-teal',
  cancelled: 'bg-coral/10 text-coral line-through',
};
const trfLabel: Record<TransferStatus, string> = { requested: 'Requested', 'in-transit': 'In transit', received: 'Received', cancelled: 'Cancelled' };

function Pill({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}

function Stat({ icon: I, label, value, foot, tone }: { icon: IconType; label: string; value: string; foot: string; tone?: 'alert' | 'brand' | undefined }) {
  const colored = tone === 'alert' ? 'gco text-onbrand shadow-lg shadow-coral/25' : tone === 'brand' ? 'gbv text-onbrand shadow-lg shadow-blue/25' : 'card';
  return (
    <div className={`rounded-2xl p-4 ${colored}`}>
      <div className={`flex items-center gap-2 ${tone ? 'text-onbrand/85' : 'text-sub'}`}>
        <I className="size-4" /> {label}
      </div>
      <div className={`mt-2 text-[22px] font-extrabold tabular-nums ${tone ? '' : 'text-ink'}`}>{value}</div>
      <div className={`mt-0.5 text-[12px] ${tone ? 'text-onbrand/85' : 'text-mute'}`}>{foot}</div>
    </div>
  );
}

const Th = ({ children, right }: { children?: ReactNode; right?: boolean }) => (
  <th className={`whitespace-nowrap pb-2 font-medium ${right ? 'text-right' : ''}`}>{children}</th>
);
const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-xl bg-bg py-10 text-center text-sub">{children}</p>;
const Btn = ({ onClick, children, primary, small }: { onClick: () => void; children: ReactNode; primary?: boolean; small?: boolean }) => (
  <button
    onClick={onClick}
    className={`flex shrink-0 items-center gap-1.5 rounded-xl font-semibold ${small ? 'h-8 px-2.5 text-[12px]' : 'h-9 px-3.5 text-[12.5px]'} ${
      primary ? 'gbv text-onbrand shadow-md shadow-blue/20' : 'border border-line text-ink hover:border-blue'
    }`}
  >
    {children}
  </button>
);
const KindIcon = ({ b, className }: { b: Branch; className?: string }) => (b.kind === 'warehouse' ? <Warehouse className={className} /> : <Store className={className} />);

const tip = { contentStyle: { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 12 } };

/** Per-store metrics for the last `days` days of the sample. */
function metricsFor(b: Branch, days: number) {
  const s = branchSales(b.id).slice(-days);
  const revenue = sum(s, (d) => d.revenue);
  const bills = sum(s, (d) => d.bills);
  const profit = sum(s, (d) => d.profit);
  const prev = branchSales(b.id).slice(-days * 2, -days);
  const prevRev = sum(prev, (d) => d.revenue);
  return {
    revenue,
    bills,
    profit,
    avgBill: bills ? revenue / bills : 0,
    margin: revenue ? (profit / revenue) * 100 : 0,
    today: s[s.length - 1]?.revenue ?? 0,
    growth: prev.length === days && prevRev ? ((revenue - prevRev) / prevRev) * 100 : null,
  };
}

/* =====================================================================
   Main view
   ===================================================================== */

export function BranchesView() {
  const state = useBranches();
  const session = useSession();
  const here = currentBranch(state);
  const [tab, setTab] = useState<Tab>('overview');
  const [modal, setModal] = useState<Modal | null>(null);
  // Connected: transfers are made on the server, in the Stock transfers tab.
  const [liveStart, setLiveStart] = useState<TransferStart | null>(null);
  const startTransfer = (m: Extract<Modal, { kind: 'transfer' }>) => {
    if (!isLive()) return setModal(m);
    setLiveStart({ from: m.from, to: m.to, lines: m.lines, key: Date.now() });
    setTab('transfers');
  };
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [priceBranch, setPriceBranch] = useState(here.id);
  const [trfFilter, setTrfFilter] = useState<'' | TransferStatus>('');
  const [salesDays, setSalesDays] = useState(7);

  const notify = (text: string, bad = false) => {
    setToast({ text, bad });
    window.setTimeout(() => setToast(null), 3600);
  };
  const close = () => setModal(null);

  const shops = stores(state);
  const selling = shops.filter((b) => hasSales(b.id));
  const open = state.transfers.filter((t) => t.status === 'requested' || t.status === 'in-transit');
  const suggestions = useMemo(() => transferSuggestions(state), [state]);
  const chainStock = sum(state.branches.filter((b) => b.active), (b) => stockValue(state, b.id));

  const dispatch = (id: string) => {
    const err = dispatchTransfer(id);
    if (err) notify(err, true);
    else notify(`${id} dispatched — stock taken out of ${branchById(state, state.transfers.find((t) => t.id === id)!.from)?.name}`);
  };

  /* ---------- Overview (centralized dashboard) ---------- */
  const overview = () => {
    const rows = selling.map((b) => ({ b, m: metricsFor(b, 14) }));
    const chain = { revenue: sum(rows, (r) => r.m.revenue), profit: sum(rows, (r) => r.m.profit), bills: sum(rows, (r) => r.m.bills), today: sum(rows, (r) => r.m.today) };
    const target = sum(selling, (b) => b.monthlyTarget) * MONTH_ELAPSED;
    const trend = (branchSales(selling[0]?.id ?? '') ?? []).map((d, i) => ({
      label: d.label,
      ...Object.fromEntries(selling.map((b) => [b.id, branchSales(b.id)[i]?.revenue ?? 0])),
    }));
    const lowRows = state.branches.filter((b) => b.active).map((b) => ({ b, low: lowAt(state, b.id) })).filter((r) => r.low.length);
    return (
      <div className="space-y-4">
        {selling.length === 0 ? (
          <Empty>
            Sales reports appear here once your branches start billing. Add a branch in the <b>Branches</b> tab.
          </Empty>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
            <div className="rounded-2xl border border-line p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-bold text-ink">Sales by branch · last 14 days</h3>
                <span className="text-[12px] text-mute">Chain {lakh(chain.revenue)} · {chain.bills.toLocaleString('en-IN')} bills</span>
              </div>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={trend} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: 'var(--mute)', fontSize: 11 }} axisLine={false} tickLine={false} interval={1} />
                  <YAxis tick={{ fill: 'var(--mute)', fontSize: 11 }} axisLine={false} tickLine={false} width={52} tickFormatter={(v: number) => `₹${Math.round(v / 1000)}k`} />
                  <Tooltip {...tip} formatter={(v: number, k: string) => [inrShort(v), branchById(state, k)?.name ?? k]} />
                  <Legend formatter={(k: string) => <span className="text-[12px] text-sub">{branchById(state, k)?.name ?? k}</span>} />
                  {selling.map((b, i) => (
                    <Line key={b.id} type="monotone" dataKey={b.id} stroke={branchColors[i % branchColors.length]} strokeWidth={2.2} dot={false} isAnimationActive={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="rounded-2xl border border-line p-4">
              <h3 className="mb-3 font-bold text-ink">Month to date vs target</h3>
              <div className="space-y-3">
                {rows.map(({ b, m }, i) => {
                  const t = b.monthlyTarget * MONTH_ELAPSED;
                  const pct = t ? (m.revenue / t) * 100 : 0;
                  return (
                    <div key={b.id}>
                      <div className="flex items-center justify-between text-[12.5px]">
                        <span className="flex items-center gap-2 font-semibold text-ink">
                          <span className="size-2.5 rounded-full" style={{ background: branchColors[i % branchColors.length] }} /> {b.name}
                        </span>
                        <span className="tabular-nums text-sub">
                          {lakh(m.revenue)} {b.monthlyTarget > 0 && <span className={pct >= 100 ? 'font-semibold text-teal' : pct < 90 ? 'font-semibold text-coral' : ''}>· {Math.round(pct)}%</span>}
                        </span>
                      </div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-bg">
                        <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: branchColors[i % branchColors.length] }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              {target > 0 && (
                <p className="mt-4 rounded-xl bg-bg p-3 text-[12px] text-sub">
                  Chain is at <b className="text-ink">{Math.round((chain.revenue / target) * 100)}%</b> of the pro-rata target ({lakh(target)} by today).
                </p>
              )}
            </div>
          </div>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-2xl border border-line p-4">
            <h3 className="mb-2 font-bold text-ink">Branch scorecard · 14 days</h3>
            <table className="w-full min-w-[720px] text-[12.5px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                  <Th>Branch</Th>
                  <Th right>Today</Th>
                  <Th right>Sales</Th>
                  <Th right>Bills</Th>
                  <Th right>Avg bill</Th>
                  <Th right>Gross margin</Th>
                  <Th right>Stock value</Th>
                  <Th right>Low stock</Th>
                </tr>
              </thead>
              <tbody>
                {[...rows]
                  .sort((a, b) => b.m.revenue - a.m.revenue)
                  .map(({ b, m }) => (
                    <tr key={b.id} className="h-11 border-t border-line">
                      <td>
                        <span className="font-semibold text-ink">{b.name}</span>
                        {b.isHq && <span className="ml-1.5 text-[11px] text-mute">HQ</span>}
                        {b.id === here.id && <Pill cls="ml-1.5 bg-blue/10 text-blue">This counter</Pill>}
                      </td>
                      <td className="text-right tabular-nums text-sub">{inrShort(m.today)}</td>
                      <td className="text-right font-semibold tabular-nums text-ink">{lakh(m.revenue)}</td>
                      <td className="text-right tabular-nums text-sub">{m.bills.toLocaleString('en-IN')}</td>
                      <td className="text-right tabular-nums text-sub">{inrShort(Math.round(m.avgBill))}</td>
                      <td className="text-right tabular-nums text-sub">{m.margin.toFixed(1)}%</td>
                      <td className="text-right tabular-nums text-sub">{lakh(stockValue(state, b.id))}</td>
                      <td className="text-right">
                        {lowAt(state, b.id).length ? <Pill cls="bg-coral/10 text-coral">{lowAt(state, b.id).length}</Pill> : <span className="text-mute">—</span>}
                      </td>
                    </tr>
                  ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line font-extrabold text-ink">
                  <td className="pt-2">Chain</td>
                  <td className="pt-2 text-right tabular-nums">{inrShort(chain.today)}</td>
                  <td className="pt-2 text-right tabular-nums">{lakh(chain.revenue)}</td>
                  <td className="pt-2 text-right tabular-nums">{chain.bills.toLocaleString('en-IN')}</td>
                  <td className="pt-2 text-right tabular-nums">{inrShort(Math.round(chain.bills ? chain.revenue / chain.bills : 0))}</td>
                  <td className="pt-2 text-right tabular-nums">{chain.revenue ? ((chain.profit / chain.revenue) * 100).toFixed(1) : '0.0'}%</td>
                  <td className="pt-2 text-right tabular-nums">{lakh(chainStock)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-line p-4">
            <h3 className="mb-1 flex items-center gap-2 font-bold text-ink">
              <Sparkles className="size-4 text-vio" /> Suggested transfers
            </h3>
            <p className="mb-3 text-[12px] text-mute">Branches below {REORDER_AT} units, topped up from stock elsewhere before you buy more.</p>
            {suggestions.length ? (
              <ul className="space-y-2">
                {suggestions.map((s) => (
                  <li key={s.to.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-bg p-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-semibold text-ink">
                        {s.from.name} <ArrowRight className="size-3.5 text-mute" /> {s.to.name}
                      </div>
                      <div className="truncate text-[12px] text-sub">{s.lines.map((l) => `${itemBySku(l.sku)?.name} × ${l.qty}`).join(', ')}</div>
                    </div>
                    <Btn small primary onClick={() => startTransfer({ kind: 'transfer', from: s.from.id, to: s.to.id, lines: s.lines })}>
                      <Send className="size-3.5" /> Create transfer
                    </Btn>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl bg-bg p-4 text-center text-[12.5px] text-sub">Nothing to rebalance right now.</p>
            )}
          </div>
          <div className="rounded-2xl border border-line p-4">
            <h3 className="mb-3 flex items-center gap-2 font-bold text-ink">
              <TriangleAlert className="size-4 text-coral" /> Low stock by branch
            </h3>
            {lowRows.length ? (
              <ul className="space-y-2">
                {lowRows.map(({ b, low }) => (
                  <li key={b.id} className="rounded-xl bg-bg p-3">
                    <div className="flex items-center gap-1.5 font-semibold text-ink">
                      <KindIcon b={b} className="size-3.5 text-mute" /> {b.name}
                      <span className="ml-auto text-[11px] font-normal text-mute">{low.length} item{low.length === 1 ? '' : 's'}</span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-sub">{low.map((c) => `${c.name} (${stockAt(state, b.id, c.sku)})`).join(', ')}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl bg-bg p-4 text-center text-[12.5px] text-sub">Every branch is stocked.</p>
            )}
          </div>
        </div>
      </div>
    );
  };

  /* ---------- Branches ---------- */
  const branchesView = () => (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-[12.5px] text-sub">
          {state.branches.length} location{state.branches.length === 1 ? '' : 's'} · {new Set(state.branches.filter((b) => b.gstin).map((b) => b.gstin)).size || 0} GST registration
          {new Set(state.branches.filter((b) => b.gstin).map((b) => b.gstin)).size === 1 ? '' : 's'}
        </p>
        <Btn primary onClick={() => setModal({ kind: 'branch' })}>
          <Plus className="size-4" /> Add branch
        </Btn>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {state.branches.map((b) => {
          const m = hasSales(b.id) ? metricsFor(b, 14) : null;
          return (
            <article key={b.id} className={`rounded-2xl border p-4 ${b.id === here.id ? 'border-blue ring-2 ring-blue/15' : 'border-line'} ${b.active ? '' : 'opacity-60'}`}>
              <div className="flex items-start gap-3">
                <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${b.kind === 'warehouse' ? 'bg-amber/15 text-amber' : 'bg-blue/10 text-blue'}`}>
                  <KindIcon b={b} className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h3 className="font-bold text-ink">{b.name}</h3>
                    <span className="rounded-md bg-bg px-1.5 font-mono text-[11px] text-sub">{b.code}</span>
                    {b.isHq && <Pill cls="bg-vio/10 text-vio">Head office</Pill>}
                    {!b.active && <Pill cls="bg-bg text-sub">Closed</Pill>}
                  </div>
                  <p className="mt-0.5 flex items-start gap-1 text-[12px] text-sub">
                    <MapPin className="mt-0.5 size-3.5 shrink-0" /> {b.address.line1}, {b.address.city} {b.address.pincode} · {stateName(b.address.stateCode)}
                  </p>
                </div>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-bg p-3 text-[12px]">
                <div>
                  <dt className="text-mute">Manager</dt>
                  <dd className="font-semibold text-ink">{b.manager || '—'}</dd>
                </div>
                <div>
                  <dt className="text-mute">Phone</dt>
                  <dd className="flex items-center gap-1 font-semibold text-ink">
                    {b.phone ? (
                      <>
                        <Phone className="size-3" /> {b.phone}
                      </>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-mute">GSTIN</dt>
                  <dd className="font-mono font-semibold text-ink">{b.gstin || 'Not registered'}</dd>
                </div>
                <div>
                  <dt className="text-mute">{m ? 'Sales · 14 days' : 'Stock value'}</dt>
                  <dd className="font-semibold tabular-nums text-ink">{m ? lakh(m.revenue) : lakh(stockValue(state, b.id))}</dd>
                </div>
                <div>
                  <dt className="text-mute">Low stock</dt>
                  <dd className="font-semibold tabular-nums text-ink">{lowAt(state, b.id).length} items</dd>
                </div>
              </dl>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                {!b.isHq && (
                  <button
                    onClick={() => setModal({ kind: 'delete', id: b.id })}
                    aria-label={`Delete ${b.name}`}
                    title="Delete branch"
                    className="mr-auto grid size-8 place-items-center rounded-xl border border-line text-mute hover:border-coral hover:text-coral"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
                {isLive() && b.kind === 'store' && b.active && (
                  <Btn small onClick={() => setModal({ kind: 'counters', id: b.id })}>
                    <Monitor className="size-3.5" /> Counters
                  </Btn>
                )}
                <Btn small onClick={() => setModal({ kind: 'branch', id: b.id })}>
                  <Pencil className="size-3.5" /> Edit
                </Btn>
                {b.id === here.id ? (
                  <span className="flex h-8 items-center gap-1 px-2 text-[12px] font-semibold text-blue">
                    <CircleCheck className="size-3.5" /> This counter bills here
                  </span>
                ) : (
                  b.active &&
                  b.kind === 'store' && (
                    <Btn
                      small
                      primary
                      onClick={() => {
                        setCurrentBranch(b.id);
                        notify(`This computer now bills at ${b.name} (bill prefix ${b.isHq ? 'from business profile' : b.code})`);
                      }}
                    >
                      Bill from here
                    </Btn>
                  )
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );

  /* ---------- Central catalogue & branch pricing ---------- */
  const catalogueView = () => {
    const pb = branchById(state, priceBranch) ?? here;
    const needle = q.trim().toLowerCase();
    const items = catalogue.filter((c) => (!cat || c.category === cat) && (!needle || c.name.toLowerCase().includes(needle) || c.sku.toLowerCase().includes(needle)));
    const overrides = Object.keys(state.prices[pb.id] ?? {}).length;
    const unlisted = (state.unlisted[pb.id] ?? []).length;
    const active = state.branches.filter((b) => b.active);
    return (
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the central catalogue" aria-label="Search" className="h-9 w-full rounded-xl border border-line bg-bg pl-9 pr-3 outline-none focus:border-blue" />
          </div>
          <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category" className="h-9 rounded-xl border border-line bg-surface px-2.5">
            <option value="">All categories</option>
            {productCategories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-[12.5px] text-sub">
            Prices at
            <select value={pb.id} onChange={(e) => setPriceBranch(e.target.value)} aria-label="Pricing branch" className="h-9 rounded-xl border border-line bg-surface px-2.5 font-semibold text-ink">
              {shops.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mb-3 rounded-xl bg-bg px-3 py-2 text-[12px] text-sub">
          One catalogue for every branch. Base price is the MRP; a branch can sell below it (never above). {pb.name} has <b className="text-ink">{overrides}</b> branch price
          {overrides === 1 ? '' : 's'} and <b className="text-ink">{unlisted}</b> item{unlisted === 1 ? '' : 's'} not sold there.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                <Th>Item</Th>
                <Th right>Cost</Th>
                <Th right>MRP</Th>
                <Th right>Price at {pb.name}</Th>
                <Th right>Margin</Th>
                {active.map((b) => (
                  <Th key={b.id} right>
                    <span title={`Stock at ${b.name}`}>{b.code}</span>
                  </Th>
                ))}
                <Th right>Sold here</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const price = priceAt(state, pb.id, c.sku);
                const listed = listedAt(state, pb.id, c.sku);
                const margin = price ? ((price - c.cost) / price) * 100 : 0;
                return (
                  <tr key={c.sku} className={`h-11 border-t border-line ${listed ? '' : 'opacity-50'}`}>
                    <td>
                      <div className="font-semibold text-ink">{c.name}</div>
                      <div className="text-[11px] text-mute">
                        {c.sku} · {c.category}
                      </div>
                    </td>
                    <td className="text-right tabular-nums text-sub">{inrShort(c.cost)}</td>
                    <td className="text-right tabular-nums text-sub">{inrShort(c.mrp)}</td>
                    <td className="pl-3 text-right">
                      <PriceCell
                        key={`${pb.id}:${c.sku}:${price}`}
                        value={price}
                        mrp={c.mrp}
                        cost={c.cost}
                        overridden={hasOverride(state, pb.id, c.sku)}
                        label={`Price of ${c.name} at ${pb.name}`}
                        onSave={(v) => {
                          setBranchPrice(pb.id, c.sku, v === c.mrp ? null : v);
                          notify(v === c.mrp ? `${c.name} back to MRP at ${pb.name}` : `${c.name} now ${money(v)} at ${pb.name}`);
                        }}
                        onError={(m) => notify(m, true)}
                      />
                    </td>
                    <td className={`text-right tabular-nums ${margin < 0 ? 'font-semibold text-coral' : margin < 10 ? 'text-amber' : 'text-sub'}`}>{margin.toFixed(1)}%</td>
                    {active.map((b) => {
                      const n = stockAt(state, b.id, c.sku);
                      return (
                        <td key={b.id} className={`text-right tabular-nums ${b.id === pb.id ? 'font-semibold' : ''} ${listedAt(state, b.id, c.sku) && n < REORDER_AT ? 'text-coral' : 'text-sub'}`}>
                          {listedAt(state, b.id, c.sku) ? n : '—'}
                        </td>
                      );
                    })}
                    <td className="text-right">
                      <label className="inline-flex cursor-pointer items-center">
                        <input
                          type="checkbox"
                          checked={listed}
                          onChange={(e) => {
                            setListed(pb.id, c.sku, e.target.checked);
                            notify(`${c.name} ${e.target.checked ? 'listed' : 'no longer sold'} at ${pb.name}`);
                          }}
                          aria-label={`Sell ${c.name} at ${pb.name}`}
                          className="size-4 accent-[var(--blue)]"
                        />
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!items.length && <Empty>No items match.</Empty>}
      </div>
    );
  };

  /* ---------- Transfers ---------- */
  const transfersView = () => {
    const list = state.transfers.filter((t) => !trfFilter || t.status === trfFilter);
    return (
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-xl bg-bg p-1">
            {(['', 'requested', 'in-transit', 'received', 'cancelled'] as const).map((s) => (
              <button
                key={s || 'all'}
                onClick={() => setTrfFilter(s)}
                className={`h-7 rounded-lg px-2.5 text-[12px] font-semibold ${trfFilter === s ? 'bg-surface text-ink shadow-sm' : 'text-sub hover:text-ink'}`}
              >
                {s ? trfLabel[s] : 'All'}
              </button>
            ))}
          </div>
          <div className="ml-auto">
            <Btn primary onClick={() => setModal({ kind: 'transfer' })}>
              <Plus className="size-4" /> New transfer
            </Btn>
          </div>
        </div>
        {list.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[12.5px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                  <Th>Transfer</Th>
                  <Th>Route</Th>
                  <Th>Items</Th>
                  <Th right>Value</Th>
                  <th className="whitespace-nowrap pb-2 pl-5 font-medium">Document</th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {list.map((t) => {
                  const shortBy = sum(t.lines, (l) => (l.received === null ? 0 : Math.max(0, l.qty - l.received)));
                  return (
                    <tr key={t.id} className="h-12 border-t border-line">
                      <td>
                        <button onClick={() => setModal({ kind: 'view', id: t.id })} className="font-semibold text-blue hover:underline">
                          {t.id}
                        </button>
                        <div className="text-[11px] text-mute">{fmtDate(t.date)}</div>
                      </td>
                      <td className="text-ink">
                        <span className="flex items-center gap-1">
                          {branchById(state, t.from)?.name} <ArrowRight className="size-3.5 text-mute" /> {branchById(state, t.to)?.name}
                        </span>
                      </td>
                      <td className="max-w-[220px] truncate text-sub">{t.lines.map((l) => `${itemBySku(l.sku)?.name} × ${l.qty}`).join(', ')}</td>
                      <td className="text-right tabular-nums text-ink">{inrShort(Math.round(transferValue(t)))}</td>
                      <td className="pl-5 text-[12px] text-sub">{transferDoc(state, t).label}</td>
                      <td>
                        <Pill cls={trfPill[t.status]}>{trfLabel[t.status]}</Pill>
                        {shortBy > 0 && <Pill cls="ml-1 bg-amber/15 text-amber">{shortBy} short</Pill>}
                      </td>
                      <td className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {t.status === 'requested' && (
                            <>
                              <Btn small onClick={() => { cancelTransfer(t.id); notify(`${t.id} cancelled`); }}>
                                Cancel
                              </Btn>
                              <Btn small primary onClick={() => dispatch(t.id)}>
                                <Truck className="size-3.5" /> Dispatch
                              </Btn>
                            </>
                          )}
                          {t.status === 'in-transit' && (
                            <Btn small primary onClick={() => setModal({ kind: 'receive', id: t.id })}>
                              <PackageCheck className="size-3.5" /> Receive
                            </Btn>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{state.branches.length < 2 ? 'Add a second branch or warehouse to move stock between them.' : 'No transfers here.'}</Empty>
        )}
      </div>
    );
  };

  /* ---------- Branch-wise sales reports ---------- */
  const salesView = () => {
    const rows = selling.map((b, i) => ({ b, i, m: metricsFor(b, salesDays) }));
    const total = sum(rows, (r) => r.m.revenue);
    const compare = rows.map((r) => ({ name: r.b.name, Sales: r.m.revenue, 'Gross profit': r.m.profit }));
    const mix = productCategories.map((c) => ({ category: c, ...Object.fromEntries(rows.map((r) => [r.b.id, branchMix(r.b.id)[c] ?? 0])) }));
    const exportCsv = () =>
      downloadCsv(`branch-sales-${salesDays}d.csv`, [
        ['Branch', 'Code', 'State', 'Sales', 'Bills', 'Avg bill', 'Gross profit', 'Margin %', 'Share %', `Growth vs previous ${salesDays} days %`],
        ...rows.map((r) => [
          r.b.name,
          r.b.code,
          stateName(r.b.address.stateCode),
          r.m.revenue,
          r.m.bills,
          Math.round(r.m.avgBill),
          r.m.profit,
          r.m.margin.toFixed(1),
          total ? ((r.m.revenue / total) * 100).toFixed(1) : '0',
          r.m.growth === null ? '' : r.m.growth.toFixed(1),
        ]),
      ]);
    if (!rows.length) return <Empty>No branch sales yet.</Empty>;
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-xl bg-bg p-1">
            {[7, 14].map((d) => (
              <button key={d} onClick={() => setSalesDays(d)} className={`h-7 rounded-lg px-2.5 text-[12px] font-semibold ${salesDays === d ? 'bg-surface text-ink shadow-sm' : 'text-sub hover:text-ink'}`}>
                Last {d} days
              </button>
            ))}
          </div>
          <span className="text-[12px] text-mute">Sample figures until branches sync their bills</span>
          <div className="ml-auto">
            <Btn onClick={exportCsv}>
              <Download className="size-4" /> Export CSV
            </Btn>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                <Th>Branch</Th>
                <Th right>Sales</Th>
                <Th right>Share</Th>
                <Th right>Bills</Th>
                <Th right>Avg bill</Th>
                <Th right>Gross profit</Th>
                <Th right>Margin</Th>
                {salesDays === 7 && <Th right>vs prev. 7 days</Th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ b, i, m }) => (
                <tr key={b.id} className="h-11 border-t border-line">
                  <td>
                    <span className="flex items-center gap-2 font-semibold text-ink">
                      <span className="size-2.5 rounded-full" style={{ background: branchColors[i % branchColors.length] }} /> {b.name}
                    </span>
                  </td>
                  <td className="text-right font-semibold tabular-nums text-ink">{inrShort(m.revenue)}</td>
                  <td className="text-right tabular-nums text-sub">{total ? ((m.revenue / total) * 100).toFixed(1) : 0}%</td>
                  <td className="text-right tabular-nums text-sub">{m.bills.toLocaleString('en-IN')}</td>
                  <td className="text-right tabular-nums text-sub">{inrShort(Math.round(m.avgBill))}</td>
                  <td className="text-right tabular-nums text-sub">{inrShort(m.profit)}</td>
                  <td className="text-right tabular-nums text-sub">{m.margin.toFixed(1)}%</td>
                  {salesDays === 7 && (
                    <td className={`text-right font-semibold tabular-nums ${m.growth !== null && m.growth < 0 ? 'text-coral' : 'text-teal'}`}>
                      {m.growth === null ? '—' : `${m.growth >= 0 ? '+' : ''}${m.growth.toFixed(1)}%`}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-line p-4">
            <h3 className="mb-2 font-bold text-ink">Sales and profit by branch</h3>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={compare} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: 'var(--mute)', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: 'var(--mute)', fontSize: 11 }} axisLine={false} tickLine={false} width={52} tickFormatter={(v: number) => `₹${Math.round(v / 1000)}k`} />
                <Tooltip {...tip} formatter={(v: number) => inrShort(v)} cursor={{ fill: 'var(--bg)' }} />
                <Legend formatter={(k: string) => <span className="text-[12px] text-sub">{k}</span>} />
                <Bar dataKey="Sales" fill="var(--blue)" radius={[6, 6, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="Gross profit" fill="var(--teal)" radius={[6, 6, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="rounded-2xl border border-line p-4">
            <h3 className="mb-2 font-bold text-ink">Category mix (% of sales)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                    <Th>Category</Th>
                    {rows.map((r) => (
                      <Th key={r.b.id} right>
                        {r.b.code}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mix.map((row) => {
                    const vals = rows.map((r) => Number((row as Record<string, unknown>)[r.b.id] ?? 0));
                    const top = Math.max(...vals);
                    return (
                      <tr key={row.category} className="h-9 border-t border-line">
                        <td className="text-ink">{row.category}</td>
                        {vals.map((v, j) => (
                          <td key={rows[j]!.b.id} className={`text-right tabular-nums ${v === top ? 'font-bold text-blue' : 'text-sub'}`}>
                            {v}%
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11.5px] text-mute">Highlighted: the branch where the category sells strongest — useful for planning transfers and local promotions.</p>
          </div>
        </div>
      </div>
    );
  };

  /* ---------- Transfer detail ---------- */
  const detail = () => {
    if (modal?.kind !== 'view') return null;
    const t = state.transfers.find((x) => x.id === modal.id);
    if (!t) return null;
    const from = branchById(state, t.from);
    const to = branchById(state, t.to);
    const doc = transferDoc(state, t);
    return (
      <div className="space-y-4 text-[13px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[18px] font-extrabold">
            {t.id} <Pill cls={trfPill[t.status]}>{trfLabel[t.status]}</Pill>
          </DialogTitle>
          <DialogDescription className="text-sub">
            {from?.name} → {to?.name} · {doc.label}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-2 gap-3 rounded-xl bg-bg p-3 text-[12px] sm:grid-cols-4">
          {(
            [
              ['Requested', `${fmtDate(t.date)} · ${t.requestedBy}`],
              ['Dispatched', t.dispatchedOn ? fmtDate(t.dispatchedOn) : '—'],
              ['Received', t.receivedOn ? fmtDate(t.receivedOn) : '—'],
              ['Value at cost', money(transferValue(t))],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-mute">{k}</dt>
              <dd className="font-semibold text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        <p className={`rounded-xl px-3 py-2 text-[12px] ${doc.crossGstin ? 'bg-amber/15 text-ink' : 'bg-bg text-sub'}`}>
          {doc.note}
          {doc.crossGstin && ` From GSTIN ${from?.gstin} to ${to?.gstin}.`}
        </p>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
              <Th>Item</Th>
              <Th right>Sent</Th>
              <Th right>Received</Th>
              <Th right>Value</Th>
            </tr>
          </thead>
          <tbody>
            {t.lines.map((l) => (
              <tr key={l.sku} className="h-9 border-t border-line">
                <td className="text-ink">{itemBySku(l.sku)?.name}</td>
                <td className="text-right tabular-nums">{l.qty}</td>
                <td className={`text-right tabular-nums ${l.received !== null && l.received < l.qty ? 'font-semibold text-amber' : 'text-sub'}`}>{l.received ?? '—'}</td>
                <td className="text-right tabular-nums text-ink">{money(l.qty * (itemBySku(l.sku)?.cost ?? 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {t.notes && <p className="text-[12px] text-sub">Note: {t.notes}</p>}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          {t.status === 'requested' && (
            <>
              <Btn onClick={() => { cancelTransfer(t.id); close(); notify(`${t.id} cancelled`); }}>
                <RotateCcw className="size-4" /> Cancel transfer
              </Btn>
              <Btn primary onClick={() => { dispatch(t.id); close(); }}>
                <Truck className="size-4" /> Dispatch
              </Btn>
            </>
          )}
          {t.status === 'in-transit' && (
            <Btn primary onClick={() => setModal({ kind: 'receive', id: t.id })}>
              <PackageCheck className="size-4" /> Receive
            </Btn>
          )}
        </div>
      </div>
    );
  };

  /* ---------- Delete branch ---------- */
  const deleteDialog = () => {
    if (modal?.kind !== 'delete') return null;
    const b = branchById(state, modal.id);
    if (!b) return null;
    const blockers = deleteBlockers(state, b.id);
    return (
      <div className="space-y-4 text-[13px]">
        <DialogHeader>
          <DialogTitle className="text-[18px] font-extrabold">Delete {b.name}?</DialogTitle>
          <DialogDescription className="text-sub">
            {blockers.length
              ? 'This branch can’t be deleted yet.'
              : `${b.name} (${b.code}) and its branch prices will be removed. This can’t be undone.`}
          </DialogDescription>
        </DialogHeader>
        {blockers.length > 0 ? (
          <ul className="space-y-1.5 rounded-xl bg-amber/15 p-3 text-[12.5px] text-ink">
            {blockers.map((m) => (
              <li key={m} className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber" /> {m}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl bg-bg p-3 text-[12.5px] text-sub">
            It has no stock, no transfers and no sales.{b.id === here.id ? ' This computer bills here now — it will switch to the head office.' : ''}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          <Btn onClick={close}>{blockers.length ? 'OK' : 'Keep branch'}</Btn>
          {blockers.length > 0 && b.active && (
            <Btn
              onClick={() => {
                saveBranch({ ...b, active: false });
                if (state.currentId === b.id) setCurrentBranch(state.branches.find((x) => x.isHq)!.id);
                close();
                notify(`${b.name} closed — its history is kept`);
              }}
            >
              Mark as closed
            </Btn>
          )}
          {!blockers.length && (
            <button
              onClick={() => {
                const err = deleteBranch(b.id);
                close();
                if (err) notify(err, true);
                else notify(`${b.name} deleted`);
              }}
              className="flex h-9 items-center gap-1.5 rounded-xl bg-coral px-3.5 text-[12.5px] font-semibold text-onbrand shadow-md shadow-coral/25"
            >
              <Trash2 className="size-4" /> Delete branch
            </button>
          )}
        </div>
      </div>
    );
  };

  const tabs: { id: Tab; label: string; icon: IconType; count?: number }[] = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'branches', label: 'Branches', icon: Building2, count: state.branches.length },
    { id: 'catalogue', label: 'Catalogue & pricing', icon: Tags },
    { id: 'transfers', label: 'Stock transfers', icon: ArrowRightLeft, count: open.length },
    { id: 'sales', label: 'Sales reports', icon: BarChart3 },
  ];

  const editing = modal?.kind === 'branch' && modal.id ? branchById(state, modal.id) : undefined;
  const receiving = modal?.kind === 'receive' ? state.transfers.find((t) => t.id === modal.id) : undefined;
  const chain = selling.map((b) => metricsFor(b, 14));
  const today = sum(chain, (m) => m.today);
  const inTransit = state.transfers.filter((t) => t.status === 'in-transit');

  return (
    <div className="space-y-4 p-5 lg:p-6">
      <PageHead title="Branches" sub="All your stores and warehouses, one catalogue, one view of the business">
        <button onClick={() => startTransfer({ kind: 'transfer' })} className="flex h-10 items-center gap-1.5 rounded-xl card px-4 font-semibold">
          <ArrowRightLeft className="size-4" /> Transfer stock
        </button>
        <button onClick={() => setModal({ kind: 'branch' })} className="flex h-10 items-center gap-1.5 rounded-xl gbv px-5 font-semibold text-onbrand shadow-lg shadow-blue/25">
          <Plus className="size-4" /> Add branch
        </button>
      </PageHead>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Building2} label="Chain sales today" value={inrShort(today)} foot={`${selling.length} store${selling.length === 1 ? '' : 's'} billing · ${state.branches.filter((b) => b.kind === 'warehouse').length} warehouse`} tone="brand" />
        <Stat icon={BarChart3} label="Last 14 days" value={lakh(sum(chain, (m) => m.revenue))} foot={`Gross profit ${lakh(sum(chain, (m) => m.profit))}`} />
        <Stat icon={Warehouse} label="Stock across branches" value={lakh(chainStock)} foot="At cost, all locations" />
        <Stat
          icon={Truck}
          label="Transfers open"
          value={String(open.length)}
          foot={open.length ? `${inTransit.length} on the road · ${open.length - inTransit.length} waiting to dispatch` : 'Nothing moving'}
          tone={suggestions.length && !open.length ? 'alert' : undefined}
        />
      </section>

      <div className="card p-4">
        <div className="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1" role="tablist" aria-label="Branch sections">
          {tabs.map(({ id, label, icon: I, count }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => {
                setTab(id);
                setQ('');
              }}
              className={`flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[12.5px] font-semibold transition ${
                tab === id ? 'gbv text-onbrand shadow-md shadow-blue/20' : 'text-sub hover:bg-bg hover:text-ink'
              }`}
            >
              <I className="size-4" /> {label}
              {!!count && <span className={`rounded-full px-1.5 text-[10.5px] tabular-nums ${tab === id ? 'bg-onbrand/20' : 'bg-bg text-sub'}`}>{count}</span>}
            </button>
          ))}
        </div>
        {tab === 'overview' && overview()}
        {tab === 'branches' && branchesView()}
        {tab === 'catalogue' && (isLive() ? <LivePriceLists /> : catalogueView())}
        {tab === 'transfers' && (isLive() ? <LiveTransfers start={liveStart} /> : transfersView())}
        {tab === 'sales' && salesView()}
      </div>

      <Dialog open={modal !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto rounded-2xl border-line bg-surface text-ink sm:max-w-3xl [&>*]:min-w-0">
          {modal?.kind === 'branch' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">{editing ? `Edit ${editing.name}` : 'Add a branch'}</DialogTitle>
                <DialogDescription className="text-sub">
                  {editing?.isHq ? 'The head office prints the details from your business profile on bills.' : 'Bills printed here use this address, GSTIN and code as the bill prefix.'}
                </DialogDescription>
              </DialogHeader>
              <BranchForm
                state={state}
                initial={editing}
                onSubmit={(b) => {
                  saveBranch(b);
                  if (!b.active && state.currentId === b.id) setCurrentBranch(state.branches.find((x) => x.isHq)!.id);
                  close();
                  notify(editing ? `${b.name} saved` : `${b.name} added — set its prices and send it opening stock`);
                }}
                onCancel={close}
              />
            </>
          )}
          {modal?.kind === 'counters' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Counters · {branchById(state, modal.id)?.name}</DialogTitle>
                <DialogDescription className="text-sub">Billing points of this branch and the POS computers registered to them.</DialogDescription>
              </DialogHeader>
              <CountersPanel storeId={modal.id} storeCode={branchById(state, modal.id)?.code ?? ''} notify={notify} />
            </>
          )}
          {modal?.kind === 'transfer' && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Transfer stock</DialogTitle>
                <DialogDescription className="text-sub">Stock leaves the source when dispatched and reaches the destination when received.</DialogDescription>
              </DialogHeader>
              <TransferForm
                state={state}
                initial={{ from: modal.from, to: modal.to, lines: modal.lines }}
                requestedBy={session?.name ?? 'Manager'}
                onSubmit={(t) => {
                  const id = createTransfer(t);
                  close();
                  notify(`${id} requested — dispatch it when the goods leave ${branchById(state, t.from)?.name}`);
                }}
                onCancel={close}
              />
            </>
          )}
          {receiving && (
            <>
              <DialogHeader>
                <DialogTitle className="text-[18px] font-extrabold">Receive {receiving.id}</DialogTitle>
                <DialogDescription className="text-sub">Count what arrived at {branchById(state, receiving.to)?.name}.</DialogDescription>
              </DialogHeader>
              <ReceiveForm
                transfer={receiving}
                onSubmit={(got) => {
                  receiveTransfer(receiving.id, got);
                  close();
                  notify(`${receiving.id} received at ${branchById(state, receiving.to)?.name}`);
                }}
                onCancel={close}
              />
            </>
          )}
          {detail()}
          {deleteDialog()}
        </DialogContent>
      </Dialog>

      {toast && (
        <div
          role="status"
          className={`fixed bottom-6 left-1/2 z-[60] flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-2xl px-4 py-2.5 font-semibold text-onbrand shadow-2xl animate-in fade-in slide-in-from-bottom-3 ${toast.bad ? 'bg-coral' : 'bg-side'}`}
        >
          {toast.bad ? <TriangleAlert className="size-4 shrink-0" /> : <CircleCheck className="size-4 shrink-0 text-teal" />} {toast.text}
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="ml-1 text-onbrand/60 hover:text-onbrand">
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Branch price editor: commits on Enter/blur; refuses prices above MRP, warns below cost. */
function PriceCell({
  value,
  mrp,
  cost,
  overridden,
  label,
  onSave,
  onError,
}: {
  value: number;
  mrp: number;
  cost: number;
  overridden: boolean;
  label: string;
  onSave: (v: number) => void;
  onError: (m: string) => void;
}) {
  const [v, setV] = useState(String(value));
  const commit = () => {
    const n = Math.round(Number(v) * 100) / 100;
    if (!(n > 0)) {
      setV(String(value));
      return;
    }
    if (n > mrp) {
      onError(`Can't sell above MRP (${money(mrp)})`);
      setV(String(value));
      return;
    }
    if (n === value) return;
    onSave(n);
    if (n < cost) onError(`Saved, but ${money(n)} is below cost (${money(cost)}) — every sale loses money`);
  };
  return (
    <div className="inline-flex items-center gap-1.5">
      {overridden && <span className="size-1.5 rounded-full bg-vio" title="Branch price (differs from MRP)" />}
      <input
        value={v}
        onChange={(e) => setV(e.target.value.replace(/[^\d.]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        inputMode="decimal"
        aria-label={label}
        className={`h-8 w-20 rounded-lg border bg-surface px-2 text-right tabular-nums outline-none focus:border-blue ${overridden ? 'border-vio/50 font-semibold text-vio' : 'border-line text-ink'}`}
      />
    </div>
  );
}

