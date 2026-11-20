import { parseCsv, toCsv, unguardCell, CsvError } from '../common/csv.js';
import { moneyInput, percentInput } from '../common/decimal.js';
import { barcodeProblem, gtinCheckDigit } from './barcode.js';
import { grossPrice, priceAboveMrp } from './pricing.js';
import { sniffImage } from './products.service.js';
import { CSV_COLUMNS } from './import.service.js';

describe('CSV', () => {
  it('parses quotes, doubled quotes, CRLF, BOM and blank lines', () => {
    const rows = parseCsv(
      '﻿a,b,c\r\n"x, y","say ""hi""",\n\n"multi\nline",2,3',
    );
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', ''],
      ['multi\nline', '2', '3'],
    ]);
  });

  it('reports an unclosed quote with its line', () => {
    expect(() => parseCsv('a,b\n1,"open\n2,3')).toThrow(CsvError);
    try {
      parseCsv('a,b\n1,"open\n2,3');
    } catch (e) {
      expect((e as CsvError).line).toBe(2);
    }
  });

  it('round-trips, including formula-looking cells', () => {
    const data = [
      ['sku', 'name'],
      ['A-1', '=HYPERLINK("evil")'],
      ['B,2', 'Tamil தமிழ் "quoted"'],
    ];
    const csv = toCsv(data);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""evil"")"`);
    const back = parseCsv(csv).map((r) => r.map(unguardCell));
    expect(back).toEqual(data);
  });
});

describe('barcodes', () => {
  it('computes GS1 check digits', () => {
    expect(gtinCheckDigit('400638133393')).toBe('1'); // EAN-13 4006381333931
    expect(gtinCheckDigit('9638507')).toBe('4'); // EAN-8 96385074
    expect(gtinCheckDigit('03600029145')).toBe('2'); // UPC-A 036000291452
  });

  it('accepts valid GTINs and in-house codes, rejects bad check digits', () => {
    expect(barcodeProblem('4006381333931')).toBeNull();
    expect(barcodeProblem('96385074')).toBeNull();
    expect(barcodeProblem('LOOSE-TOMATO')).toBeNull();
    expect(barcodeProblem('12345')).toBeNull(); // not a GS1 length
    expect(barcodeProblem('4006381333932')).toMatch(/check digit/);
    expect(barcodeProblem('ab')).toMatch(/3–32/);
  });

  it('the import template only carries valid barcodes', async () => {
    const { ImportService } = await import('./import.service.js');
    const csv = new ImportService(
      null as never,
      null as never,
      null as never,
    ).template();
    const [header, ...rows] = parseCsv(csv);
    expect(header).toEqual([...CSV_COLUMNS]);
    const col = header!.indexOf('barcodes');
    for (const r of rows)
      for (const code of (r[col] ?? '').split('|').filter(Boolean))
        expect(barcodeProblem(code.split('*')[0]!)).toBeNull();
  });
});

describe('decimal input', () => {
  it('normalises money and refuses extra decimals instead of rounding', () => {
    expect(moneyInput.parse('45')).toBe('45.00');
    expect(moneyInput.parse(45.5)).toBe('45.50');
    expect(moneyInput.safeParse(0.1 + 0.2).success).toBe(false);
    expect(moneyInput.safeParse('-1').success).toBe(false);
    expect(moneyInput.safeParse('1e3').success).toBe(false);
  });
  it('percentages come back as numbers', () => {
    expect(percentInput().parse('12.5')).toBe(12.5);
    expect(percentInput().safeParse(101).success).toBe(false);
  });
});

describe('MRP rule', () => {
  const gst18 = { rate: 18, cessRate: 0 };
  it('GST-inclusive prices compare directly', () => {
    expect(
      priceAboveMrp(
        { mrp: '100', sellingPrice: '100', priceIncludesTax: true },
        gst18,
      ),
    ).toBeNull();
    expect(
      priceAboveMrp(
        { mrp: '100', sellingPrice: '100.01', priceIncludesTax: true },
        gst18,
      ),
    ).toMatch(/above the MRP/);
  });
  it('tax-exclusive prices are compared with GST and cess added', () => {
    expect(grossPrice('84.75', false, gst18).toFixed(2)).toBe('100.01');
    expect(
      priceAboveMrp(
        { mrp: '100', sellingPrice: '84.74', priceIncludesTax: false },
        gst18,
      ),
    ).toBeNull();
    expect(
      priceAboveMrp(
        { mrp: '100', sellingPrice: '84.75', priceIncludesTax: false },
        gst18,
      ),
    ).toMatch(/with GST/);
    expect(
      grossPrice('100', false, { rate: 28, cessRate: 12 }).toFixed(2),
    ).toBe('140.00');
  });
  it('no MRP, no limit', () => {
    expect(
      priceAboveMrp(
        { mrp: null, sellingPrice: '999', priceIncludesTax: true },
        gst18,
      ),
    ).toBeNull();
  });
});

describe('image sniffing', () => {
  it('recognises JPEG, PNG and WebP by content, not name', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniffImage(Buffer.from('89504e470d0a1a0a0000', 'hex'))).toBe('png');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe(
      'webp',
    );
    expect(sniffImage(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull();
  });
});
