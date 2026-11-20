import {
  docTotals,
  lineAmounts,
  netRate,
  stockUnitCost,
} from './purchase-math.js';

const rice = { qty: 100, rate: 40, discountPct: 2, gstRate: 5, cessRate: 0 };
const oil = { qty: 50, rate: 120, discountPct: 0, gstRate: 5, cessRate: 0 };

describe('purchase maths', () => {
  it('applies the line discount before tax', () => {
    expect(netRate(rice).toFixed(2)).toBe('39.20');
    const a = lineAmounts(rice, true);
    expect([a.taxable.toFixed(2), a.gst.toFixed(2)]).toEqual([
      '3920.00',
      '196.00',
    ]);
  });

  it('splits GST into CGST + SGST within a state, IGST across states', () => {
    const intra = docTotals([rice, oil], true, false);
    expect(
      [intra.taxable, intra.cgst, intra.sgst, intra.igst, intra.total].map(
        (d) => d.toFixed(2),
      ),
    ).toEqual(['9920.00', '248.00', '248.00', '0.00', '10416.00']);
    const inter = docTotals([rice, oil], true, true);
    expect(
      [inter.cgst, inter.sgst, inter.igst].map((d) => d.toFixed(2)),
    ).toEqual(['0.00', '0.00', '496.00']);
  });

  it('an unregistered supplier charges no GST', () => {
    const t = docTotals([rice, oil], false, false);
    expect([t.taxable.toFixed(2), t.total.toFixed(2)]).toEqual([
      '9920.00',
      '9920.00',
    ]);
  });

  it('rounds the payable to the rupee and shows the round-off; odd paise split CGST/SGST exactly', () => {
    const t = docTotals(
      [
        { qty: 60, rate: 39.2, discountPct: 0, gstRate: 5, cessRate: 0 },
        { qty: 50, rate: 125, discountPct: 0, gstRate: 5, cessRate: 0 },
      ],
      true,
      false,
    );
    expect(t.taxable.toFixed(2)).toBe('8602.00');
    expect(t.cgst.plus(t.sgst).toFixed(2)).toBe('430.10');
    expect([t.cgst.toFixed(2), t.sgst.toFixed(2)]).toEqual([
      '215.05',
      '215.05',
    ]);
    expect([t.total.toFixed(2), t.roundOff.toFixed(2)]).toEqual([
      '9032.00',
      '-0.10',
    ]);
    const odd = docTotals(
      [{ qty: 1, rate: 10.1, discountPct: 0, gstRate: 5, cessRate: 0 }],
      true,
      false,
    );
    expect(odd.cgst.plus(odd.sgst).toFixed(2)).toBe('0.51');
  });

  it('cess is added on top of GST', () => {
    const t = docTotals(
      [{ qty: 10, rate: 100, discountPct: 0, gstRate: 28, cessRate: 12 }],
      true,
      true,
    );
    expect([t.igst.toFixed(2), t.cess.toFixed(2), t.total.toFixed(2)]).toEqual([
      '280.00',
      '120.00',
      '1400.00',
    ]);
  });

  it('stock cost excludes GST only when it can be claimed back', () => {
    expect(stockUnitCost(rice, true, true).toFixed(4)).toBe('39.2000');
    expect(stockUnitCost(rice, true, false).toFixed(4)).toBe('41.1600');
    expect(stockUnitCost(rice, false, false).toFixed(4)).toBe('39.2000');
  });
});
