import { describe, expect, it } from 'vitest';
import { CODE128_TABLE, barcodeSvg, code128Modules, code128Values, ean13CheckDigit, ean13Modules, encodeBarcode, isEan13 } from './barcode';

describe('barcodes for labels', () => {
  it('EAN-13: check digit, 95 modules, guard bars', () => {
    expect(ean13CheckDigit('890123410001')).toBe('1'); // 8+27+0+3+2+9+4+3+0+0+0+3 = 59
    expect(isEan13('8901234100011')).toBe(true);
    expect(isEan13('8901234100017')).toBe(false);
    const m = ean13Modules('4006381333931'); // a well-known example code
    expect(m).toHaveLength(95);
    expect(m.startsWith('101')).toBe(true);
    expect(m.slice(45, 50)).toBe('01010');
    expect(m.endsWith('101')).toBe(true);
    // Left half of 4006381333931 (parity LGLLGG for leading 4): digit 0 in L = 0001101
    expect(m.slice(3, 10)).toBe('0001101');
  });

  it('Code 128-B: every symbol is 11 modules, checksum, stop', () => {
    expect(CODE128_TABLE).toHaveLength(107);
    CODE128_TABLE.slice(0, 106).forEach((w) => expect([...w].reduce((s, d) => s + Number(d), 0)).toBe(11));
    expect([...CODE128_TABLE[106]!].reduce((s, d) => s + Number(d), 0)).toBe(13);
    // PJJ123C: (104 + 48·1 + 42·2 + 42·3 + 17·4 + 18·5 + 19·6 + 35·7) mod 103 = 879 mod 103 = 55
    const v = code128Values('PJJ123C');
    expect(v[0]).toBe(104);
    expect(v[v.length - 2]).toBe(55);
    expect(code128Modules('AB')).toHaveLength(11 * 4 + 13);
    expect(() => code128Values('tab\there')).toThrow();
  });

  it('picks EAN-13 only for valid retail codes and draws an SVG', () => {
    expect(encodeBarcode('8901234100011').kind).toBe('EAN-13');
    expect(encodeBarcode('P-E546BFF0').kind).toBe('Code 128');
    const svg = barcodeSvg('P-1&<2>');
    expect(svg).toContain('<svg');
    expect(svg).toContain('P-1&amp;&lt;2&gt;');
  });
});
