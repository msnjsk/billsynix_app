/**
 * Billing maths for the POS: discounts, GST (prices are tax-inclusive), round-off,
 * invoices and credit notes. Pure functions only — no React.
 */
import { todaysBills, type Bill } from '@/lib/sales-data';
import { DEFAULT_TAX, posCatalog, type GstRate } from '@/lib/pos/catalog';

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** "₹1,234.50" — POS amounts always show paise. */
export const money = (n: number) =>
  '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ---------- cart ---------- */

export type Discount = { kind: 'pct' | 'amt'; value: number } | null;

export type CartLine = {
  key: string;
  /** null for open-price items keyed in at the counter. */
  sku: string | null;
  name: string;
  hsn: string;
  gst: GstRate;
  /** Unit price, GST inclusive. */
  price: number;
  /** Whole units for packed goods; decimals allowed for loose (weighed) items. */
  qty: number;
  discount: Discount;
  /** Set when the line is sold from a near-expiry batch; `discount` then carries its markdown. */
  batch?: { id: string; expiresOn: string; pct: number } | undefined;
};

export const discountAmount = (base: number, d: Discount) => {
  if (!d || !(d.value > 0) || base <= 0) return 0;
  const amt = d.kind === 'pct' ? (base * Math.min(d.value, 100)) / 100 : Math.min(d.value, base);
  return r2(amt);
};

export type BillRow = CartLine & {
  gross: number;
  lineDiscount: number;
  /** Share of the bill-level discount. */
  billShare: number;
  /** Amount charged for the line, GST inclusive, after all discounts. */
  final: number;
  taxable: number;
  tax: number;
};

export type TaxSlab = { rate: GstRate; taxable: number; cgst: number; sgst: number; igst: number };

export type BillTotals = {
  rows: BillRow[];
  itemCount: number;
  gross: number;
  lineDiscounts: number;
  billDiscount: number;
  discountTotal: number;
  taxable: number;
  taxTotal: number;
  slabs: TaxSlab[];
  total: number;
  roundOff: number;
  payable: number;
};

/** Splits tax into CGST + SGST (same state) or IGST (other state). */
const splitTax = (rate: GstRate, taxable: number, tax: number, interState: boolean): TaxSlab => {
  if (interState) return { rate, taxable: r2(taxable), cgst: 0, sgst: 0, igst: r2(tax) };
  const cgst = r2(tax / 2);
  return { rate, taxable: r2(taxable), cgst, sgst: r2(tax - cgst), igst: 0 };
};

export const slabsOf = (rows: { gst: GstRate; taxable: number; tax: number }[], interState: boolean): TaxSlab[] => {
  const byRate = new Map<GstRate, { taxable: number; tax: number }>();
  for (const r of rows) {
    const s = byRate.get(r.gst) ?? { taxable: 0, tax: 0 };
    s.taxable += r.taxable;
    s.tax += r.tax;
    byRate.set(r.gst, s);
  }
  return [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rate, s]) => splitTax(rate, s.taxable, s.tax, interState));
};

/**
 * Line discounts apply first, then the bill discount is shared across lines in proportion
 * to their value. Discounts given on the invoice reduce the taxable value, so GST is
 * worked back out of each line's final (inclusive) amount.
 */
export function computeBill(lines: CartLine[], billDiscount: Discount, interState = false): BillTotals {
  const base = lines.map((l) => {
    const gross = r2(l.price * l.qty);
    const lineDiscount = discountAmount(gross, l.discount);
    return { l, gross, lineDiscount, net: r2(gross - lineDiscount) };
  });
  const netTotal = r2(base.reduce((s, b) => s + b.net, 0));
  const billDisc = discountAmount(netTotal, billDiscount);

  // Proportional shares, with the rounding remainder put on the largest line.
  const shares = base.map((b) => (netTotal > 0 ? r2((billDisc * b.net) / netTotal) : 0));
  const diff = r2(billDisc - shares.reduce((s, x) => s + x, 0));
  if (diff !== 0 && base.length) {
    const biggest = base.reduce((bi, b, i) => (b.net > base[bi]!.net ? i : bi), 0);
    shares[biggest] = r2(shares[biggest]! + diff);
  }

  const rows: BillRow[] = base.map((b, i) => {
    const final = r2(b.net - shares[i]!);
    const taxable = r2(final / (1 + b.l.gst / 100));
    return { ...b.l, gross: b.gross, lineDiscount: b.lineDiscount, billShare: shares[i]!, final, taxable, tax: r2(final - taxable) };
  });

  const sum = (f: (r: BillRow) => number) => r2(rows.reduce((s, r) => s + f(r), 0));
  const total = sum((r) => r.final);
  const payable = Math.round(total);
  const lineDiscounts = sum((r) => r.lineDiscount);
  return {
    rows,
    // Packed goods count by units; a weighed (loose) line counts as one item, not 1.25 "items".
    itemCount: r2(rows.reduce((s, r) => s + (r.sku ? r.qty : 1), 0)),
    gross: sum((r) => r.gross),
    lineDiscounts,
    billDiscount: billDisc,
    discountTotal: r2(lineDiscounts + billDisc),
    taxable: sum((r) => r.taxable),
    taxTotal: sum((r) => r.tax),
    slabs: slabsOf(rows, interState),
    total,
    roundOff: r2(payable - total),
    payable,
  };
}

/* ---------- invoices ---------- */

export type PayMethod = 'Cash' | 'UPI' | 'Card';
export const payMethods: PayMethod[] = ['Cash', 'UPI', 'Card'];

