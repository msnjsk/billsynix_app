/**
 * Thermal printer support.
 *
 * Two ways to print:
 *  1. Browser print (window.print) — works with any printer that has a driver installed.
 *     The receipt is laid out for 58 mm / 80 mm roll paper via @page CSS.
 *  2. Direct ESC/POS over Web Serial (Chrome / Edge) — sends raw printer commands, so it is
 *     faster, needs no print dialog, and can kick the cash drawer. Works with USB / Bluetooth
 *     printers that show up as a serial (COM) port.
 */
import type { PaperWidth } from '@/lib/pos/store';
import {
  COMPOSITION_DECLARATION,
  defaultProfile,
  documentTitle,
  receiptHeaderLines,
  type BusinessProfile,
} from '@/lib/business-profile';
import type { CreditNote, Invoice, PosDocument, TaxSlab } from '@/lib/pos/billing';

/* ---------- ESC/POS encoding ---------- */

const ESC = 0x1b;
const GS = 0x1d;

class EscPos {
  private bytes: number[] = [];
  constructor(readonly cols: number) {
    this.raw(ESC, 0x40); // initialise
  }
  raw(...b: number[]) {
    this.bytes.push(...b);
    return this;
  }
  /** Printers' default code page has no ₹ sign, so amounts print as "Rs". Non-ASCII becomes "?". */
  text(s: string) {
    for (const ch of s.replace(/₹/g, 'Rs')) {
      const c = ch.charCodeAt(0);
      this.bytes.push(c < 0x80 ? c : 0x3f);
    }
    return this;
  }
  /** Prints a line, word-wrapping anything wider than the paper so printers don't split words. */
  line(s = '') {
    if (s.length <= this.cols) return this.text(s).raw(0x0a);
    let cur = '';
    for (const word of s.split(' ')) {
      if (cur && (cur + ' ' + word).length > this.cols) {
        this.text(cur).raw(0x0a);
        cur = word;
      } else cur = cur ? `${cur} ${word}` : word;
    }
    return this.text(cur).raw(0x0a);
  }
  align(a: 'left' | 'center' | 'right') {
    return this.raw(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
  }
  bold(on: boolean) {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }
  /** Double width + height. */
  big(on: boolean) {
    return this.raw(GS, 0x21, on ? 0x11 : 0);
  }
  rule(ch = '-') {
    return this.line(ch.repeat(this.cols));
  }
  /** Left text and right text on one line, left side truncated to fit. */
  pair(left: string, right: string) {
    const room = Math.max(1, this.cols - right.length - 1);
    const l = left.length > room ? left.slice(0, room) : left.padEnd(room);
    return this.line(`${l} ${right}`);
  }
  feedAndCut() {
    return this.raw(ESC, 0x64, 4).raw(GS, 0x56, 0x42, 0x00);
  }
  /** Pulse pin 2 — opens a cash drawer wired to the printer. */
  kickDrawer() {
    return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa);
  }
  build() {
    return new Uint8Array(this.bytes);
  }
}

const amt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function header(p: EscPos, title: string, profile: BusinessProfile) {
  p.align('center').bold(true).big(true).line(profile.displayName).big(false).bold(false);
  receiptHeaderLines(profile).forEach((l) => p.line(l));
  p.rule().bold(true).line(title).bold(false).align('left');
}

/** Bill of supply: no tax table; composition dealers must print the declaration instead. */
function taxTable(p: EscPos, slabs: TaxSlab[], interState: boolean, billOfSupply: boolean | undefined, profile: BusinessProfile) {
  if (billOfSupply) {
    p.rule();
    if (profile.registration === 'composition') p.line(COMPOSITION_DECLARATION);
    else p.line('GST not charged (supplier not registered)');
    return;
  }
  const taxed = slabs.filter((s) => s.rate > 0);
  p.rule();
  if (interState) p.pair('GST%  Taxable', 'IGST');
  else p.pair('GST%  Taxable    CGST', 'SGST');
  for (const s of slabs) {
    const head = `${String(s.rate).padStart(2)}%  ${amt(s.taxable).padStart(9)}`;
    if (interState) p.pair(head, amt(s.igst));
    else p.pair(`${head} ${amt(s.cgst).padStart(8)}`, amt(s.sgst));
  }
  if (!taxed.length) p.line('All items exempt from GST');
}

