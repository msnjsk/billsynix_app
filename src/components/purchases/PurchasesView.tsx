'use client';

import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { CartesianGrid, Line as ChartLine, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  ArrowRight,
  Banknote,
  Check,
  CircleCheck,
  ClipboardList,
  Download,
  FileText,
  History,
  PackageCheck,
  Plus,
  ReceiptText,
  RotateCcw,
  Search,
  Send,
  TrendingUp,
  TriangleAlert,
  Truck,
  X,
} from 'lucide-react';
import { PageHead, downloadCsv } from '@/components/AppShell';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BillForm, GrnForm, PaymentForm, PoForm, ReturnForm } from '@/components/purchases/PurchaseForms';
import { money } from '@/lib/pos/billing';
import { useSession } from '@/lib/auth';
import { isLive } from '@/lib/live/session';
import { errorMessage } from '@/lib/api/client';
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  createPurchaseReturn,
  receiveGoods,
  recordSupplierPayment,
  sendPurchaseOrder,
  updatePurchaseOrder,
} from '@/lib/live/actions';
import {
  TODAY,
  ageBuckets,
  ageOf,
  billBalance,
  billStatus,
  billTotals,
  daysFromToday,
  debitedOn,
  docNo,
  fmtDate,
  gstFor,
  lastChangePct,
  lineFor,
  lineTaxable,
  returnReasons,
  matchBill,
  netRate,
  paidOn,
  poProgress,
  poStatus,
  poTotals,
  priceHistory,
  products,
  returnTotals,
  supplierById,
  supplierName,
  suppliers,
  unallocated,
  updatePurchases,
  usePurchases,
  type AgeBucket,
  type BillStatus,
  type PoStatus,
  type PurchaseState,
  type ReturnReason,
  type ReturnStatus,
} from '@/lib/purchase-data';

type IconType = ComponentType<{ className?: string | undefined }>;
type Tab = 'overview' | 'pos' | 'grns' | 'bills' | 'returns' | 'payments' | 'prices';

type Modal =
  | { kind: 'po-new' }
  | { kind: 'po-edit'; id: string }
  | { kind: 'grn-new'; poId?: string | undefined }
  | { kind: 'bill-new'; grnIds?: string[] | undefined }
  | { kind: 'return-new'; billId?: string | undefined; grnId?: string | undefined }
  | { kind: 'pay-new'; supplierId?: string | undefined; billId?: string | undefined }
  | { kind: 'view'; doc: 'po' | 'grn' | 'bill' | 'return' | 'payment'; id: string };

const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
const inrShort = (n: number) => money(n).replace(/\.00$/, '');

const poPill: Record<PoStatus, string> = {
  draft: 'bg-bg text-sub',
  sent: 'bg-blue/10 text-blue',
  partial: 'bg-amber/15 text-amber',
  received: 'bg-teal/15 text-teal',
  cancelled: 'bg-coral/10 text-coral line-through',
};
const poLabel: Record<PoStatus, string> = { draft: 'Draft', sent: 'Awaiting delivery', partial: 'Part received', received: 'Received', cancelled: 'Cancelled' };
const billPill: Record<BillStatus, string> = {
  unpaid: 'bg-blue/10 text-blue',
  partial: 'bg-amber/15 text-amber',
  paid: 'bg-teal/15 text-teal',
  overdue: 'bg-coral text-onbrand',
};
const billLabel: Record<BillStatus, string> = { unpaid: 'Unpaid', partial: 'Part paid', paid: 'Paid', overdue: 'Overdue' };
const retPill: Record<ReturnStatus, string> = { pending: 'bg-amber/15 text-amber', dispatched: 'bg-blue/10 text-blue', settled: 'bg-teal/15 text-teal' };
const retLabel: Record<ReturnStatus, string> = { pending: 'To dispatch', dispatched: 'With supplier', settled: 'Settled' };
const supplierColors = ['var(--blue)', 'var(--vio)', 'var(--teal)', 'var(--amber)', 'var(--coral)'];

function Pill({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}

function Stat({ icon: I, label, value, foot, tone }: { icon: IconType; label: string; value: string; foot: string; tone?: 'alert' | 'brand' }) {
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

function Toolbar({
  q,
  setQ,
  supplier,
  setSupplier,
  placeholder,
  children,
}: {
  q: string;
  setQ: (v: string) => void;
  supplier: string;
  setSupplier: (v: string) => void;
  placeholder: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="relative min-w-[220px] flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-label="Search"
          className="h-9 w-full rounded-xl border border-line bg-bg pl-9 pr-3 outline-none focus:border-blue"
        />
      </div>
      <select value={supplier} onChange={(e) => setSupplier(e.target.value)} aria-label="Supplier" className="h-9 rounded-xl border border-line bg-surface px-2.5">
        <option value="">All suppliers</option>
        {suppliers.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-bg py-10 text-center text-sub">{children}</p>;
}

const Th = ({ children, right }: { children?: ReactNode; right?: boolean }) => (
  <th className={`pb-2 font-medium ${right ? 'text-right' : ''}`}>{children}</th>
);

/* =====================================================================
   Detail views
   ===================================================================== */

function LinesTable({ lines, extra }: { lines: { name: string; qty: number; rate: number; discountPct: number; gst: number }[]; extra?: ReactNode }) {
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
          <Th>Item</Th>
          <Th right>Qty</Th>
          <Th right>Rate</Th>
          <Th right>Disc</Th>
          <Th right>GST</Th>
          <Th right>Amount</Th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i} className="h-9 border-t border-line">
            <td className="text-ink">{l.name}</td>
            <td className="text-right tabular-nums">{l.qty}</td>
            <td className="text-right tabular-nums text-sub">{money(l.rate)}</td>
            <td className="text-right tabular-nums text-sub">{l.discountPct ? `${l.discountPct}%` : '—'}</td>
            <td className="text-right tabular-nums text-sub">{l.gst}%</td>
            <td className="text-right font-semibold tabular-nums text-ink">{money(lineTaxable(l))}</td>
          </tr>
        ))}
      </tbody>
      {extra}
    </table>
  );
}

function TotalsRows({ t, gstApplies, interState }: { t: ReturnType<typeof billTotals>; gstApplies: boolean; interState: boolean }) {
  const r = (k: string, v: string, bold?: boolean) => (
    <tr className={bold ? 'font-extrabold text-ink' : 'text-sub'}>
      <td colSpan={5} className="pt-1 text-right">
        {k}
      </td>
      <td className="pt-1 text-right tabular-nums">{v}</td>
    </tr>
  );
  return (
    <tfoot className="border-t border-line">
      {r('Taxable value', money(t.taxable))}
      {gstApplies ? (interState ? r('IGST', money(t.igst)) : (<>{r('CGST', money(t.cgst))}{r('SGST', money(t.sgst))}</>)) : r('GST', 'Not charged')}
      {t.roundOff !== 0 && r('Round off', money(t.roundOff))}
      {r('Total', money(t.total), true)}
    </tfoot>
  );
}