export type Payment = {
  method: PayMethod;
  /** Amount applied to the bill (never more than what was due). */
  amount: number;
  /** UPI UTR / card approval code. */
  ref?: string;
  /** Cash handed over, when more than the amount (change = tendered - amount). */
  tendered?: number;
};

export type Buyer = { customerId: string | null; name: string; phone: string; gstin: string };

export type Invoice = {
  kind: 'invoice';
  no: string;
  issuedAt: string;
  cashier: string;
  counter: string;
  buyer: Buyer | null;
  interState: boolean;
  lines: CartLine[];
  billDiscount: Discount;
  totals: BillTotals;
  payments: Payment[];
  change: number;
  /** Units returned so far, per line key. */
  returned: Record<string, number>;
  refunded: number;
  /** Composition / unregistered store: a Bill of Supply with no GST charged. */
  billOfSupply?: boolean | undefined;
  /** Cancelled (voided) the same day: stock back, payment reversed, number kept on record. */
  cancelled?: boolean | undefined;
};

export type CreditLine = { key: string; name: string; hsn: string; gst: GstRate; qty: number; amount: number; taxable: number; tax: number };

export type CreditNote = {
  kind: 'credit';
  no: string;
  issuedAt: string;
  against: string;
  cashier: string;
  buyer: Buyer | null;
  interState: boolean;
  lines: CreditLine[];
  slabs: TaxSlab[];
  total: number;
  refund: { method: PayMethod; amount: number };
  reason: string;
  billOfSupply?: boolean | undefined;
};

export type PosDocument = Invoice | CreditNote;

/** Indian financial year label, e.g. "24-25" for May 2024. */
export const fyOf = (d: Date) => {
  const y = d.getFullYear() % 100;
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${String(start).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
};

export const invoiceNo = (prefix: string, d: Date, seq: number) => `${prefix}/${fyOf(d)}/${String(seq).padStart(5, '0')}`;
export const creditNoteNo = (d: Date, seq: number) => `CN/${fyOf(d)}/${String(seq).padStart(4, '0')}`;

/** Buyer GSTIN starts with a 2-digit state code; a different state than the store's means IGST. */
export const isInterState = (storeState: string, buyer: Buyer | null) =>
  !!buyer?.gstin && buyer.gstin.slice(0, 2) !== storeState;

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/* ---------- returns ---------- */

/** What one unit of a line was actually charged, after its share of every discount. */
export const unitCharged = (row: BillRow) => (row.qty > 0 ? row.final / row.qty : 0);

export const returnableQty = (inv: Invoice, row: BillRow) => r2(row.qty - (inv.returned[row.key] ?? 0));

export function buildCreditLines(inv: Invoice, qtys: Record<string, number>): CreditLine[] {
  return inv.totals.rows
    .filter((row) => (qtys[row.key] ?? 0) > 0)
    .map((row) => {
      const qty = Math.min(qtys[row.key]!, returnableQty(inv, row));
      const amount = r2(unitCharged(row) * qty);
      const taxable = r2(amount / (1 + row.gst / 100));
      return { key: row.key, name: row.name, hsn: row.hsn, gst: row.gst, qty, amount, taxable, tax: r2(amount - taxable) };
    });
}

/**
 * Refund for a set of returned lines. The last return that empties the invoice refunds
 * whatever is left of the amount paid, so round-off never leaves a paisa behind.
 */
export function refundFor(inv: Invoice, lines: CreditLine[]) {
  const exact = r2(lines.reduce((s, l) => s + l.amount, 0));
  const emptiesInvoice = inv.totals.rows.every(
    (row) => returnableQty(inv, row) - (lines.find((l) => l.key === row.key)?.qty ?? 0) <= 0
  );
  return emptiesInvoice ? r2(inv.totals.payable - inv.refunded) : Math.round(exact);
}

/* ---------- earlier bills from the Sales register ---------- */

const taxFor = (name: string) => {
  const p = posCatalog.find((x) => x.name === name);
  return p ? { hsn: p.hsn, gst: p.gst } : DEFAULT_TAX;
};

/** Today's counter bills (from sales-data) as invoices, so they can be looked up for returns and reprints. */
function billToInvoice(b: Bill): Invoice {
  const issued = new Date(`2024-05-14T${b.time}:00+05:30`);
  const lines: CartLine[] = b.lines.map((l, i) => ({
    key: `${b.id}-${i}`,
    sku: posCatalog.find((p) => p.name === l.name)?.sku ?? null,
    name: l.name,
    price: l.price,
    qty: l.qty,
    discount: null,
    ...taxFor(l.name),
  }));
  const totals = computeBill(lines, null);
  const refunded = b.status === 'Refunded';
  return {
    kind: 'invoice',
    no: invoiceNo('SFM', issued, b.id),
    issuedAt: issued.toISOString(),
    cashier: b.cashier,
    counter: '',
    buyer: b.customer === 'Walk-in' ? null : { customerId: null, name: b.customer, phone: '', gstin: '' },
    interState: false,
    lines,
    billDiscount: null,
    totals,
    payments: [{ method: b.method, amount: totals.payable }],
    change: 0,
    returned: refunded ? Object.fromEntries(lines.map((l) => [l.key, l.qty])) : {},
    refunded: refunded ? totals.payable : 0,
  };
}

export const registerInvoices: Invoice[] = todaysBills.map(billToInvoice);

/** Next bill number continues the Sales register (latest bill there is #4821). */
export const FIRST_POS_SEQ = Math.max(...todaysBills.map((b) => b.id)) + 1;
