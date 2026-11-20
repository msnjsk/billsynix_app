import { Decimal } from '../common/decimal.js';

/**
 * POS billing maths — the backend twin of the frontend's `computeBill` (src/lib/pos/billing.ts),
 * so a bill quoted at the counter and the invoice the server issues agree to the paisa:
 *   1. gross = price × qty per line; the line discount (₹ or %) comes off first;
 *   2. the bill discount is shared across lines in proportion to their net value, the rounding
 *      remainder going to the largest line;
 *   3. GST (and cess) is worked back out of each line's final, tax-inclusive amount;
 *   4. tax is split CGST/SGST per rate slab within a state, IGST across states;
 *   5. the payable is the total rounded to the rupee; the difference is the round-off.
 * Tax-exclusive prices are turned into inclusive ones before step 1. A business that doesn't
 * charge GST (composition / unregistered) issues a Bill of Supply: no tax is worked out.
 */

export type DiscountIn = { kind: 'PCT' | 'AMT'; value: Decimal } | null;

export type BillLineIn = {
  qty: Decimal;
  /** Per unit, tax inclusive. */
  unitPrice: Decimal;
  gstRate: Decimal;
  cessRate: Decimal;
  discount: DiscountIn;
};

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);
export const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export function discountAmount(base: Decimal, d: DiscountIn) {
  if (!d || !d.value.gt(0) || !base.gt(0)) return ZERO;
  return r2(
    d.kind === 'PCT'
      ? base.times(Decimal.min(d.value, HUNDRED)).dividedBy(HUNDRED)
      : Decimal.min(d.value, base),
  );
}

/** Price including GST + cess, for products priced exclusive of tax. */
export const inclusivePrice = (
  price: Decimal,
  gstRate: Decimal,
  cessRate: Decimal,
) => r2(price.times(HUNDRED.plus(gstRate).plus(cessRate)).dividedBy(HUNDRED));

export type BillRow = {
  gross: Decimal;
  lineDiscount: Decimal;
  billShare: Decimal;
  final: Decimal;
  taxable: Decimal;
  gst: Decimal;
  cess: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
};

export type Slab = {
  rate: Decimal;
  taxable: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  cess: Decimal;
};

export type Bill = {
  rows: BillRow[];
  gross: Decimal;
  lineDiscounts: Decimal;
  billDiscount: Decimal;
  taxable: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  cess: Decimal;
  slabs: Slab[];
  total: Decimal;
  roundOff: Decimal;
  payable: Decimal;
};

const split = (gst: Decimal, interState: boolean) => {
  if (interState) return { cgst: ZERO, sgst: ZERO, igst: gst };
  const cgst = r2(gst.dividedBy(2));
  return { cgst, sgst: gst.minus(cgst), igst: ZERO };
};

export function computeBill(
  lines: readonly BillLineIn[],
  billDiscount: DiscountIn,
  opts: { interState: boolean; chargeGst: boolean },
): Bill {
  const base = lines.map((l) => {
    const gross = r2(l.unitPrice.times(l.qty));
    const lineDiscount = discountAmount(gross, l.discount);
    return { l, gross, lineDiscount, net: gross.minus(lineDiscount) };
  });
  const netTotal = base.reduce((s, b) => s.plus(b.net), ZERO);
  const billDisc = discountAmount(netTotal, billDiscount);
  const shares = base.map((b) =>
    netTotal.gt(0) ? r2(billDisc.times(b.net).dividedBy(netTotal)) : ZERO,
  );
  const diff = billDisc.minus(shares.reduce((s, x) => s.plus(x), ZERO));
  if (!diff.isZero() && base.length) {
    const biggest = base.reduce(
      (bi, b, i) => (b.net.gt(base[bi]!.net) ? i : bi),
      0,
    );
    shares[biggest] = shares[biggest]!.plus(diff);
  }

  const rows: BillRow[] = base.map((b, i) => {
    const final = b.net.minus(shares[i]!);
    const rate = opts.chargeGst ? b.l.gstRate.plus(b.l.cessRate) : ZERO;
    const taxable = rate.isZero()
      ? final
      : r2(final.times(HUNDRED).dividedBy(HUNDRED.plus(rate)));
    const tax = final.minus(taxable);
    const gst = rate.isZero()
      ? ZERO
      : r2(tax.times(b.l.gstRate).dividedBy(rate));
    const cess = tax.minus(gst);
    return {
      gross: b.gross,
      lineDiscount: b.lineDiscount,
      billShare: shares[i]!,
      final,
      taxable,
      gst,
      cess,
      ...split(gst, opts.interState),
    };
  });

  // Slabs by GST rate; CGST/SGST are halved per slab, as on the printed invoice.
  const bySlab = new Map<
    string,
    { rate: Decimal; taxable: Decimal; gst: Decimal; cess: Decimal }
  >();
  rows.forEach((r, i) => {
    const rate = opts.chargeGst ? lines[i]!.gstRate : ZERO;
    const k = rate.toFixed(2);
    const s = bySlab.get(k) ?? { rate, taxable: ZERO, gst: ZERO, cess: ZERO };
    s.taxable = s.taxable.plus(r.taxable);
    s.gst = s.gst.plus(r.gst);
    s.cess = s.cess.plus(r.cess);
    bySlab.set(k, s);
  });
  const slabs = [...bySlab.values()]
    .sort((a, b) => a.rate.comparedTo(b.rate))
    .map((s) => ({
      rate: s.rate,
      taxable: s.taxable,
      cess: s.cess,
      ...split(s.gst, opts.interState),
    }));

  const sum = (f: (r: BillRow) => Decimal) =>
    rows.reduce((s, r) => s.plus(f(r)), ZERO);
  const total = sum((r) => r.final);
  const payable = total.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return {
    rows,
    gross: sum((r) => r.gross),
    lineDiscounts: sum((r) => r.lineDiscount),
    billDiscount: billDisc,
    taxable: sum((r) => r.taxable),
    cgst: slabs.reduce((s, x) => s.plus(x.cgst), ZERO),
    sgst: slabs.reduce((s, x) => s.plus(x.sgst), ZERO),
    igst: slabs.reduce((s, x) => s.plus(x.igst), ZERO),
    cess: sum((r) => r.cess),
    slabs,
    total,
    roundOff: payable.minus(total),
    payable,
  };
}

/* ---------- document numbers (docs/phase-0/01-scope-and-decisions.md §4) ---------- */

/** Indian financial year of a business date, as 4 digits: 2026-11-17 → "2627". */
export function fyOf(businessDate: string) {
  const [y, m] = businessDate.split('-').map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Series of a counter: branch code + counter number, e.g. "ANR1". */
export const seriesOf = (storeCode: string, counterNumber: number) =>
  `${storeCode}${counterNumber}`;

/** Invoice / bill of supply: ANR1/2627/00042 (≤ 16 characters, GST rule 46). */
export const invoiceNumber = (series: string, fy: string, seq: number) =>
  `${series}/${fy}/${String(seq).padStart(5, '0')}`;

/** Credit note: ANR1/2627/C0007 — its own series per counter, also ≤ 16 characters. */
export const creditNoteNumber = (series: string, fy: string, seq: number) =>
  `${series}/${fy}/C${String(seq).padStart(4, '0')}`;
