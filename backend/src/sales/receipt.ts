/**
 * The printed document. Built once when the sale (or credit note) is issued and stored as JSON
 * in `invoices.document`, so a reprint years later shows exactly what the customer got.
 */

export type DocLine = {
  lineNo: number;
  name: string;
  sku: string;
  hsn: string | null;
  qty: string;
  unit: string;
  unitPrice: string;
  mrp: string | null;
  discount: string;
  amount: string;
  gstRate: number;
};

export type DocSlab = {
  rate: number;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
};

export type InvoiceDocument = {
  kind: 'TAX_INVOICE' | 'BILL_OF_SUPPLY' | 'CREDIT_NOTE';
  title: string;
  number: string;
  against: string | null;
  issuedAt: string;
  seller: {
    name: string;
    legalName: string | null;
    gstin: string | null;
    address: string;
    phone: string | null;
    branch: string;
    counter: string;
  };
  buyer: {
    name: string | null;
    phone: string | null;
    gstin: string | null;
  } | null;
  placeOfSupply: string;
  interState: boolean;
  cashier: string;
  lines: DocLine[];
  slabs: DocSlab[];
  totals: {
    gross: string;
    discount: string;
    taxable: string;
    cgst: string;
    sgst: string;
    igst: string;
    cess: string;
    roundOff: string;
    total: string;
  };
  payments: {
    method: string;
    amount: string;
    status: string;
    reference: string | null;
  }[];
  change: string;
  footer: string[];
};

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] ?? c,
  );

/** 80 mm thermal-printer receipt (also prints to PDF from any browser). Everything is escaped. */
export function renderReceiptHtml(d: InvoiceDocument, status: string): string {
  const row = (l: string, r: string, strong = false) =>
    `<tr${strong ? ' class="b"' : ''}><td>${esc(l)}</td><td class="r">${esc(r)}</td></tr>`;
  const lines = d.lines
    .map(
      (l) =>
        `<tr><td colspan="2">${esc(l.name)}${l.hsn ? ` <small>HSN ${esc(l.hsn)}</small>` : ''}</td></tr>` +
        `<tr><td><small>${esc(l.qty)} ${esc(l.unit)} × ₹${esc(l.unitPrice)}${l.discount !== '0.00' ? ` − ₹${esc(l.discount)}` : ''}${d.kind !== 'BILL_OF_SUPPLY' ? ` · ${l.gstRate}%` : ''}</small></td><td class="r">₹${esc(l.amount)}</td></tr>`,
    )
    .join('');
  const slabs =
    d.kind === 'BILL_OF_SUPPLY'
      ? ''
      : d.slabs
          .filter((s) => s.rate > 0)
          .map((s) =>
            d.interState
              ? row(`IGST ${s.rate}% on ₹${s.taxable}`, `₹${s.igst}`)
              : row(
                  `CGST ${s.rate / 2}% + SGST ${s.rate / 2}% on ₹${s.taxable}`,
                  `₹${(Number(s.cgst) + Number(s.sgst)).toFixed(2)}`,
                ),
          )
          .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.title)} ${esc(d.number)}</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  body { font: 12px/1.35 ui-monospace, Menlo, Consolas, monospace; width: 72mm; margin: 0 auto; color: #000; background: #fff; }
  h1 { font-size: 14px; text-align: center; margin: 0 0 2px; } .c { text-align: center; } .r { text-align: right; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; } td { vertical-align: top; padding: 1px 0; }
  hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; } .b td { font-weight: bold; } small { font-size: 10px; }
  .stamp { border: 2px solid #000; text-align: center; font-weight: bold; margin: 4px 0; padding: 2px; }
</style></head><body>
<h1>${esc(d.seller.name)}</h1>
<div class="c">${esc(d.seller.branch)} · ${esc(d.seller.address)}${d.seller.phone ? `<br>Ph ${esc(d.seller.phone)}` : ''}${d.seller.gstin ? `<br>GSTIN ${esc(d.seller.gstin)}` : ''}</div>
<hr><div class="c"><b>${esc(d.title)}</b></div>
${status === 'CANCELLED' ? '<div class="stamp">CANCELLED</div>' : ''}
<table>${row('No', d.number)}${d.against ? row('Against', d.against) : ''}${row('Date', new Date(d.issuedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}${row('Counter', `${d.seller.counter} · ${d.cashier}`)}
${d.buyer ? row('Customer', [d.buyer.name, d.buyer.phone].filter(Boolean).join(' · ')) + (d.buyer.gstin ? row('GSTIN', d.buyer.gstin) : '') : ''}</table>
<hr><table>${lines}</table><hr>
<table>${row('Gross', `₹${d.totals.gross}`)}${d.totals.discount !== '0.00' ? row('Discount', `−₹${d.totals.discount}`) : ''}${slabs}${d.totals.roundOff !== '0.00' ? row('Round off', `₹${d.totals.roundOff}`) : ''}${row(d.kind === 'CREDIT_NOTE' ? 'Refund' : 'Total', `₹${d.totals.total}`, true)}</table>
${d.payments.length ? `<hr><table>${d.payments.map((p) => row(`${p.method}${p.status !== 'SUCCEEDED' ? ` (${p.status.toLowerCase().replace('_', ' ')})` : ''}${p.reference ? ` ${p.reference}` : ''}`, `₹${p.amount}`)).join('')}${d.change !== '0.00' ? row('Change', `₹${d.change}`) : ''}</table>` : ''}
<hr>${d.footer.map((f) => `<div class="c"><small>${esc(f)}</small></div>`).join('')}
</body></html>`;
}
