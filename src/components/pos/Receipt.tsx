'use client';

import type { ReactNode } from 'react';
import { money, type CreditNote, type Invoice, type PosDocument, type TaxSlab } from '@/lib/pos/billing';
import type { PaperWidth } from '@/lib/pos/store';
import {
  COMPOSITION_DECLARATION,
  documentTitle,
  receiptHeaderLines,
  useBusinessProfile,
  type BusinessProfile,
} from '@/lib/business-profile';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const n2 = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Row({ l, r, bold }: { l: ReactNode; r: ReactNode; bold?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${bold ? 'font-bold' : ''}`}>
      <span className="min-w-0">{l}</span>
      <span className="shrink-0 tabular-nums">{r}</span>
    </div>
  );
}

const Rule = () => <div className="my-1.5 border-t border-dashed border-black" />;

function Header({ title, profile }: { title: string; profile: BusinessProfile }) {
  return (
    <div className="text-center">
      <div className="text-[1.35em] font-extrabold">{profile.displayName || 'Your store name'}</div>
      {receiptHeaderLines(profile).map((l) => (
        <div key={l}>{l}</div>
      ))}
      <Rule />
      <div className="font-bold tracking-wide">{title}</div>
    </div>
  );
}

function TaxTable({ slabs, interState }: { slabs: TaxSlab[]; interState: boolean }) {
  return (
    <table className="w-full tabular-nums [&_td]:!p-0 [&_th]:!p-0">
      <thead>
        <tr className="text-left">
          <th className="font-semibold">GST%</th>
          <th className="text-right font-semibold">Taxable</th>
          {interState ? (
            <th className="text-right font-semibold">IGST</th>
          ) : (
            <>
              <th className="text-right font-semibold">CGST</th>
              <th className="text-right font-semibold">SGST</th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {slabs.map((s) => (
          <tr key={s.rate}>
            <td>{s.rate}%</td>
            <td className="text-right">{n2(s.taxable)}</td>
            {interState ? (
              <td className="text-right">{n2(s.igst)}</td>
            ) : (
              <>
                <td className="text-right">{n2(s.cgst)}</td>
                <td className="text-right">{n2(s.sgst)}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Tax summary, or — on a bill of supply — the declaration that replaces it. */
function TaxSection({ slabs, interState, billOfSupply, profile }: { slabs: TaxSlab[]; interState: boolean; billOfSupply: boolean | undefined; profile: BusinessProfile }) {
  if (!billOfSupply) return <TaxTable slabs={slabs} interState={interState} />;
  return (
    <div className="text-center text-[0.9em]">
      {profile.registration === 'composition' ? COMPOSITION_DECLARATION : 'GST not charged (supplier not registered)'}
    </div>
  );
}

function InvoiceBody({ inv, profile }: { inv: Invoice; profile: BusinessProfile }) {
  const t = inv.totals;
  return (
    <>
      <Header title={documentTitle(inv)} profile={profile} />
      <Rule />
      <Row l={`Bill ${inv.no}`} r="" />
      <Row l={when(inv.issuedAt)} r={inv.cashier} />
      {inv.buyer && (
        <div>
          Customer: {inv.buyer.name}
          {inv.buyer.phone && ` · ${inv.buyer.phone}`}
          {inv.buyer.gstin && <div>Buyer GSTIN: {inv.buyer.gstin}</div>}
          {inv.interState && <div>Place of supply: state {inv.buyer.gstin.slice(0, 2)} (IGST)</div>}
        </div>
      )}
      <Rule />
      {t.rows.map((r) => (
        <div key={r.key} className="mb-1">
          <div>{r.name}</div>
          <Row
            l={
              <span className="pl-2">
                {r.qty} × {n2(r.price)}{' '}
                <span className="text-[0.85em]">
                  HSN {r.hsn}
                  {!inv.billOfSupply && ` @${r.gst}%`}
                </span>
              </span>
            }
            r={n2(r.gross)}
          />
          {r.batch && (
            <div className="pl-2 text-[0.85em]">
              Batch {r.batch.id} · exp {new Date(r.batch.expiresOn).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
            </div>
          )}
          {r.lineDiscount > 0 && (
            <Row l={<span className="pl-2">{r.batch ? `Near-expiry ${r.batch.pct}% off` : 'Discount'}</span>} r={`-${n2(r.lineDiscount)}`} />
          )}
        </div>
      ))}
      <Rule />
      <Row l={`Items ${t.itemCount}`} r={n2(t.gross)} />
      {t.discountTotal > 0 && <Row l="Discount" r={`-${n2(t.discountTotal)}`} />}
      {t.roundOff !== 0 && <Row l="Round off" r={n2(t.roundOff)} />}
      <div className="text-[1.3em]">
        <Row l="TOTAL" r={money(t.payable)} bold />
      </div>
      {t.discountTotal > 0 && <div className="text-center">You saved {money(t.discountTotal)}</div>}
      <Rule />
      <TaxSection slabs={t.slabs} interState={inv.interState} billOfSupply={inv.billOfSupply} profile={profile} />
      <Rule />
      {inv.payments.map((p, i) => (
        <Row key={i} l={`Paid ${p.method}${p.ref ? ` (${p.ref})` : ''}`} r={n2(p.tendered ?? p.amount)} />
      ))}
      {inv.change > 0 && <Row l="Change" r={n2(inv.change)} bold />}
    </>
  );
}

function CreditBody({ cn, profile }: { cn: CreditNote; profile: BusinessProfile }) {
  return (
    <>
      <Header title={documentTitle(cn)} profile={profile} />
      <Rule />
      <Row l={`No ${cn.no}`} r="" />
      <Row l={when(cn.issuedAt)} r={cn.cashier} />
      <div>Against bill {cn.against}</div>
      {cn.buyer && <div>Customer: {cn.buyer.name}</div>}
      <Rule />
      {cn.lines.map((l) => (
        <div key={l.key} className="mb-1">
          <div>{l.name}</div>
          <Row
            l={
              <span className="pl-2">
                {l.qty} returned{' '}
                <span className="text-[0.85em]">
                  HSN {l.hsn}
                  {!cn.billOfSupply && ` @${l.gst}%`}
                </span>
              </span>
            }
            r={n2(l.amount)}
          />
        </div>
      ))}
      <Rule />
      <div className="text-[1.3em]">
        <Row l="REFUND" r={money(cn.refund.amount)} bold />
      </div>
      <div>Refunded by {cn.refund.method}</div>
      <div>Reason: {cn.reason}</div>
      <Rule />
      <TaxSection slabs={cn.slabs} interState={cn.interState} billOfSupply={cn.billOfSupply} profile={profile} />
    </>
  );
}

/**
 * On-screen preview and print layout for a thermal roll (58 mm or 80 mm).
 * Uses the saved business profile, or `profile` to preview unsaved changes.
 */
export function Receipt({ doc, width, profile }: { doc: PosDocument; width: PaperWidth; profile?: BusinessProfile }) {
  const saved = useBusinessProfile();
  const p = profile ?? saved;
  return (
    <div
      className="bg-white p-3 font-mono text-black"
      style={{ width: `${width}mm`, fontSize: width === 58 ? '10px' : '11.5px', lineHeight: 1.35 }}
    >
      {doc.kind === 'invoice' ? <InvoiceBody inv={doc} profile={p} /> : <CreditBody cn={doc} profile={p} />}
      {p.receiptFooter.trim() && (
        <>
          <Rule />
          <div className="text-center">{p.receiptFooter.trim()}</div>
        </>
      )}
    </div>
  );
}

/**
 * Renders the receipt off-screen; during window.print() only this is shown, sized to the roll.
 * Mount it once and change `doc` before calling window.print().
 */
export function PrintArea({ doc, width, profile }: { doc: PosDocument | null; width: PaperWidth; profile?: BusinessProfile }) {
  return (
    <>
      <style>{`
        #pos-print { position: fixed; left: -10000px; top: 0; }
        @media print {
          @page { size: ${width}mm auto; margin: 0; }
          body * { visibility: hidden !important; }
          #pos-print, #pos-print * { visibility: visible !important; }
          #pos-print { left: 0; }
        }
      `}</style>
      <div id="pos-print" aria-hidden="true">
        {doc && <Receipt doc={doc} width={width} {...(profile ? { profile } : {})} />}
      </div>
    </>
  );
}