function invoiceBytes(inv: Invoice, p: EscPos, profile: BusinessProfile) {
  const t = inv.totals;
  const gstTag = (rate: number) => (inv.billOfSupply ? '' : ` @${rate}%`);
  header(p, documentTitle(inv), profile);
  p.pair(`Bill ${inv.no}`, '').pair(when(inv.issuedAt), inv.cashier);
  if (inv.buyer) {
    p.line(`Customer: ${inv.buyer.name}${inv.buyer.phone ? ` ${inv.buyer.phone}` : ''}`);
    if (inv.buyer.gstin) p.line(`Buyer GSTIN: ${inv.buyer.gstin}`);
  }
  p.rule().pair('Item', 'Amount').rule();
  for (const r of t.rows) {
    p.line(r.name);
    p.pair(`  ${r.qty} x ${amt(r.price)}  HSN ${r.hsn}${gstTag(r.gst)}`, amt(r.gross));
    if (r.batch)
      p.line(`  Batch ${r.batch.id} exp ${new Date(r.batch.expiresOn).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`);
    if (r.lineDiscount > 0) p.pair(r.batch ? `  Near-expiry ${r.batch.pct}% off` : '  Discount', `-${amt(r.lineDiscount)}`);
  }
  p.rule().pair(`Items ${t.itemCount}`, amt(t.gross));
  if (t.discountTotal > 0) p.pair('Discount', `-${amt(t.discountTotal)}`);
  if (t.roundOff !== 0) p.pair('Round off', amt(t.roundOff));
  p.bold(true).big(true).pair('TOTAL', `Rs ${amt(t.payable)}`).big(false).bold(false);
  if (t.discountTotal > 0) p.line(`You saved Rs ${amt(t.discountTotal)}`);
  taxTable(p, t.slabs, inv.interState, inv.billOfSupply, profile);
  p.rule();
  for (const pay of inv.payments) p.pair(`Paid ${pay.method}${pay.ref ? ` (${pay.ref})` : ''}`, amt(pay.tendered ?? pay.amount));
  if (inv.change > 0) p.pair('Change', amt(inv.change));
}

function creditBytes(cn: CreditNote, p: EscPos, profile: BusinessProfile) {
  header(p, documentTitle(cn), profile);
  p.pair(`No ${cn.no}`, '').pair(when(cn.issuedAt), cn.cashier).line(`Against bill ${cn.against}`);
  if (cn.buyer) p.line(`Customer: ${cn.buyer.name}`);
  p.rule();
  for (const l of cn.lines) {
    p.line(l.name);
    p.pair(`  ${l.qty} returned  HSN ${l.hsn}${cn.billOfSupply ? '' : ` @${l.gst}%`}`, amt(l.amount));
  }
  p.rule().bold(true).big(true).pair('REFUND', `Rs ${amt(cn.refund.amount)}`).big(false).bold(false);
  p.line(`Refunded by ${cn.refund.method}`).line(`Reason: ${cn.reason}`);
  taxTable(p, cn.slabs, cn.interState, cn.billOfSupply, profile);
}

export function toEscPos(
  doc: PosDocument,
  width: PaperWidth,
  opts: { kickDrawer?: boolean; profile?: BusinessProfile } = {}
) {
  const profile = opts.profile ?? defaultProfile;
  const p = new EscPos(width === 58 ? 32 : 48);
  if (doc.kind === 'invoice') invoiceBytes(doc, p, profile);
  else creditBytes(doc, p, profile);
  if (profile.receiptFooter.trim()) p.rule().align('center').line(profile.receiptFooter.trim()).align('left');
  p.feedAndCut();
  if (opts.kickDrawer) p.kickDrawer();
  return p.build();
}

/* ---------- Web Serial transport ---------- */

type SerialPortLike = {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  writable: WritableStream<Uint8Array> | null;
};
type SerialLike = {
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(): Promise<SerialPortLike>;
};

const serial = () =>
  typeof navigator !== 'undefined' ? ((navigator as Navigator & { serial?: SerialLike }).serial ?? null) : null;

export const serialSupported = () => serial() !== null;

/** Asks the user to pick the printer's port once; Chrome remembers the choice for this site. */
export async function connectSerialPrinter() {
  const s = serial();
  if (!s) throw new Error('Direct printing needs Chrome or Edge on desktop (Web Serial).');
  await s.requestPort();
}

export async function hasSerialPrinter() {
  const s = serial();
  return s ? (await s.getPorts()).length > 0 : false;
}

export async function printEscPos(bytes: Uint8Array, baudRate: number) {
  const s = serial();
  if (!s) throw new Error('Direct printing needs Chrome or Edge on desktop (Web Serial).');
  const [port] = await s.getPorts();
  if (!port) throw new Error('No printer connected. Open POS settings and click "Connect printer".');
  await port.open({ baudRate });
  try {
    const writer = port.writable!.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  } finally {
    await port.close();
  }
}
