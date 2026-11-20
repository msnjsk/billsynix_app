import { Decimal } from '../common/decimal.js';
import {
  computeBill,
  creditNoteNumber,
  fyOf,
  inclusivePrice,
  invoiceNumber,
  type BillLineIn,
} from './bill-math.js';

const line = (
  price: number,
  qty: number,
  gst: number,
  discount: BillLineIn['discount'] = null,
  cess = 0,
): BillLineIn => ({
  unitPrice: new Decimal(price),
  qty: new Decimal(qty),
  gstRate: new Decimal(gst),
  cessRate: new Decimal(cess),
  discount,
});
const s = (d: Decimal) => d.toFixed(2);
const intra = { interState: false, chargeGst: true };

describe('bill maths (twin of the frontend computeBill)', () => {
  it('works GST back out of inclusive prices and rounds the payable to the rupee', () => {
    // Atta 299 @5%, milk 27 ×2 @0%, cola 45 @40%
    const b = computeBill(
      [line(299, 1, 5), line(27, 2, 0), line(45, 1, 40)],
      null,
      intra,
    );
    expect(b.rows.map((r) => [s(r.final), s(r.taxable), s(r.gst)])).toEqual([
      ['299.00', '284.76', '14.24'],
      ['54.00', '54.00', '0.00'],
      ['45.00', '32.14', '12.86'],
    ]);
    expect([s(b.total), s(b.payable), s(b.roundOff)]).toEqual([
      '398.00',
      '398.00',
      '0.00',
    ]);
    expect(b.slabs.map((x) => [s(x.rate), s(x.cgst), s(x.sgst)])).toEqual([
      ['0.00', '0.00', '0.00'],
      ['5.00', '7.12', '7.12'],
      ['40.00', '6.43', '6.43'],
    ]);
  });

  it('applies line discounts, then shares the bill discount pro-rata (remainder on the biggest line)', () => {
    const b = computeBill(
      [
        line(100, 3, 18, { kind: 'PCT', value: new Decimal(10) }),
        line(50, 1, 5),
        line(33.33, 1, 5),
      ],
      { kind: 'AMT', value: new Decimal(10) },
      intra,
    );
    expect(s(b.lineDiscounts)).toBe('30.00');
    expect(b.rows.map((r) => s(r.billShare))).toEqual(['7.64', '1.42', '0.94']);
    expect(s(b.billDiscount)).toBe('10.00');
    expect(s(b.total)).toBe('343.33');
    expect([s(b.payable), s(b.roundOff)]).toEqual(['343.00', '-0.33']);
  });

  it('charges IGST across states, and no GST on a bill of supply', () => {
    const inter = computeBill([line(118, 1, 18)], null, {
      interState: true,
      chargeGst: true,
    });
    expect([s(inter.igst), s(inter.cgst), s(inter.taxable)]).toEqual([
      '18.00',
      '0.00',
      '100.00',
    ]);
    const bos = computeBill([line(118, 1, 18)], null, {
      interState: false,
      chargeGst: false,
    });
    expect([s(bos.taxable), s(bos.cgst), s(bos.payable)]).toEqual([
      '118.00',
      '0.00',
      '118.00',
    ]);
  });

  it('separates cess from GST and converts tax-exclusive prices', () => {
    const b = computeBill([line(140, 1, 28, null, 12)], null, intra);
    expect([s(b.taxable), s(b.cgst.plus(b.sgst)), s(b.cess)]).toEqual([
      '100.00',
      '28.00',
      '12.00',
    ]);
    expect(
      s(inclusivePrice(new Decimal(100), new Decimal(5), new Decimal(0))),
    ).toBe('105.00');
  });

  it('numbers documents per counter and financial year within 16 characters', () => {
    expect(fyOf('2026-11-17')).toBe('2627');
    expect(fyOf('2027-03-31')).toBe('2627');
    expect(fyOf('2027-04-01')).toBe('2728');
    expect(invoiceNumber('ANRS9', '2627', 42)).toBe('ANRS9/2627/00042');
    expect(invoiceNumber('ANRS9', '2627', 99999).length).toBeLessThanOrEqual(
      16,
    );
    expect(creditNoteNumber('ANRS9', '2627', 7)).toBe('ANRS9/2627/C0007');
    expect(creditNoteNumber('ANRS9', '2627', 9999).length).toBeLessThanOrEqual(
      16,
    );
  });
});
