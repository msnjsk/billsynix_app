import { Decimal } from '../common/decimal.js';

type Num = Decimal | string | number;

export type PricedLine = {
  qty: Num;
  /** Per unit, before discount, excluding GST. */
  rate: Num;
  discountPct: Num;
  gstRate: Num;
  cessRate: Num;
};

const HUNDRED = new Decimal(100);
const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Net rate per unit after the line discount (what price history and supplier prices track). */
export const netRate = (l: Pick<PricedLine, 'rate' | 'discountPct'>) =>
  new Decimal(l.rate).times(HUNDRED.minus(l.discountPct)).dividedBy(HUNDRED);

/** Taxable value, GST and cess of one line (each rounded to paise, as on a tax invoice). */
export function lineAmounts(l: PricedLine, gstApplies: boolean) {
  const taxable = r2(netRate(l).times(l.qty));
  const gst = gstApplies
    ? r2(taxable.times(l.gstRate).dividedBy(HUNDRED))
    : new Decimal(0);
  const cess = gstApplies
    ? r2(taxable.times(l.cessRate).dividedBy(HUNDRED))
    : new Decimal(0);
  return { taxable, gst, cess };
}

export type DocTotals = {
  taxable: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  cess: Decimal;
  roundOff: Decimal;
  total: Decimal;
};

/**
 * Document totals, same method as the frontend's purchase screens: GST summed over lines, then
 * split CGST/SGST half-and-half within a state or charged as IGST across states; the payable is
 * rounded to the nearest rupee and the difference shown as round-off.
 */
export function docTotals(
  lines: readonly PricedLine[],
  gstApplies: boolean,
  interState: boolean,
): DocTotals {
  let taxable = new Decimal(0);
  let gst = new Decimal(0);
  let cess = new Decimal(0);
  for (const l of lines) {
    const a = lineAmounts(l, gstApplies);
    taxable = taxable.plus(a.taxable);
    gst = gst.plus(a.gst);
    cess = cess.plus(a.cess);
  }
  const cgst = interState ? new Decimal(0) : r2(gst.dividedBy(2));
  const sgst = interState ? new Decimal(0) : gst.minus(cgst);
  const igst = interState ? gst : new Decimal(0);
  const exact = taxable.plus(gst).plus(cess);
  const total = exact.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return {
    taxable,
    cgst,
    sgst,
    igst,
    cess,
    roundOff: total.minus(exact),
    total,
  };
}

/**
 * Cost per unit that goes into stock valuation: the net rate, plus GST and cess when the business
 * can't claim them back as input tax credit (composition / unregistered businesses, or an
 * unregistered supplier who charges none — then there's nothing to add).
 */
export function stockUnitCost(
  l: PricedLine,
  gstApplies: boolean,
  creditClaimable: boolean,
) {
  const net = netRate(l);
  if (!gstApplies || creditClaimable) return net.toDecimalPlaces(4);
  return net
    .times(HUNDRED.plus(l.gstRate).plus(l.cessRate))
    .dividedBy(HUNDRED)
    .toDecimalPlaces(4);
}

export const totalsView = (t: DocTotals) => ({
  taxable: t.taxable.toFixed(2),
  cgst: t.cgst.toFixed(2),
  sgst: t.sgst.toFixed(2),
  igst: t.igst.toFixed(2),
  cess: t.cess.toFixed(2),
  roundOff: t.roundOff.toFixed(2),
  total: t.total.toFixed(2),
});