function Meta({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 rounded-xl bg-bg p-3 text-[12px] sm:grid-cols-4">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-mute">{k}</dt>
          <dd className="font-semibold text-ink">{v || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

function ActionBar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">{children}</div>;
}
const Btn = ({ onClick, children, primary }: { onClick: () => void; children: ReactNode; primary?: boolean }) => (
  <button
    onClick={onClick}
    className={`flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-[12.5px] font-semibold ${primary ? 'gbv text-onbrand shadow-md shadow-blue/20' : 'border border-line text-ink hover:border-blue'}`}
  >
    {children}
  </button>
);

/* =====================================================================
   Price history chart
   ===================================================================== */

function PriceChart({ sku, state }: { sku: string; state: PurchaseState }) {
  const h = priceHistory(sku, state);
  const supplierIds = [...new Set(h.map((p) => p.supplierId))];
  const data = h.map((p) => ({ label: fmtDate(p.date), [p.supplierId]: p.rate, source: p.source }));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--line)" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: 'var(--mute)', fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: 'var(--mute)', fontSize: 11 }} axisLine={false} tickLine={false} width={48} domain={['auto', 'auto']} tickFormatter={(v: number) => `₹${v}`} />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 12 }}
          formatter={(v: number, k: string) => [money(v), supplierName(k)]}
        />
        {supplierIds.map((id, i) => (
          <ChartLine
            key={id}
            type="monotone"
            dataKey={id}
            connectNulls
            stroke={supplierColors[i % supplierColors.length]}
            strokeWidth={2.5}
            dot={{ r: 3.5, fill: 'var(--surface)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/* =====================================================================
   Main view
   ===================================================================== */

export function PurchasesView() {
  const state = usePurchases();
  const session = useSession();
  const [tab, setTab] = useState<Tab>('overview');
  const [modal, setModal] = useState<Modal | null>(null);
  const [q, setQ] = useState('');
  const [supplier, setSupplier] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [priceSku, setPriceSku] = useState<string>(products[0]?.sku ?? '');

  const notify = (t: string) => {
    setToast(t);
    window.setTimeout(() => setToast(null), 3200);
  };
  const close = () => setModal(null);
  const view = (doc: 'po' | 'grn' | 'bill' | 'return' | 'payment', id: string) => setModal({ kind: 'view', doc, id });

  /* ---------- derived ---------- */
  const billed = new Set(state.bills.flatMap((b) => b.grnIds));
  const openPos = state.pos.filter((p) => ['sent', 'partial'].includes(poStatus(p, state.grns)));
  const unbilledGrns = state.grns.filter((g) => !billed.has(g.id));
  const openBills = state.bills.filter((b) => billBalance(b, state) > 0.5);
  const payable = sum(openBills, (b) => billBalance(b, state));
  const overdue = openBills.filter((b) => billStatus(b, state) === 'overdue');
  const monthBills = state.bills.filter((b) => b.date.slice(0, 7) === TODAY.slice(0, 7));
  const monthTotals = monthBills.map(billTotals);
  const pendingReturns = state.returns.filter((r) => r.status !== 'settled');
  const dueSoon = openBills.filter((b) => daysFromToday(b.dueDate) >= 0 && daysFromToday(b.dueDate) <= 7);

  const ageing = useMemo(() => {
    const rows = suppliers.map((s) => {
      const bills = state.bills.filter((b) => b.supplierId === s.id && billBalance(b, state) > 0.5);
      const by: Record<AgeBucket, number> = { current: 0, d1_30: 0, d31_60: 0, d60: 0 };
      for (const b of bills) by[ageOf(b)] += billBalance(b, state);
      const advance = sum(state.payments.filter((p) => p.supplierId === s.id), unallocated);
      return { s, by, total: sum(bills, (b) => billBalance(b, state)), advance };
    });
    return rows.filter((r) => r.total > 0.5 || r.advance > 0.5);
  }, [state]);

  const priceAlerts = useMemo(
    () =>
      products
        .map((p) => ({ p, h: priceHistory(p.sku, state) }))
        .filter(({ h }) => h.length >= 2 && lastChangePct(h) >= 5)
        .map(({ p, h }) => ({ p, change: lastChangePct(h), last: h[h.length - 1]!.rate, prev: h[h.length - 2]!.rate })),
    [state]
  );

  const match = (s: string, ...fields: string[]) => !q || fields.some((f) => f.toLowerCase().includes(s.toLowerCase()));

  /* ---------- actions ---------- */
  const createPo = (po: Parameters<NonNullable<Parameters<typeof PoForm>[0]['onSubmit']>>[0]) => {
    if (isLive()) {
      createPurchaseOrder(po)
        .then((r) => {
          close();
          notify(r.message ?? `${r.number} ${po.status === 'draft' ? 'saved as draft' : 'created and sent'}`);
        })
        .catch((e: unknown) => notify(errorMessage(e)));
      return;
    }
    const id = docNo.po(state.next.po);
    updatePurchases((s) => ({ ...s, pos: [{ id, ...po }, ...s.pos], next: { ...s.next, po: s.next.po + 1 } }));
    close();
    notify(`${id} ${po.status === 'draft' ? 'saved as draft' : 'created and marked sent'}`);
  };

  /* ---------- tabs ---------- */
  const tabs: { id: Tab; label: string; icon: IconType; count?: number }[] = [
    { id: 'overview', label: 'Overview', icon: ClipboardList },
    { id: 'pos', label: 'Purchase orders', icon: FileText, count: openPos.length },
    { id: 'grns', label: 'Goods received', icon: PackageCheck, count: unbilledGrns.length },
    { id: 'bills', label: 'Supplier bills', icon: ReceiptText, count: openBills.length },
    { id: 'returns', label: 'Returns', icon: RotateCcw, count: pendingReturns.length },
    { id: 'payments', label: 'Payments', icon: Banknote },
    { id: 'prices', label: 'Price history', icon: TrendingUp, count: priceAlerts.length },
  ];

  /* ---------- views per tab ---------- */
  const posView = () => {
    const rows = state.pos.filter(
      (p) => (!supplier || p.supplierId === supplier) && (!statusFilter || poStatus(p, state.grns) === statusFilter) && match(q, p.id, supplierName(p.supplierId), p.notes)
    );
    return (
      <>
        <Toolbar q={q} setQ={setQ} supplier={supplier} setSupplier={setSupplier} placeholder="Search PO no., supplier, notes…">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Status" className="h-9 rounded-xl border border-line bg-surface px-2.5">
            <option value="">Any status</option>
            {(Object.keys(poLabel) as PoStatus[]).map((s) => (
              <option key={s} value={s}>
                {poLabel[s]}
              </option>
            ))}
          </select>
          <Btn
            onClick={() =>
              downloadCsv('purchase-orders.csv', [
                ['PO', 'Supplier', 'Date', 'Expected', 'Status', 'Items', 'Value'],
                ...rows.map((p) => [p.id, supplierName(p.supplierId), p.date, p.expected, poLabel[poStatus(p, state.grns)], p.lines.length, poTotals(p).total]),
              ])
            }
          >
            <Download className="size-4" /> CSV
          </Btn>
        </Toolbar>
        {rows.length === 0 ? (
          <Empty>No purchase orders yet. Create one to order stock from a supplier.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                  <Th>PO</Th>
                  <Th>Supplier</Th>
                  <Th>Ordered</Th>
                  <Th>Expected</Th>
                  <Th>Received</Th>
                  <Th right>Value</Th>
                  <Th right>Status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const st = poStatus(p, state.grns);
                  const prog = poProgress(p, state.grns);
                  const late = ['sent', 'partial'].includes(st) && daysFromToday(p.expected) < 0;
                  return (
                    <tr key={p.id} onClick={() => view('po', p.id)} className="h-12 cursor-pointer border-t border-line hover:bg-bg">
                      <td className="font-semibold text-blue">{p.id}</td>
                      <td className="text-ink">{supplierName(p.supplierId)}</td>
                      <td className="tabular-nums text-sub">{fmtDate(p.date)}</td>
                      <td className={`tabular-nums ${late ? 'font-semibold text-coral' : 'text-sub'}`}>
                        {fmtDate(p.expected)}
                        {late && ' · late'}
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-line">
                            <div className={`h-full rounded-full ${prog.pct >= 100 ? 'bg-teal' : 'bg-amber'}`} style={{ width: `${prog.pct}%` }} />
                          </div>
                          <span className="text-[11px] tabular-nums text-sub">{prog.pct}%</span>
                        </div>
                      </td>
                      <td className="text-right font-semibold tabular-nums text-ink">{inrShort(poTotals(p).total)}</td>
                      <td className="text-right">
                        <Pill cls={poPill[st]}>{poLabel[st]}</Pill>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  };

  const grnsView = () => {
    const rows = state.grns.filter((g) => (!supplier || g.supplierId === supplier) && match(q, g.id, g.poId ?? '', supplierName(g.supplierId), g.supplierChallan));
    return (
      <>
        <Toolbar q={q} setQ={setQ} supplier={supplier} setSupplier={setSupplier} placeholder="Search GRN, PO, challan…" />
        {rows.length === 0 ? (
          <Empty>No goods received yet. Record a delivery when stock arrives.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                  <Th>GRN</Th>
                  <Th>Supplier</Th>
                  <Th>Received</Th>
                  <Th>Against PO</Th>
                  <Th right>Accepted</Th>
                  <Th right>Rejected</Th>
                  <Th right>Bill</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => {
                  const acc = sum(g.lines, (l) => l.received - l.rejected);
                  const rej = sum(g.lines, (l) => l.rejected);
                  const bill = state.bills.find((b) => b.grnIds.includes(g.id));
                  return (
                    <tr key={g.id} onClick={() => view('grn', g.id)} className="h-12 cursor-pointer border-t border-line hover:bg-bg">
                      <td className="font-semibold text-blue">{g.id}</td>
                      <td className="text-ink">{supplierName(g.supplierId)}</td>
                      <td className="tabular-nums text-sub">
                        {fmtDate(g.date)} · {g.receivedBy}
                      </td>
                      <td className="text-sub">{g.poId ?? 'Direct'}</td>
                      <td className="text-right tabular-nums">{acc}</td>
                      <td className={`text-right tabular-nums ${rej ? 'font-semibold text-coral' : 'text-mute'}`}>{rej || '—'}</td>
                      <td className="text-right">{bill ? <Pill cls="bg-teal/15 text-teal">{bill.number}</Pill> : <Pill cls="bg-amber/15 text-amber">Awaiting bill</Pill>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  };

  const billsView = () => {
    const rows = state.bills.filter(
      (b) => (!supplier || b.supplierId === supplier) && (!statusFilter || billStatus(b, state) === statusFilter) && match(q, b.id, b.number, supplierName(b.supplierId))
    );
    return (
      <>
        <Toolbar q={q} setQ={setQ} supplier={supplier} setSupplier={setSupplier} placeholder="Search bill no., supplier…">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Status" className="h-9 rounded-xl border border-line bg-surface px-2.5">
            <option value="">Any status</option>
            {(Object.keys(billLabel) as BillStatus[]).map((s) => (
              <option key={s} value={s}>
                {billLabel[s]}
              </option>
            ))}
          </select>
          <Btn
            onClick={() =>
              downloadCsv('supplier-bills.csv', [
                ['Ref', 'Supplier', 'Supplier GSTIN', 'Bill no.', 'Bill date', 'Due', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total', 'Paid', 'Debit notes', 'Balance', 'Status'],
                ...rows.map((b) => {
                  const t = billTotals(b);
                  return [b.id, supplierName(b.supplierId), supplierById(b.supplierId)?.gstin ?? '', b.number, b.date, b.dueDate, t.taxable, t.cgst, t.sgst, t.igst, t.total, paidOn(b.id, state.payments), debitedOn(b.id, state.returns), billBalance(b, state), billLabel[billStatus(b, state)]];
                }),
              ])
            }
          >
            <Download className="size-4" /> Purchase register
          </Btn>
        </Toolbar>
        {rows.length === 0 ? (
          <Empty>No supplier bills yet. Enter a bill when it arrives with the goods.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                  <Th>Bill</Th>
                  <Th>Supplier</Th>
                  <Th>Dated · due</Th>
                  <Th>Match</Th>
                  <Th right>Total</Th>
                  <Th right>Balance</Th>
                  <Th right>Status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => {
                  const st = billStatus(b, state);
                  const issues = matchBill(b, state);
                  return (
                    <tr key={b.id} onClick={() => view('bill', b.id)} className="h-12 cursor-pointer border-t border-line hover:bg-bg">
                      <td>
                        <div className="font-semibold text-blue">{b.number}</div>
                        <div className="text-[11px] text-mute">{b.id}</div>
                      </td>
                      <td className="text-ink">{supplierName(b.supplierId)}</td>
                      <td className="tabular-nums text-sub">
                        {fmtDate(b.date)} · <span className={st === 'overdue' ? 'font-semibold text-coral' : ''}>{fmtDate(b.dueDate)}</span>
                      </td>
                      <td>
                        {b.grnIds.length === 0 ? (
                          <span className="text-[11px] text-mute">No GRN</span>
                        ) : issues.length ? (
                          <Pill cls="bg-amber/15 text-amber">
                            {issues.length} difference{issues.length === 1 ? '' : 's'}
                          </Pill>
                        ) : (
                          <Pill cls="bg-teal/15 text-teal">Matched</Pill>
                        )}
                      </td>
                      <td className="text-right tabular-nums text-sub">{inrShort(billTotals(b).total)}</td>
                      <td className="text-right font-semibold tabular-nums text-ink">{inrShort(billBalance(b, state))}</td>
                      <td className="text-right">
                        <Pill cls={billPill[st]}>{billLabel[st]}</Pill>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  };

  const returnsView = () => {
    const rows = state.returns.filter((r) => (!supplier || r.supplierId === supplier) && match(q, r.id, supplierName(r.supplierId)));
    return (
      <>
        <Toolbar q={q} setQ={setQ} supplier={supplier} setSupplier={setSupplier} placeholder="Search debit note, supplier…" />
        {rows.length === 0 ? (
          <Empty>No purchase returns. Return damaged, expired or wrong items from a goods receipt or a bill.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                  <Th>Debit note</Th>
                  <Th>Supplier</Th>
                  <Th>Date</Th>
                  <Th>Against</Th>
                  <Th>Reason</Th>
                  <Th right>Value</Th>
                  <Th right>Status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => view('return', r.id)} className="h-12 cursor-pointer border-t border-line hover:bg-bg">
                    <td className="font-semibold text-blue">{r.id}</td>
                    <td className="text-ink">{supplierName(r.supplierId)}</td>
                    <td className="tabular-nums text-sub">{fmtDate(r.date)}</td>
                    <td className="text-sub">{state.bills.find((b) => b.id === r.billId)?.number ?? r.grnId ?? '—'}</td>
                    <td className="text-sub">{[...new Set(r.lines.map((l) => l.reason))].join(', ')}</td>
                    <td className="text-right font-semibold tabular-nums text-ink">{inrShort(returnTotals(r).total)}</td>
                    <td className="text-right">
                      <Pill cls={retPill[r.status]}>{retLabel[r.status]}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  };

  const paymentsView = () => {
    const rows = state.payments.filter((p) => (!supplier || p.supplierId === supplier) && match(q, p.id, p.ref, supplierName(p.supplierId)));
    return (
      <div className="space-y-5">
        <div>
          <h3 className="mb-2 font-bold text-ink">What we owe — by age</h3>
          {ageing.length === 0 ? (
            <Empty>Nothing owed to suppliers.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                    <Th>Supplier</Th>
                    {(Object.keys(ageBuckets) as AgeBucket[]).map((k) => (
                      <Th key={k} right>
                        {ageBuckets[k]}
                      </Th>
                    ))}
                    <Th right>Advance</Th>
                    <Th right>Outstanding</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {ageing.map(({ s, by, total, advance }) => (
                    <tr key={s.id} className="h-11 border-t border-line">
                      <td className="font-semibold text-ink">{s.name}</td>
                      {(Object.keys(ageBuckets) as AgeBucket[]).map((k) => (
                        <td key={k} className={`text-right tabular-nums ${by[k] > 0 && k !== 'current' ? 'font-semibold text-coral' : 'text-sub'}`}>
                          {by[k] > 0 ? inrShort(by[k]) : '—'}
                        </td>
                      ))}
                      <td className="text-right tabular-nums text-teal">{advance > 0.5 ? inrShort(advance) : '—'}</td>
                      <td className="text-right font-extrabold tabular-nums text-ink">{inrShort(total)}</td>
                      <td className="text-right">
                        {total > 0.5 && (
                          <button onClick={() => setModal({ kind: 'pay-new', supplierId: s.id })} className="text-[12px] font-semibold text-blue">
                            Pay
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <h3 className="mb-2 font-bold text-ink">Payments made</h3>
          <Toolbar q={q} setQ={setQ} supplier={supplier} setSupplier={setSupplier} placeholder="Search payment, UTR, cheque…" />
          {rows.length === 0 ? (
            <Empty>No payments recorded.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                    <Th>Payment</Th>
                    <Th>Supplier</Th>
                    <Th>Date</Th>
                    <Th>Mode · ref</Th>
                    <Th>Applied to</Th>
                    <Th right>Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} onClick={() => view('payment', p.id)} className="h-12 cursor-pointer border-t border-line hover:bg-bg">
                      <td className="font-semibold text-blue">{p.id}</td>
                      <td className="text-ink">{supplierName(p.supplierId)}</td>
                      <td className="tabular-nums text-sub">{fmtDate(p.date)}</td>
                      <td className="text-sub">
                        {p.mode}
                        {p.ref && <span className="font-mono text-[11.5px]"> · {p.ref}</span>}
                      </td>
                      <td className="text-sub">
                        {p.allocations.map((a) => state.bills.find((b) => b.id === a.billId)?.number ?? a.billId).join(', ') || 'Advance'}
                      </td>
                      <td className="text-right font-semibold tabular-nums text-ink">{inrShort(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  };

  const pricesView = () => {
    const list = products
      .map((p) => {
        const h = priceHistory(p.sku, state);
        return { p, h, last: h[h.length - 1], change: lastChangePct(h) };
      })
      .filter(({ p }) => match(q, p.name, p.supplier));
    const sel = list.find((x) => x.p.sku === priceSku) ?? list[0];
    const h = sel?.h ?? [];
    const min = h.length ? Math.min(...h.map((x) => x.rate)) : 0;
    const max = h.length ? Math.max(...h.map((x) => x.rate)) : 0;
    return (
      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div>
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items…" aria-label="Search items" className="h-9 w-full rounded-xl border border-line bg-bg pl-9 pr-3 outline-none focus:border-blue" />
          </div>
          <ul className="max-h-[420px] divide-y divide-line overflow-y-auto rounded-xl border border-line">
            {list.map(({ p, last, change }) => (
              <li key={p.sku}>
                <button
                  onClick={() => setPriceSku(p.sku)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left ${sel?.p.sku === p.sku ? 'bg-blue/5' : 'hover:bg-bg'}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-ink">{p.name}</span>
                    <span className="block text-[11px] text-mute">{last ? `Last cost ${money(last.rate)}` : `Catalogue cost ${money(p.cost)}`}</span>
                  </span>
                  {change !== 0 && <span className={`text-[11px] font-bold tabular-nums ${change > 0 ? 'text-coral' : 'text-teal'}`}>{change > 0 ? '▲' : '▼'} {Math.abs(change)}%</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          {!sel || h.length === 0 ? (
            <Empty>No purchases of this item yet — its cost history starts with the first supplier bill.</Empty>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-[16px] font-bold text-ink">{sel.p.name}</h3>
                  <p className="text-[12px] text-sub">Cost per unit after supplier discount, before GST</p>
                </div>
                <div className="flex gap-5 text-right text-[12px]">
                  <div>
                    <div className="text-mute">Latest</div>
                    <div className="text-[18px] font-extrabold tabular-nums text-ink">{money(h[h.length - 1]!.rate)}</div>
                  </div>
                  <div>
                    <div className="text-mute">Lowest · highest</div>
                    <div className="font-semibold tabular-nums text-sub">
                      {money(min)} · {money(max)}
                    </div>
                  </div>
                  <div>
                    <div className="text-mute">Selling price</div>
                    <div className="font-semibold tabular-nums text-sub">
                      {money(sel.p.price)} <span className="text-teal">({Math.round(((sel.p.price - h[h.length - 1]!.rate) / sel.p.price) * 100)}% margin)</span>
                    </div>
                  </div>
                </div>
              </div>
              <PriceChart sku={sel.p.sku} state={state} />
              <table className="mt-3 w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                    <Th>Date</Th>
                    <Th>Supplier</Th>
                    <Th>Source</Th>
                    <Th right>Cost</Th>
                    <Th right>Change</Th>
                  </tr>
                </thead>
                <tbody>
                  {[...h].reverse().map((pt, i, arr) => {
                    const prev = arr[i + 1];
                    const ch = prev ? Math.round(((pt.rate - prev.rate) / prev.rate) * 1000) / 10 : 0;
                    return (
                      <tr key={`${pt.date}-${i}`} className="h-9 border-t border-line">
                        <td className="tabular-nums text-sub">{fmtDate(pt.date)}</td>
                        <td className="text-ink">{supplierName(pt.supplierId)}</td>
                        <td className="text-sub">{pt.source}</td>
                        <td className="text-right font-semibold tabular-nums text-ink">{money(pt.rate)}</td>
                        <td className={`text-right tabular-nums ${ch > 0 ? 'text-coral' : ch < 0 ? 'text-teal' : 'text-mute'}`}>{ch ? `${ch > 0 ? '+' : ''}${ch}%` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    );
  };

  const overview = () => (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-3">
        {[
          {
            title: 'Awaiting delivery',
            icon: Truck,
            items: openPos.map((p) => ({ id: p.id, line1: supplierName(p.supplierId), line2: `Expected ${fmtDate(p.expected)} · ${poProgress(p, state.grns).pct}% received`, late: daysFromToday(p.expected) < 0, amount: poTotals(p).total, open: () => view('po', p.id), action: { label: 'Receive', run: () => setModal({ kind: 'grn-new', poId: p.id }) } })),
            empty: 'No open purchase orders.',
          },
          {
            title: 'Received — bill not entered',
            icon: PackageCheck,
            items: unbilledGrns.map((g) => ({ id: g.id, line1: supplierName(g.supplierId), line2: `Received ${fmtDate(g.date)}${g.poId ? ` · ${g.poId}` : ''}`, late: daysFromToday(g.date) < -3, amount: null as number | null, open: () => view('grn', g.id), action: { label: 'Enter bill', run: () => setModal({ kind: 'bill-new', grnIds: [g.id] }) } })),
            empty: 'Every delivery has its bill entered.',
          },
          {
            title: 'Bills to pay',
            icon: Banknote,
            items: [...openBills]
              .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
              .map((b) => ({ id: b.number, line1: supplierName(b.supplierId), line2: daysFromToday(b.dueDate) < 0 ? `Overdue by ${-daysFromToday(b.dueDate)} day${daysFromToday(b.dueDate) === -1 ? '' : 's'}` : `Due ${fmtDate(b.dueDate)}`, late: daysFromToday(b.dueDate) < 0, amount: billBalance(b, state), open: () => view('bill', b.id), action: { label: 'Pay', run: () => setModal({ kind: 'pay-new', billId: b.id }) } })),
            empty: 'All supplier bills are paid.',
          },
        ].map((col) => (
          <section key={col.title} className="rounded-2xl border border-line bg-bg/60 p-3">
            <h3 className="mb-2 flex items-center gap-2 px-1 text-[13px] font-bold text-ink">
              <col.icon className="size-4 text-blue" /> {col.title}
              <span className="rounded-full bg-surface px-2 text-[11px] font-semibold text-sub">{col.items.length}</span>
            </h3>
            {col.items.length === 0 ? (
              <p className="rounded-xl bg-surface px-3 py-6 text-center text-[12.5px] text-sub">
                <CircleCheck className="mx-auto mb-1 size-5 text-teal" />
                {col.empty}
              </p>
            ) : (
              <ul className="space-y-2">
                {col.items.slice(0, 5).map((it) => (
                  <li key={it.id} className={`rounded-xl border bg-surface p-3 ${it.late ? 'border-coral/40' : 'border-line'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <button onClick={it.open} className="min-w-0 text-left">
                        <div className="font-bold text-ink hover:text-blue">{it.id}</div>
                        <div className="truncate text-[12px] text-sub">{it.line1}</div>
                      </button>
                      {it.amount !== null && <b className="tabular-nums text-ink">{inrShort(it.amount)}</b>}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className={`text-[11.5px] ${it.late ? 'font-semibold text-coral' : 'text-mute'}`}>{it.line2}</span>
                      <button onClick={it.action.run} className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[11.5px] font-semibold text-ink hover:border-blue">
                        {it.action.label} <ArrowRight className="size-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
                {col.items.length > 5 && <li className="px-1 text-[12px] text-sub">+{col.items.length - 5} more</li>}
              </ul>
            )}
          </section>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="card p-4">
          <h3 className="mb-3 flex items-center gap-2 font-bold text-ink">
            <TrendingUp className="size-4 text-coral" /> Cost increases (5% or more)
          </h3>
          {priceAlerts.length === 0 ? (
            <p className="text-sub">No big cost changes on recent bills.</p>
          ) : (
            <ul className="space-y-2">
              {priceAlerts.map(({ p, change, last, prev }) => (
                <li key={p.sku} className="flex items-center justify-between gap-2">
                  <button
                    onClick={() => {
                      setPriceSku(p.sku);
                      setTab('prices');
                      setQ('');
                    }}
                    className="min-w-0 text-left"
                  >
                    <div className="truncate font-semibold text-ink hover:text-blue">{p.name}</div>
                    <div className="text-[11.5px] text-sub">
                      {money(prev)} → {money(last)} · sells at {money(p.price)}
                    </div>
                  </button>
                  <span className="rounded-full bg-coral/15 px-2 py-0.5 text-[11px] font-bold text-coral">+{change}%</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11.5px] text-mute">Check whether selling prices still give enough margin.</p>
        </section>
        <section className="card p-4">
          <h3 className="mb-3 flex items-center gap-2 font-bold text-ink">
            <RotateCcw className="size-4 text-amber" /> Returns in progress
          </h3>
          {pendingReturns.length === 0 ? (
            <p className="text-sub">No returns waiting.</p>
          ) : (
            <ul className="space-y-2">
              {pendingReturns.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <button onClick={() => view('return', r.id)} className="min-w-0 text-left">
                    <div className="font-semibold text-ink hover:text-blue">
                      {r.id} · {supplierName(r.supplierId)}
                    </div>
                    <div className="text-[11.5px] text-sub">{r.lines.map((l) => `${l.qty} × ${l.name} (${l.reason.toLowerCase()})`).join(', ')}</div>
                  </button>
                  <div className="text-right">
                    <div className="font-semibold tabular-nums text-ink">{inrShort(returnTotals(r).total)}</div>
                    <Pill cls={retPill[r.status]}>{retLabel[r.status]}</Pill>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );

  /* ---------- detail dialog ---------- */
  const detail = () => {
    if (!modal || modal.kind !== 'view') return null;
    if (modal.doc === 'po') {
      const p = state.pos.find((x) => x.id === modal.id);
      if (!p) return null;
      const st = poStatus(p, state.grns);
      const prog = poProgress(p, state.grns);
      const t = poTotals(p);
      const s = supplierById(p.supplierId);
      return (
        <>
          <DialogHeader>
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle className="text-[18px] font-extrabold">{p.id}</DialogTitle>
              <Pill cls={poPill[st]}>{poLabel[st]}</Pill>
            </div>
            <DialogDescription className="text-sub">
              {s?.name} · ordered {fmtDate(p.date)}
            </DialogDescription>
          </DialogHeader>
          <Meta items={[['Supplier', s?.name], ['Contact', `${s?.contact ?? ''} ${s?.phone ?? ''}`], ['Expected', fmtDate(p.expected)], ['Received', `${prog.received} of ${prog.ordered} (${prog.pct}%)`]]} />
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                <Th>Item</Th>
                <Th right>Ordered</Th>
                <Th right>Received</Th>
                <Th right>Rate</Th>
                <Th right>Amount</Th>
              </tr>
            </thead>
            <tbody>
              {prog.lines.map((l) => (
                <tr key={l.sku} className="h-9 border-t border-line">
                  <td className="text-ink">{l.name}</td>
                  <td className="text-right tabular-nums">{l.qty}</td>
                  <td className={`text-right tabular-nums ${l.received >= l.qty ? 'text-teal' : l.received ? 'text-amber' : 'text-mute'}`}>{l.received}</td>
                  <td className="text-right tabular-nums text-sub">{money(l.rate)}</td>
                  <td className="text-right font-semibold tabular-nums text-ink">{money(lineTaxable(l))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-extrabold text-ink">
                <td colSpan={4} className="pt-2 text-right">
                  Order value (incl. GST)
                </td>
                <td className="pt-2 text-right tabular-nums">{money(t.total)}</td>
              </tr>
            </tfoot>
          </table>
          {p.notes && <p className="rounded-xl bg-bg px-3 py-2 text-[12.5px] text-sub">Note: {p.notes}</p>}
          <ActionBar>
            {st === 'draft' && (
              <>
                <Btn onClick={() => setModal({ kind: 'po-edit', id: p.id })}>Edit</Btn>
                <Btn
                  primary
                  onClick={() => {
                    if (isLive()) {
                      sendPurchaseOrder(p.id)
                        .then((r) => notify(r.message ?? `Sent to ${s?.name}`))
                        .catch((e: unknown) => notify(errorMessage(e)));
                      return;
                    }
                    updatePurchases((x) => ({ ...x, pos: x.pos.map((o) => (o.id === p.id ? { ...o, status: 'sent' } : o)) }));
                    notify(`${p.id} marked sent to ${s?.name}`);
                  }}
                >
                  <Send className="size-4" /> Mark sent
                </Btn>
              </>
            )}
            {['draft', 'sent'].includes(st) && (
              <Btn
                onClick={() => {
                  if (!window.confirm(`Cancel ${p.id}?`)) return;
                  if (isLive()) {
                    cancelPurchaseOrder(p.id)
                      .then(() => notify('Purchase order cancelled'))
                      .catch((e: unknown) => notify(errorMessage(e)));
                    return;
                  }
                  updatePurchases((x) => ({ ...x, pos: x.pos.map((o) => (o.id === p.id ? { ...o, status: 'cancelled' } : o)) }));
                  notify(`${p.id} cancelled`);
                }}
              >
                Cancel PO
              </Btn>
            )}
            <Btn
              onClick={() =>
                downloadCsv(`${p.id}.csv`, [
                  ['Purchase order', p.id, 'Supplier', s?.name ?? '', 'Date', p.date, 'Expected', p.expected],
                  ['Item', 'HSN', 'Qty', 'Rate', 'GST %', 'Amount'],
                  ...p.lines.map((l) => [l.name, l.hsn, l.qty, l.rate, l.gst, lineTaxable(l)]),
                  ['', '', '', '', 'Total', t.total],
                ])
              }
            >
              <Download className="size-4" /> Download
            </Btn>
            {['sent', 'partial'].includes(st) && (
              <Btn primary onClick={() => setModal({ kind: 'grn-new', poId: p.id })}>
                <PackageCheck className="size-4" /> Receive goods
              </Btn>
            )}
          </ActionBar>
        </>
      );
    }
    if (modal.doc === 'grn') {
      const g = state.grns.find((x) => x.id === modal.id);
      if (!g) return null;
      const bill = state.bills.find((b) => b.grnIds.includes(g.id));
      const rejected = g.lines.filter((l) => l.rejected > 0);
      const returned = state.returns.some((r) => r.grnId === g.id);
      return (
        <>
          <DialogHeader>
            <DialogTitle className="text-[18px] font-extrabold">{g.id}</DialogTitle>
            <DialogDescription className="text-sub">
              {supplierName(g.supplierId)} · received {fmtDate(g.date)} by {g.receivedBy}
            </DialogDescription>
          </DialogHeader>
          <Meta items={[['Against PO', g.poId ?? 'Direct delivery'], ['Supplier challan', g.supplierChallan], ['Bill', bill?.number ?? 'Not entered yet'], ['Notes', g.notes]]} />
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                <Th>Item</Th>
                <Th right>Received</Th>
                <Th right>Rejected</Th>
                <Th right>Accepted</Th>
                <Th>Batch · expiry</Th>
              </tr>
            </thead>
            <tbody>
              {g.lines.map((l) => (
                <tr key={l.sku} className="h-10 border-t border-line">
                  <td className="text-ink">{l.name}</td>
                  <td className="text-right tabular-nums">{l.received}</td>
                  <td className={`text-right tabular-nums ${l.rejected ? 'font-semibold text-coral' : 'text-mute'}`}>
                    {l.rejected || '—'}
                    {l.rejectReason && <div className="text-[10.5px] font-normal">{l.rejectReason}</div>}
                  </td>
                  <td className="text-right font-semibold tabular-nums text-ink">{l.received - l.rejected}</td>
                  <td className="pl-4 font-mono text-[11.5px] text-sub">
                    {l.batch || '—'}
                    {l.expiry && ` · ${fmtDate(l.expiry)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ActionBar>
            {rejected.length > 0 && !returned && (
              <Btn onClick={() => setModal({ kind: 'return-new', grnId: g.id })}>
                <RotateCcw className="size-4" /> Return rejected items
              </Btn>
            )}
            {!bill && (
              <Btn primary onClick={() => setModal({ kind: 'bill-new', grnIds: [g.id] })}>
                <ReceiptText className="size-4" /> Enter supplier bill
              </Btn>
            )}
          </ActionBar>
        </>
      );
    }
    if (modal.doc === 'bill') {
      const b = state.bills.find((x) => x.id === modal.id);
      if (!b) return null;
      const st = billStatus(b, state);
      const t = billTotals(b);
      const issues = matchBill(b, state);
      const pays = state.payments.filter((p) => p.allocations.some((a) => a.billId === b.id));
      const notes = state.returns.filter((r) => r.billId === b.id);
      return (
        <>
          <DialogHeader>
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle className="text-[18px] font-extrabold">Bill {b.number}</DialogTitle>
              <Pill cls={billPill[st]}>{billLabel[st]}</Pill>
            </div>
            <DialogDescription className="text-sub">
              {supplierName(b.supplierId)} · {b.id} · dated {fmtDate(b.date)}
            </DialogDescription>
          </DialogHeader>
          <Meta
            items={[
              ['Supplier GSTIN', supplierById(b.supplierId)?.gstin || 'Unregistered'],
              ['Due', fmtDate(b.dueDate)],
              ['Goods receipts', b.grnIds.join(', ') || 'None'],
              ['Balance', <span key="bal" className="text-[14px]">{money(billBalance(b, state))}</span>],
            ]}
          />
          {b.grnIds.length > 0 &&
            (issues.length ? (
              <div className="rounded-xl border border-amber/40 bg-amber/10 p-3 text-[12.5px]">
                <div className="mb-1 flex items-center gap-2 font-bold text-amber">
                  <TriangleAlert className="size-4" /> Three-way match: {issues.length} difference{issues.length === 1 ? '' : 's'}
                </div>
                {issues.map((i) => (
                  <div key={`${i.sku}-${i.kind}`} className="text-ink">
                    <b>{i.name}</b> — {i.detail}
                  </div>
                ))}
              </div>
            ) : (
              <p className="flex items-center gap-2 rounded-xl bg-teal/10 px-3 py-2 text-[12.5px] font-semibold text-teal">
                <Check className="size-4" /> Matches the purchase order and goods receipt
              </p>
            ))}
          <LinesTable lines={b.lines} extra={<TotalsRows t={t} gstApplies={b.gstApplies} interState={b.interState} />} />
          {(pays.length > 0 || notes.length > 0) && (
            <div className="rounded-xl bg-bg p-3 text-[12.5px]">
              <div className="mb-1 font-semibold text-ink">Settled so far</div>
              {pays.map((p) => (
                <div key={p.id} className="flex justify-between text-sub">
                  <span>
                    {p.id} · {p.mode} · {fmtDate(p.date)}
                  </span>
                  <span className="tabular-nums text-teal">−{money(p.allocations.find((a) => a.billId === b.id)?.amount ?? 0)}</span>
                </div>
              ))}
              {notes.filter((r) => r.settlement === 'adjust').map((r) => (
                <div key={r.id} className="flex justify-between text-sub">
                  <span>
                    {r.id} debit note · {fmtDate(r.date)}
                  </span>
                  <span className="tabular-nums text-teal">−{money(returnTotals(r).total)}</span>
                </div>
              ))}
            </div>
          )}
          <ActionBar>
            <Btn onClick={() => setModal({ kind: 'return-new', billId: b.id })}>
              <RotateCcw className="size-4" /> Return items
            </Btn>
            {st !== 'paid' && (
              <Btn primary onClick={() => setModal({ kind: 'pay-new', billId: b.id })}>
                <Banknote className="size-4" /> Pay {money(billBalance(b, state))}
              </Btn>
            )}
          </ActionBar>
        </>
      );
    }
    if (modal.doc === 'return') {
      const r = state.returns.find((x) => x.id === modal.id);
      if (!r) return null;
      const t = returnTotals(r);
      const setStatus = (status: ReturnStatus) => {
        // Connected: a debit note is settled against the supplier's balance when it is posted.
        if (isLive()) return notify('This debit note is already settled against the supplier’s balance.');
        updatePurchases((x) => ({ ...x, returns: x.returns.map((o) => (o.id === r.id ? { ...o, status } : o)) }));
        notify(`${r.id} ${status === 'dispatched' ? 'handed to supplier' : 'settled'}`);
      };
      return (
        <>
          <DialogHeader>
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle className="text-[18px] font-extrabold">Debit note {r.id}</DialogTitle>
              <Pill cls={retPill[r.status]}>{retLabel[r.status]}</Pill>
            </div>
            <DialogDescription className="text-sub">
              {supplierName(r.supplierId)} · {fmtDate(r.date)}
            </DialogDescription>
          </DialogHeader>
          <Meta
            items={[
              ['Against bill', state.bills.find((b) => b.id === r.billId)?.number ?? '—'],
              ['From goods receipt', r.grnId ?? '—'],
              ['Settlement', r.settlement === 'adjust' ? 'Reduces what we owe' : 'Supplier refunds'],
              ['Value', money(t.total)],
            ]}
          />
          <LinesTable lines={r.lines} extra={<TotalsRows t={t} gstApplies={r.gstApplies} interState={r.interState} />} />
          <p className="text-[12px] text-sub">Reasons: {r.lines.map((l) => `${l.name} — ${l.reason}`).join('; ')}</p>
          <ActionBar>
            {r.status === 'pending' && (
              <Btn primary onClick={() => setStatus('dispatched')}>
                <Truck className="size-4" /> Handed to supplier
              </Btn>
            )}
            {r.status === 'dispatched' && (
              <Btn primary onClick={() => setStatus('settled')}>
                <Check className="size-4" /> {r.settlement === 'refund' ? 'Refund received' : 'Supplier accepted the debit note'}
              </Btn>
            )}
          </ActionBar>
        </>
      );
    }
    const p = state.payments.find((x) => x.id === modal.id);
    if (!p) return null;
    return (
      <>
        <DialogHeader>
          <DialogTitle className="text-[18px] font-extrabold">Payment {p.id}</DialogTitle>
          <DialogDescription className="text-sub">
            {supplierName(p.supplierId)} · {fmtDate(p.date)}
          </DialogDescription>
        </DialogHeader>
        <Meta items={[['Amount', money(p.amount)], ['Mode', p.mode], ['Reference', p.ref], ['Advance left', money(unallocated(p))]]} />
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
              <Th>Applied to bill</Th>
              <Th right>Amount</Th>
            </tr>
          </thead>
          <tbody>
            {p.allocations.map((a) => (
              <tr key={a.billId} className="h-9 border-t border-line">
                <td className="text-ink">{state.bills.find((b) => b.id === a.billId)?.number ?? a.billId}</td>
                <td className="text-right font-semibold tabular-nums">{money(a.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {p.notes && <p className="text-[12.5px] text-sub">Note: {p.notes}</p>}
      </>
    );
  };

  const modalTitle: Partial<Record<Modal['kind'], [string, string]>> = {
    'po-new': ['New purchase order', 'Order stock from a supplier. Low-stock items can be added in one click.'],
    'po-edit': ['Edit purchase order', 'Drafts can be changed until they are sent.'],
    'grn-new': ['Record goods received', 'Count what arrived. Reject damaged or expired items here.'],
    'bill-new': ['Enter supplier bill', 'Pick the goods receipts it covers — quantities and PO prices are checked automatically.'],
    'return-new': ['Purchase return', 'Raise a debit note for items going back to the supplier.'],
    'pay-new': ['Pay supplier', 'Applied to the oldest bills first — change the split if needed.'],
  };

  return (
    <div className="space-y-4 p-5 lg:p-6">
      <PageHead title="Purchases" sub="Orders, deliveries, supplier bills, returns and payments">
        <button onClick={() => setModal({ kind: 'grn-new' })} className="flex h-10 items-center gap-1.5 rounded-xl card px-4 font-semibold">
          <PackageCheck className="size-4" /> Receive goods
        </button>
        <button onClick={() => setModal({ kind: 'bill-new' })} className="flex h-10 items-center gap-1.5 rounded-xl card px-4 font-semibold">
          <ReceiptText className="size-4" /> Enter bill
        </button>
        <button
          onClick={() => setModal({ kind: 'po-new' })}
          className="flex h-10 items-center gap-1.5 rounded-xl gbv px-5 font-semibold text-onbrand shadow-lg shadow-blue/25"
        >
          <Plus className="size-4" /> New purchase order
        </button>
      </PageHead>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Banknote} label="We owe suppliers" value={inrShort(payable)} foot={`${openBills.length} unpaid bill${openBills.length === 1 ? '' : 's'} · ${inrShort(sum(dueSoon, (b) => billBalance(b, state)))} due this week`} tone="brand" />
        <Stat
          icon={TriangleAlert}
          label="Overdue"
          value={inrShort(sum(overdue, (b) => billBalance(b, state)))}
          foot={overdue.length ? overdue.map((b) => supplierName(b.supplierId)).join(', ') : 'Nothing overdue'}
          {...(overdue.length ? { tone: 'alert' as const } : {})}
        />
        <Stat icon={Truck} label="Open orders" value={inrShort(sum(openPos, (p) => poTotals(p).total))} foot={`${openPos.length} awaiting delivery · ${unbilledGrns.length} delivery without a bill`} />
        <Stat
          icon={History}
          label="Purchases this month"
          value={inrShort(sum(monthTotals, (t) => t.total))}
          foot={`Input GST credit ${inrShort(sum(monthTotals, (t) => t.tax))}`}
        />
      </section>

      <div className="card p-4">
        <div className="-mx-1 mb-4 flex flex-wrap gap-1 px-1" role="tablist" aria-label="Purchase sections">
          {tabs.map(({ id, label, icon: I, count }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => {
                setTab(id);
                setQ('');
                setStatusFilter('');
              }}
              className={`flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[12.5px] font-semibold transition ${
                tab === id ? 'gbv text-onbrand shadow-md shadow-blue/20' : 'text-sub hover:bg-bg hover:text-ink'
              }`}
            >
              <I className="size-4" /> {label}
              {!!count && (
                <span className={`rounded-full px-1.5 text-[10.5px] tabular-nums ${tab === id ? 'bg-onbrand/20' : 'bg-bg text-sub'}`}>{count}</span>
              )}
            </button>
          ))}
        </div>
        {tab === 'overview' && overview()}
        {tab === 'pos' && posView()}
        {tab === 'grns' && grnsView()}
        {tab === 'bills' && billsView()}
        {tab === 'returns' && returnsView()}
        {tab === 'payments' && paymentsView()}
        {tab === 'prices' && pricesView()}
      </div>

      <Dialog open={modal !== null} onOpenChange={(o) => !o && close()}>
        {/* [&>*]:min-w-0 lets wide line tables scroll inside the dialog instead of stretching it */}
        <DialogContent className="max-h-[92dvh] overflow-y-auto rounded-2xl border-line bg-surface text-ink sm:max-w-3xl [&>*]:min-w-0">
          {modal && modal.kind !== 'view' && (
            <DialogHeader>
              <DialogTitle className="text-[18px] font-extrabold">{modalTitle[modal.kind]?.[0]}</DialogTitle>
              <DialogDescription className="text-sub">{modalTitle[modal.kind]?.[1]}</DialogDescription>
            </DialogHeader>
          )}
          {modal?.kind === 'po-new' && <PoForm state={state} onSubmit={createPo} onCancel={close} />}
          {modal?.kind === 'po-edit' && (
            <PoForm
              state={state}
              initial={state.pos.find((p) => p.id === modal.id)}
              onSubmit={(po) => {
                if (isLive()) {
                  updatePurchaseOrder(modal.id, po)
                    .then(() => {
                      close();
                      notify('Purchase order updated');
                    })
                    .catch((e: unknown) => notify(errorMessage(e)));
                  return;
                }
                updatePurchases((s) => ({ ...s, pos: s.pos.map((p) => (p.id === modal.id ? { ...p, ...po } : p)) }));
                close();
                notify(`${modal.id} updated`);
              }}
              onCancel={() => view('po', modal.id)}
            />
          )}
          {modal?.kind === 'grn-new' && (
            <GrnForm
              state={state}
              initialPoId={modal.poId}
              receivedBy={session?.name ?? ''}
              onSubmit={(grn, returnRejected) => {
                if (isLive()) {
                  receiveGoods(grn, returnRejected)
                    .then((r) => {
                      close();
                      notify(`${r.number} saved — stock and supplier balance updated${r.issues ? ` · ${r.issues} mismatch(es) with the PO flagged` : ''}`);
                    })
                    .catch((e: unknown) => notify(errorMessage(e)));
                  return;
                }
                const id = docNo.grn(state.next.grn);
                const rejected = grn.lines.filter((l) => l.rejected > 0);
                const s = supplierById(grn.supplierId);
                updatePurchases((x) => {
                  let next = { ...x, grns: [{ id, ...grn }, ...x.grns], next: { ...x.next, grn: x.next.grn + 1 } };
                  if (returnRejected && rejected.length) {
                    const gst = gstFor(s);
                    next = {
                      ...next,
                      returns: [
                        {
                          id: docNo.ret(next.next.ret),
                          supplierId: grn.supplierId,
                          billId: null,
                          grnId: id,
                          date: grn.date,
                          status: 'pending',
                          settlement: 'adjust',
                          ...gst,
                          // Same HSN / GST rate as the item, so the debit note reverses the right tax.
                          lines: rejected.map((l) => ({
                            ...lineFor(l.sku, l.rejected, l.rate),
                            reason: (returnReasons.includes(l.rejectReason as ReturnReason) ? l.rejectReason : 'Damaged') as ReturnReason,
                          })),
                        },
                        ...next.returns,
                      ],
                      next: { ...next.next, ret: next.next.ret + 1 },
                    };
                  }
                  return next;
                });
                close();
                notify(`${id} saved${returnRejected && rejected.length ? ' · return raised for rejected items' : ''}`);
              }}
              onCancel={close}
            />
          )}
          {modal?.kind === 'bill-new' && (
            <BillForm
              state={state}
              initialGrnIds={modal.grnIds}
              onSubmit={(bill) => {
                if (isLive()) {
                  // The goods receipt already carries the supplier's invoice and the amount owed.
                  close();
                  notify('The bill was recorded with the goods receipt — no separate entry needed.');
                  return;
                }
                const id = docNo.bill(state.next.bill);
                updatePurchases((x) => ({ ...x, bills: [{ id, ...bill }, ...x.bills], next: { ...x.next, bill: x.next.bill + 1 } }));
                close();
                notify(`Bill ${bill.number} entered (${id})`);
              }}
              onCancel={close}
            />
          )}
          {modal?.kind === 'return-new' && (
            <ReturnForm
              state={state}
              initial={{ billId: modal.billId, grnId: modal.grnId }}
              onSubmit={(r) => {
                if (isLive()) {
                  createPurchaseReturn(r)
                    .then((x) => {
                      close();
                      notify(`Debit note ${x.number} created`);
                    })
                    .catch((e: unknown) => notify(errorMessage(e)));
                  return;
                }
                const id = docNo.ret(state.next.ret);
                updatePurchases((x) => ({ ...x, returns: [{ id, ...r }, ...x.returns], next: { ...x.next, ret: x.next.ret + 1 } }));
                close();
                notify(`Debit note ${id} created`);
              }}
              onCancel={close}
            />
          )}
          {modal?.kind === 'pay-new' && (
            <PaymentForm
              state={state}
              initial={{ supplierId: modal.supplierId, billId: modal.billId }}
              onSubmit={(p) => {
                if (isLive()) {
                  recordSupplierPayment(p)
                    .then((x) => {
                      close();
                      notify(`${x.number}: ${money(p.amount)} paid to ${supplierName(p.supplierId)}`);
                    })
                    .catch((e: unknown) => notify(errorMessage(e)));
                  return;
                }
                const id = docNo.pay(state.next.pay);
                updatePurchases((x) => ({ ...x, payments: [{ id, ...p }, ...x.payments], next: { ...x.next, pay: x.next.pay + 1 } }));
                close();
                notify(`${id}: ${money(p.amount)} paid to ${supplierName(p.supplierId)}`);
              }}
              onCancel={close}
            />
          )}
          {detail()}
        </DialogContent>
      </Dialog>

      {toast && (
        <div role="status" className="fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-2xl bg-side px-4 py-2.5 font-semibold text-onbrand shadow-2xl animate-in fade-in slide-in-from-bottom-3">
          <CircleCheck className="size-4 text-teal" /> {toast}
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="ml-1 text-onbrand/60 hover:text-onbrand">
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
