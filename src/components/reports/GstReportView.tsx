'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Download, FileText, Info, Landmark, Loader2, Lock, ReceiptText, Scale } from 'lucide-react';
import { PageHead, downloadCsv } from '@/components/AppShell';
import { get, errorMessage } from '@/lib/api/client';
import { can, isLive } from '@/lib/live/session';
import { useBranches, stores } from '@/lib/branch-data';
import { gstStates, useBusinessProfile } from '@/lib/business-profile';
import { TODAY, addDays } from '@/lib/suppliers-data';
import { Gstr1Panel } from './Gstr1Panel';

/* ---------- API shape (GET /reports/gst) ---------- */

type Tax = { taxable: string; cgst: string; sgst: string; igst: string; cess: string };
type GstReport = {
  from: string;
  to: string;
  note: string;
  outward: { rate: number; invoiced: Tax; creditNotes: Tax & { count: number }; net: Tax }[];
  b2b: {
    invoices: number;
    taxable: string;
    tax: string;
    value: string;
    list: { invoiceNo: string; date: string; gstin: string; name: string | null; placeOfSupply: string; taxable: string; tax: string; value: string }[];
  };
  b2c: { invoices: number; taxable: string; tax: string; value: string };
  hsn: { hsn: string | null; unit: string; rate: number; qty: string; taxable: string; tax: string; value: string }[];
  billsOfSupply: { invoices: number; value: string };
  inward: { received: Tax; debitNotes: Tax };
  summary: { outputTax: string; inputTax: string; netIndicative: string };
};

/* ---------- helpers ---------- */

