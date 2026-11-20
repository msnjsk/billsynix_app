'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Download, FileJson, Info } from 'lucide-react';
import { api, errorMessage } from '@/lib/api/client';
import { TODAY } from '@/lib/suppliers-data';
import { Btn, ErrorLine, Loading, fieldFixed, inr2, labelCls } from '@/components/live/kit';

type Part = { taxable: number; tax: number };
type Gstr1 = {
  gstin: string;
  period: string;
  fp: string;
  registrations: string[];
  branches: { id: string; name: string }[];
  summary: {
    b2b: Part & { invoices: number; recipients: number };
    b2cl: Part & { invoices: number };
    b2cs: Part & { rows: number };
    cdnr: Part & { notes: number };
    cdnur: Part & { notes: number };
    nil: { exempt: number; nilRated: number; nonGst: number };
    hsn: { b2bRows: number; b2cRows: number };
    documents: { invoices: number; cancelled: number; creditNotes: number };
  };
  warnings: string[];
  note: string;
  file: unknown;
};

/** The last 12 months, newest first (GSTR-1 is filed for the month just gone). */
const months = (() => {
  const [y, m] = TODAY.split('-').map(Number) as [number, number];
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const v = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    return { v, label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  });
})();

/** GSTR-1 for a month: section-by-section totals and the JSON for the GST portal's offline tool. */
export function Gstr1Panel() {
  const [month, setMonth] = useState(months[TODAY.slice(8) <= '10' ? 1 : 0]!.v);
  const [gstin, setGstin] = useState('');
  const [data, setData] = useState<Gstr1 | null>(null);
  const [regs, setRegs] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    setError('');
    api<Gstr1>('GET', '/reports/gstr1', { query: { month, ...(gstin ? { gstin } : {}) }, signal: ctl.signal })
      .then((d) => {
        setData(d);
        setRegs(d.registrations);
      })
      .catch((e) => {
        if (ctl.signal.aborted) return;
        setData(null);
        const msg = errorMessage(e);
        // A business with several registrations must pick one first.
        const found = msg.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g);
        if (found && !gstin) {
          setRegs(found);
          setGstin(found[0]!);
        } else setError(msg);
      })
      .finally(() => !ctl.signal.aborted && setLoading(false));
    return () => ctl.abort();
  }, [month, gstin]);

  const download = () => {
    if (!data) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data.file)], { type: 'application/json' }));
    a.download = `GSTR1_${data.gstin}_${data.fp}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const s = data?.summary;
  const rows: [string, string, string, string][] = s
    ? [
        ['4A', 'B2B — to registered buyers', `${s.b2b.invoices} invoice${s.b2b.invoices === 1 ? '' : 's'} · ${s.b2b.recipients} GSTIN${s.b2b.recipients === 1 ? '' : 's'}`, `${inr2(s.b2b.taxable)} · tax ${inr2(s.b2b.tax)}`],
        ['5', 'B2C Large — other state, over ₹1 lakh', `${s.b2cl.invoices} invoice${s.b2cl.invoices === 1 ? '' : 's'}`, `${inr2(s.b2cl.taxable)} · tax ${inr2(s.b2cl.tax)}`],
        ['7', 'B2C Small — all other consumer sales', `${s.b2cs.rows} row${s.b2cs.rows === 1 ? '' : 's'} by state and rate`, `${inr2(s.b2cs.taxable)} · tax ${inr2(s.b2cs.tax)}`],
        ['9B', 'Credit notes — registered buyers', `${s.cdnr.notes} note${s.cdnr.notes === 1 ? '' : 's'}`, `${inr2(s.cdnr.taxable)} · tax ${inr2(s.cdnr.tax)}`],
        ['9B', 'Credit notes — B2C Large', `${s.cdnur.notes} note${s.cdnur.notes === 1 ? '' : 's'}`, `${inr2(s.cdnur.taxable)} · tax ${inr2(s.cdnur.tax)}`],
        ['8', 'Nil-rated, exempt and non-GST', '', `Nil ${inr2(s.nil.nilRated)} · exempt ${inr2(s.nil.exempt)} · non-GST ${inr2(s.nil.nonGst)}`],
        ['12', 'HSN summary', `${s.hsn.b2bRows} B2B · ${s.hsn.b2cRows} B2C rows`, ''],
        ['13', 'Documents issued', `${s.documents.invoices} invoices (${s.documents.cancelled} cancelled) · ${s.documents.creditNotes} credit note${s.documents.creditNotes === 1 ? '' : 's'}`, ''],
      ]
    : [];

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line p-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <FileJson className="size-5 text-blue" /> GSTR-1 return file
          </h2>
          <p className="text-sm text-sub">Outward supplies for a month, ready to upload to the GST portal.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className={labelCls}>
            Month
            <select value={month} onChange={(e) => setMonth(e.target.value)} className={`${fieldFixed} mt-1 h-9 w-44`}>
              {months.map((m) => (
                <option key={m.v} value={m.v}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {regs.length > 1 && (
            <label className={labelCls}>
              Registration
              <select value={gstin} onChange={(e) => setGstin(e.target.value)} className={`${fieldFixed} mt-1 h-9 w-48 font-mono`}>
                {regs.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Btn tone="primary" disabled={!data || loading} onClick={download}>
            <Download className="size-4" /> Download JSON
          </Btn>
        </div>
      </div>
      {error ? (
        <div className="p-4">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : !data ? (
        <Loading />
      ) : (
        <div className="space-y-3 p-4">
          <div className="text-xs text-mute">
            GSTIN <span className="font-mono text-ink">{data.gstin}</span> · return period {data.fp} · {data.branches.map((b) => b.name).join(', ')}
          </div>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-bg/60 text-left text-xs uppercase tracking-wide text-mute">
                <tr>
                  <th className="px-3! py-2!">Table</th>
                  <th className="px-3! py-2!">Section</th>
                  <th className="px-3! py-2!">Count</th>
                  <th className="px-3! py-2! text-right">Taxable value · tax</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map(([t, name, count, value], i) => (
                  <tr key={i}>
                    <td className="px-3! py-2! font-mono text-xs text-sub">{t}</td>
                    <td className="px-3! py-2! font-medium">{name}</td>
                    <td className="px-3! py-2! text-sub">{count || '—'}</td>
                    <td className="px-3! py-2! text-right tabular-nums">{value || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.warnings.map((w) => (
            <p key={w} className="flex items-start gap-2 rounded-xl bg-amber/10 px-3 py-2 text-sm text-amber">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {w}
            </p>
          ))}
          <p className="flex items-start gap-2 text-xs text-mute">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            {data.note} On the portal: Returns › GSTR-1 › Prepare offline › Upload, or open it in the GST Offline Tool first.
          </p>
        </div>
      )}
    </section>
  );
}
