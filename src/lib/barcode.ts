/**
 * Barcodes for shelf and product labels, drawn as SVG (no library, works offline):
 * EAN-13 for 13-digit retail codes with a valid check digit, Code 128 (set B) for anything else
 * (SKUs, in-house codes). Widths are in modules; the SVG scales to the label.
 */

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = L.map((p) => [...p].map((b) => (b === '0' ? '1' : '0')).join(''));
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export const ean13CheckDigit = (body12: string) => {
  const sum = [...body12].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return String((10 - (sum % 10)) % 10);
};
export const isEan13 = (code: string) => /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === code[12];

/** 95 modules: 1 = bar. */
export function ean13Modules(code: string): string {
  if (!isEan13(code)) throw new Error('Not a valid EAN-13');
  const d = [...code].map(Number);
  const parity = PARITY[d[0]!]!;
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? L : G)[d[i]!]!;
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[d[i]!]!;
  return bits + '101';
}

/** Code 128 bar/space widths, values 0–106 (106 = stop, 7 elements). */
const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
export const CODE128_TABLE = C128;
const START_B = 104;
const STOP = 106;

/** Code 128-B: printable ASCII 32–126. Returns the symbol values incl. start, checksum and stop. */
export function code128Values(text: string): number[] {
  const vals = [...text].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error(`Can’t put “${ch}” in a barcode`);
    return c - 32;
  });
  const check = (START_B + vals.reduce((s, v, i) => s + v * (i + 1), 0)) % 103;
  return [START_B, ...vals, check, STOP];
}

/** Modules (1 = bar) for Code 128-B. */
export function code128Modules(text: string): string {
  let bits = '';
  for (const v of code128Values(text)) {
    const w = C128[v]!;
    for (let i = 0; i < w.length; i++) bits += (i % 2 === 0 ? '1' : '0').repeat(Number(w[i]));
  }
  return bits;
}

export type Barcode = { kind: 'EAN-13' | 'Code 128'; modules: string; text: string };

export function encodeBarcode(code: string): Barcode {
  const c = code.trim();
  if (isEan13(c)) return { kind: 'EAN-13', modules: ean13Modules(c), text: c };
  return { kind: 'Code 128', modules: code128Modules(c), text: c };
}

/**
 * The barcode as an SVG string: bars merged into runs, a quiet zone either side, and the
 * human-readable digits below. `height` is the bar height in modules.
 */
export function barcodeSvg(code: string, opts: { height?: number; showText?: boolean } = {}): string {
  const b = encodeBarcode(code);
  const quiet = b.kind === 'EAN-13' ? 9 : 10;
  const height = opts.height ?? 40;
  const text = opts.showText ?? true;
  const w = b.modules.length + quiet * 2;
  const h = height + (text ? 11 : 0);
  let rects = '';
  for (let i = 0; i < b.modules.length; ) {
    if (b.modules[i] === '1') {
      let j = i;
      while (b.modules[j] === '1') j++;
      rects += `<rect x="${i + quiet}" y="0" width="${j - i}" height="${height}"/>`;
      i = j;
    } else i++;
  }
  const label = text
    ? `<text x="${w / 2}" y="${h - 1}" text-anchor="middle" font-family="ui-monospace,Consolas,monospace" font-size="9" letter-spacing="0.5">${escapeXml(b.text)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" shape-rendering="crispEdges" fill="#000">${rects}${label}</svg>`;
}

const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