const n = (s: string | number | undefined) => Number(s ?? 0);
const money = (v: string | number) =>
  `₹${n(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const taxOf = (t: Tax) => n(t.cgst) + n(t.sgst) + n(t.igst) + n(t.cess);
const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Indian financial year start for a date. */
const fyStart = (iso: string) => {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  return `${m >= 4 ? y : y - 1}-04-01`;
};
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
const prevMonth = (iso: string) => {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const from = `${py}-${String(pm).padStart(2, '0')}-01`;
  return { from, to: addDays(monthStart(iso), -1) };
};
const quarterStart = (iso: string) => {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const qm = m >= 4 && m <= 6 ? 4 : m >= 7 && m <= 9 ? 7 : m >= 10 ? 10 : 1;
  return `${y}-${String(qm).padStart(2, '0')}-01`;
};

type PresetKey = 'month' | 'last' | 'quarter' | 'fy' | 'custom';
const presets: { key: Exclude<PresetKey, 'custom'>; label: string; range: () => { from: string; to: string } }[] = [
  { key: 'month', label: 'This month', range: () => ({ from: monthStart(TODAY), to: TODAY }) },
  { key: 'last', label: 'Last month', range: () => prevMonth(TODAY) },
  { key: 'quarter', label: 'This quarter', range: () => ({ from: quarterStart(TODAY), to: TODAY }) },
  { key: 'fy', label: 'This FY', range: () => ({ from: fyStart(TODAY), to: TODAY }) },
];

type Tab = 'rates' | 'b2b' | 'hsn' | 'input';

/* ---------- view ---------- */

export function GstReportView() {
  const profile = useBusinessProfile();
  const branches = useBranches();
  const shops = stores(branches);
  const [preset, setPreset] = useState<PresetKey>('month');
  const [range, setRange] = useState(() => presets[0]!.range());
  const [storeId, setStoreId] = useState('');
  const [tab, setTab] = useState<Tab>('rates');
  const [data, setData] = useState<GstReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const live = isLive();
  const allowed = live && can('reports:finance');

  useEffect(() => {
    if (!allowed || !range.from || !range.to || range.from > range.to) return;
    const ctl = new AbortController();
    setLoading(true);
    setError('');
    get<GstReport>('/reports/gst', { from: range.from, to: range.to, ...(storeId ? { storeId } : {}) }, ctl.signal)
      .then((r) => setData(r))
      .catch((e) => {
        if (!ctl.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
  }, [allowed, range.from, range.to, storeId]);

  const totals = useMemo(() => {
    if (!data) return null;
    const sum = (pick: (t: Tax) => string) => data.outward.reduce((s, r) => s + n(pick(r.net)), 0);
    const inTax = taxOf(data.inward.received) - taxOf(data.inward.debitNotes);
    return {
      taxable: sum((t) => t.taxable),
      cgst: sum((t) => t.cgst),
      sgst: sum((t) => t.sgst),
      igst: sum((t) => t.igst),
      cess: sum((t) => t.cess),
      creditNotes: data.outward.reduce((s, r) => s + r.creditNotes.count, 0),
      inTax,
    };
  }, [data]);

  const registered = profile.registration === 'regular';
  const period = `${range.from}_to_${range.to}`;

  const exportCsv = () => {
    if (!data) return;
    if (tab === 'rates')
      downloadCsv(`gst-by-rate_${period}.csv`, [
        ['GST rate %', 'Invoiced taxable', 'Credit notes', 'Credit note taxable', 'Net taxable', 'CGST', 'SGST', 'IGST', 'Cess', 'Total tax'],
        ...data.outward.map((r) => [r.rate, r.invoiced.taxable, r.creditNotes.count, r.creditNotes.taxable, r.net.taxable, r.net.cgst, r.net.sgst, r.net.igst, r.net.cess, taxOf(r.net).toFixed(2)]),
      ]);
    else if (tab === 'b2b')
      downloadCsv(`gst-b2b_${period}.csv`, [
        ['Invoice no', 'Date', 'Buyer GSTIN', 'Buyer name', 'Place of supply', 'Taxable', 'Tax', 'Invoice value'],
        ...data.b2b.list.map((r) => [r.invoiceNo, r.date, r.gstin, r.name ?? '', `${r.placeOfSupply}-${gstStates[r.placeOfSupply] ?? ''}`, r.taxable, r.tax, r.value]),
      ]);
    else if (tab === 'hsn')
      downloadCsv(`gst-hsn_${period}.csv`, [
        ['HSN', 'UQC', 'GST rate %', 'Quantity', 'Taxable', 'Tax', 'Total value'],
        ...data.hsn.map((r) => [r.hsn ?? '', r.unit, r.rate, r.qty, r.taxable, r.tax, r.value]),
      ]);
    else
      downloadCsv(`gst-input_${period}.csv`, [
        ['', 'Taxable', 'CGST', 'SGST', 'IGST', 'Cess'],
        ['Goods received', ...taxCells(data.inward.received)],
        ['Purchase returns (debit notes)', ...taxCells(data.inward.debitNotes)],
      ]);
  };

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageHead title="GST report" sub="Outward supplies, B2B invoices, HSN summary and input tax for a period">
        <button
          type="button"
          onClick={exportCsv}
          disabled={!data}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-semibold hover:bg-bg disabled:opacity-50"
        >
          <Download className="size-4" aria-hidden="true" /> Export CSV
        </button>
      </PageHead>

      {!live ? (
        <Blocked icon={<Landmark className="size-6" />} title="Connect to the server to see GST figures">
          The GST report is built from the invoices and credit notes the server issues. Set <code>NEXT_PUBLIC_API_URL</code> in
          <code> .env.local</code> and restart the app.
        </Blocked>
      ) : !allowed ? (
        <Blocked icon={<Lock className="size-6" />} title="You don’t have access to finance reports">
          Ask the owner to give your role the “Margin, GST and payables reports” permission.
        </Blocked>
      ) : (
        <>
          {/* filters */}
          <section className="card flex flex-wrap items-end gap-3 p-4">
            <div className="flex flex-wrap gap-1 rounded-xl bg-bg p-1">
              {presets.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => {
                    setPreset(p.key);
                    setRange(p.range());
                  }}
                  className={`h-8 rounded-lg px-3 text-sm font-semibold ${preset === p.key ? 'bg-surface text-ink shadow-sm' : 'text-sub hover:text-ink'}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <label className="text-xs text-sub">
              From
              <input
                type="date"
                value={range.from}
                max={range.to}
                onChange={(e) => {
                  setPreset('custom');
                  setRange((r) => ({ ...r, from: e.target.value }));
                }}
                className="mt-1 block h-9 rounded-lg border border-line bg-surface px-2 text-sm text-ink"
              />
            </label>
            <label className="text-xs text-sub">
              To
              <input
                type="date"
                value={range.to}
                min={range.from}
                max={TODAY}
                onChange={(e) => {
                  setPreset('custom');
                  setRange((r) => ({ ...r, to: e.target.value }));
                }}
                className="mt-1 block h-9 rounded-lg border border-line bg-surface px-2 text-sm text-ink"
              />
            </label>
            {shops.length > 1 && (
              <label className="text-xs text-sub">
                Branch
                <select
                  value={storeId}
                  onChange={(e) => setStoreId(e.target.value)}
                  className="mt-1 block h-9 rounded-lg border border-line bg-surface px-2 text-sm text-ink"
                >
                  <option value="">All branches</option>
                  {shops.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="ml-auto flex items-center gap-2 text-sm text-sub">
              {loading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {fmtDay(range.from)} – {fmtDay(range.to)}
            </div>
          </section>

          {registered && <Gstr1Panel />}

          {!registered && (
            <Banner tone="amber">
              Your business is set up as <b>{profile.registration === 'composition' ? 'Composition' : 'Unregistered'}</b>, so bills are issued
              as Bills of Supply and no GST is collected. Only the Bills of Supply total and input purchases are shown.
            </Banner>
          )}
          {error && <Banner tone="coral">{error}</Banner>}

          {data && totals && (
            <>
              {/* summary */}
              <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Stat icon={<ReceiptText className="size-5" />} tone="blue" label="Output tax (net)" value={money(data.summary.outputTax)}>
                  On {money(totals.taxable)} taxable · {totals.creditNotes} credit note{totals.creditNotes === 1 ? '' : 's'}
                </Stat>
                <Stat icon={<FileText className="size-5" />} tone="teal" label="Input tax" value={money(data.summary.inputTax)}>
                  From goods received, less purchase returns
                </Stat>
                <Stat icon={<Scale className="size-5" />} tone="vio" label="Net payable (indicative)" value={money(data.summary.netIndicative)}>
                  Output − input · before eligibility checks
                </Stat>
                <Stat icon={<Landmark className="size-5" />} tone="amber" label="Invoices" value={String(data.b2b.invoices + data.b2c.invoices)}>
                  {data.b2b.invoices} B2B · {data.b2c.invoices} B2C
                  {data.billsOfSupply.invoices ? ` · ${data.billsOfSupply.invoices} bills of supply` : ''}
                </Stat>
              </section>

              {/* tax heads */}
              <section className="card grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <Head label="CGST" value={totals.cgst} />
                <Head label="SGST / UTGST" value={totals.sgst} />
                <Head label="IGST" value={totals.igst} />
                <Head label="Cess" value={totals.cess} />
              </section>

              {/* tabs */}
              <section className="card overflow-hidden">
                <div className="flex gap-1 overflow-x-auto border-b border-line px-3 pt-3">
                  {(
                    [
                      ['rates', 'By GST rate'],
                      ['b2b', `B2B invoices (${data.b2b.list.length})`],
                      ['hsn', `HSN summary (${data.hsn.length})`],
                      ['input', 'Input tax'],
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
                <div className="overflow-x-auto">
                  {tab === 'rates' && <RatesTable data={data} />}
                  {tab === 'b2b' && <B2bTable data={data} />}
                  {tab === 'hsn' && <HsnTable data={data} />}
                  {tab === 'input' && <InputTable data={data} />}
                </div>
              </section>

              <p className="flex items-start gap-2 text-xs text-mute">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {data.note}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

const taxCells = (t: Tax) => [t.taxable, t.cgst, t.sgst, t.igst, t.cess];

/* ---------- tables ---------- */

const th = 'px-4! py-2.5! text-left text-xs font-semibold uppercase tracking-wide text-mute';
const thr = `${th} text-right`;
const td = 'px-4! py-3!';
const tdr = `${td} text-right tabular-nums`;

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-12 text-center text-sm text-sub">{children}</div>;
}

function RatesTable({ data }: { data: GstReport }) {
  if (!data.outward.length) return <Empty>No tax invoices in this period.</Empty>;
  const total = (pick: (t: Tax) => string) => data.outward.reduce((s, r) => s + n(pick(r.net)), 0);
  return (
    <table className="w-full min-w-[760px] text-sm">
      <thead className="bg-bg/60">
        <tr>
          <th className={th}>Rate</th>
          <th className={thr}>Invoiced taxable</th>
          <th className={thr}>Credit notes</th>
          <th className={thr}>Net taxable</th>
          <th className={thr}>CGST</th>
          <th className={thr}>SGST</th>
          <th className={thr}>IGST</th>
          <th className={thr}>Cess</th>
          <th className={thr}>Total tax</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {data.outward.map((r) => (
          <tr key={r.rate}>
            <td className={td}>
              <span className="rounded-md bg-blue/10 px-2 py-0.5 text-xs font-bold text-blue">{r.rate}%</span>
            </td>
            <td className={tdr}>{money(r.invoiced.taxable)}</td>
            <td className={`${tdr} text-coral`}>
              {r.creditNotes.count ? `−${money(r.creditNotes.taxable)}` : '—'}
            </td>
            <td className={`${tdr} font-semibold`}>{money(r.net.taxable)}</td>
            <td className={tdr}>{money(r.net.cgst)}</td>
            <td className={tdr}>{money(r.net.sgst)}</td>
            <td className={tdr}>{money(r.net.igst)}</td>
            <td className={tdr}>{money(r.net.cess)}</td>
            <td className={`${tdr} font-semibold`}>{money(taxOf(r.net))}</td>
          </tr>
        ))}
      </tbody>
      <tfoot className="border-t-2 border-line font-bold">
        <tr>
          <td className={td}>Total</td>
          <td className={tdr}>{money(data.outward.reduce((s, r) => s + n(r.invoiced.taxable), 0))}</td>
          <td className={`${tdr} text-coral`}>−{money(data.outward.reduce((s, r) => s + n(r.creditNotes.taxable), 0))}</td>
          <td className={tdr}>{money(total((t) => t.taxable))}</td>
          <td className={tdr}>{money(total((t) => t.cgst))}</td>
          <td className={tdr}>{money(total((t) => t.sgst))}</td>
          <td className={tdr}>{money(total((t) => t.igst))}</td>
          <td className={tdr}>{money(total((t) => t.cess))}</td>
          <td className={tdr}>{money(data.summary.outputTax)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function B2bTable({ data }: { data: GstReport }) {
  return (
    <>
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2">
        <Split label="B2B · to GST-registered buyers" s={data.b2b} />
        <Split label="B2C · to consumers" s={data.b2c} />
      </div>
      {!data.b2b.list.length ? (
        <Empty>No invoices with a buyer GSTIN in this period. Add the buyer’s GSTIN at the counter to issue a B2B invoice.</Empty>
      ) : (
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-bg/60">
            <tr>
              <th className={th}>Invoice</th>
              <th className={th}>Date</th>
              <th className={th}>Buyer</th>
              <th className={th}>Place of supply</th>
              <th className={thr}>Taxable</th>
              <th className={thr}>Tax</th>
              <th className={thr}>Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.b2b.list.map((r) => (
              <tr key={r.invoiceNo}>
                <td className={`${td} font-mono text-xs font-semibold`}>{r.invoiceNo}</td>
                <td className={`${td} whitespace-nowrap text-sub`}>{fmtDay(r.date)}</td>
                <td className={td}>
                  <div className="font-medium">{r.name || '—'}</div>
                  <div className="font-mono text-xs text-mute">{r.gstin}</div>
                </td>
                <td className={`${td} text-sub`}>
                  {r.placeOfSupply} · {gstStates[r.placeOfSupply] ?? '—'}
                </td>
                <td className={tdr}>{money(r.taxable)}</td>
                <td className={tdr}>{money(r.tax)}</td>
                <td className={`${tdr} font-semibold`}>{money(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function HsnTable({ data }: { data: GstReport }) {
  if (!data.hsn.length) return <Empty>No tax invoices in this period.</Empty>;
  const missing = data.hsn.filter((h) => !h.hsn).length;
  return (
    <>
      {missing > 0 && (
        <div className="flex items-center gap-2 border-b border-line bg-amber/10 px-4 py-2.5 text-sm text-amber">
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          {missing} row{missing === 1 ? '' : 's'} sold without an HSN code — add HSN codes on the Products page.
        </div>
      )}
      <table className="w-full min-w-[680px] text-sm">
        <thead className="bg-bg/60">
          <tr>
            <th className={th}>HSN</th>
            <th className={th}>UQC</th>
            <th className={thr}>Rate</th>
            <th className={thr}>Quantity</th>
            <th className={thr}>Taxable</th>
            <th className={thr}>Tax</th>
            <th className={thr}>Total value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {data.hsn.map((r, i) => (
            <tr key={`${r.hsn}-${r.unit}-${r.rate}-${i}`}>
              <td className={`${td} font-mono text-xs font-semibold`}>{r.hsn ?? <span className="text-amber">Not set</span>}</td>
              <td className={`${td} text-sub`}>{r.unit}</td>
              <td className={tdr}>{r.rate}%</td>
              <td className={tdr}>{n(r.qty).toLocaleString('en-IN', { maximumFractionDigits: 3 })}</td>
              <td className={tdr}>{money(r.taxable)}</td>
              <td className={tdr}>{money(r.tax)}</td>
              <td className={`${tdr} font-semibold`}>{money(r.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function InputTable({ data }: { data: GstReport }) {
  const { received, debitNotes } = data.inward;
  const net: Tax = {
    taxable: String(n(received.taxable) - n(debitNotes.taxable)),
    cgst: String(n(received.cgst) - n(debitNotes.cgst)),
    sgst: String(n(received.sgst) - n(debitNotes.sgst)),
    igst: String(n(received.igst) - n(debitNotes.igst)),
    cess: String(n(received.cess) - n(debitNotes.cess)),
  };
  const row = (label: string, t: Tax, cls = '') => (
    <tr className={cls}>
      <td className={td}>{label}</td>
      {taxCells(t).map((v, i) => (
        <td key={i} className={tdr}>
          {money(v)}
        </td>
      ))}
      <td className={`${tdr} font-semibold`}>{money(taxOf(t))}</td>
    </tr>
  );
  return (
    <table className="w-full min-w-[680px] text-sm">
      <thead className="bg-bg/60">
        <tr>
          <th className={th}>Source</th>
          <th className={thr}>Taxable</th>
          <th className={thr}>CGST</th>
          <th className={thr}>SGST</th>
          <th className={thr}>IGST</th>
          <th className={thr}>Cess</th>
          <th className={thr}>Total tax</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {row('Goods received (GRNs)', received)}
        {row('Less: purchase returns', debitNotes, 'text-coral')}
      </tbody>
      <tfoot className="border-t-2 border-line font-bold">{row('Net input tax', net)}</tfoot>
    </table>
  );
}

/* ---------- small pieces ---------- */

const toneCls = {
  blue: 'bg-blue/10 text-blue',
  teal: 'bg-teal/10 text-teal',
  vio: 'bg-vio/10 text-vio',
  amber: 'bg-amber/10 text-amber',
} as const;

function Stat({ icon, tone, label, value, children }: { icon: ReactNode; tone: keyof typeof toneCls; label: string; value: string; children: ReactNode }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-3">
        <span className={`grid size-10 place-items-center rounded-xl ${toneCls[tone]}`}>{icon}</span>
        <span className="text-sm font-semibold text-sub">{label}</span>
      </div>
      <div className="mt-3 text-[24px] font-extrabold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-mute">{children}</div>
    </div>
  );
}

function Head({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-mute">{label}</div>
      <div className="mt-1 text-lg font-bold tabular-nums">{money(value)}</div>
    </div>
  );
}

function Split({ label, s }: { label: string; s: { invoices: number; taxable: string; tax: string; value: string } }) {
  return (
    <div className="rounded-xl bg-bg p-3">
      <div className="text-xs font-semibold text-sub">{label}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span>
          <b className="text-lg tabular-nums">{s.invoices}</b> invoices
        </span>
        <span className="text-sub">Taxable {money(s.taxable)}</span>
        <span className="text-sub">Tax {money(s.tax)}</span>
        <span className="font-semibold">Value {money(s.value)}</span>
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: 'amber' | 'coral'; children: ReactNode }) {
  return (
    <div className={`flex items-start gap-2 rounded-xl px-4 py-3 text-sm ${tone === 'amber' ? 'bg-amber/10 text-amber' : 'bg-coral/10 text-coral'}`}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

function Blocked({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="card grid place-items-center px-6 py-16 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-blue/10 text-blue">{icon}</span>
      <h2 className="mt-4 text-lg font-bold">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-sub">{children}</p>
    </section>
  );
}
