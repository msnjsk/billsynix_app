/**
 * Purchase management: purchase orders → goods received notes → supplier bills → payments,
 * with purchase returns (debit notes) and purchase price history.
 *
 * Documents are kept per computer in browser storage until a backend exists. A real store
 * (set up with the wizard) starts empty; demo mode gets sample documents.
 * Dates use the app's demo "today" (TODAY) so they line up with the rest of the sample data.
 */
import { apiConfigured } from '@/lib/api/client';
import { useSyncExternalStore } from 'react';
import { initialSuppliers, TODAY, addDays, daysFromToday, fmtDate, type Supplier } from '@/lib/suppliers-data';
import { inventoryItems, type InventoryItem } from '@/lib/inventory-data';
import { posCatalog, type GstRate } from '@/lib/pos/catalog';
import { r2 } from '@/lib/pos/billing';
import { getBusinessProfile, profileStateCode } from '@/lib/business-profile';
import { getSetup } from '@/lib/setup';

export { TODAY, addDays, daysFromToday, fmtDate };

/* =====================================================================
   Types
   ===================================================================== */

export type Line = {
  sku: string;
  name: string;
  hsn: string;
  gst: GstRate;
  qty: number;
  /** Cost per unit before GST. */
  rate: number;
  discountPct: number;
};

export type PoStatus = 'draft' | 'sent' | 'partial' | 'received' | 'cancelled';
export type PurchaseOrder = {
  id: string;
  supplierId: string;
  date: string;
  expected: string;
  status: PoStatus;
  lines: Line[];
  notes: string;
};

export type GrnLine = {
  sku: string;
  name: string;
  /** Ordered on the PO (null for a delivery without a PO). */
  ordered: number | null;
  received: number;
  rejected: number;
  rejectReason: string;
  batch: string;
  expiry: string;
  rate: number;
};
export type Grn = {
  id: string;
  supplierId: string;
  poId: string | null;
  date: string;
  receivedBy: string;
  supplierChallan: string;
  lines: GrnLine[];
  notes: string;
};

export type SupplierBill = {
  id: string;
  supplierId: string;
  /** The supplier's own invoice number. */
  number: string;
  date: string;
  dueDate: string;
  poId: string | null;
  grnIds: string[];
  lines: Line[];
  /** False when the supplier isn't GST-registered (no tax, no input credit). */
  gstApplies: boolean;
  interState: boolean;
};

export type ReturnReason = 'Damaged' | 'Expired' | 'Short expiry' | 'Wrong item' | 'Excess supply' | 'Quality issue';
export const returnReasons: ReturnReason[] = ['Damaged', 'Expired', 'Short expiry', 'Wrong item', 'Excess supply', 'Quality issue'];
export type ReturnStatus = 'pending' | 'dispatched' | 'settled';
export type PurchaseReturn = {
  id: string;
  supplierId: string;
  billId: string | null;
  grnId: string | null;
  date: string;
  lines: (Line & { reason: ReturnReason })[];
  status: ReturnStatus;
  /** Debit note reduces the bill (adjust) or the supplier pays back (refund). */
  settlement: 'adjust' | 'refund';
  gstApplies: boolean;
  interState: boolean;
};

export type PayMode = 'Bank transfer' | 'UPI' | 'Cheque' | 'Cash';
export const payModes: PayMode[] = ['Bank transfer', 'UPI', 'Cheque', 'Cash'];
export type SupplierPayment = {
  id: string;
  supplierId: string;
  date: string;
  amount: number;
  mode: PayMode;
  ref: string;
  allocations: { billId: string; amount: number }[];
  notes: string;
};

export type PurchaseState = {
  version: 1;
  pos: PurchaseOrder[];
  grns: Grn[];
  bills: SupplierBill[];
  returns: PurchaseReturn[];
  payments: SupplierPayment[];
  /** Older costs (before these documents), for price history. */
  priceSeed: { sku: string; date: string; rate: number; supplierId: string }[];
  next: { po: number; grn: number; bill: number; ret: number; pay: number };
};

/* =====================================================================
   Products & suppliers
   ===================================================================== */

export const suppliers: Supplier[] = initialSuppliers;
export const supplierById = (id: string) => suppliers.find((s) => s.id === id);
export const supplierName = (id: string) => supplierById(id)?.name ?? id;

export const products: InventoryItem[] = inventoryItems;
export const productBySku = (sku: string) => products.find((p) => p.sku === sku);
const taxOf = (sku: string) => {
  const c = posCatalog.find((p) => p.sku === sku);
  return { hsn: c?.hsn ?? '9999', gst: (c?.gst ?? 5) as GstRate };
};

/** A new line for a product at a rate (defaults to its last cost). */
export const lineFor = (sku: string, qty: number, rate?: number): Line => {
  const p = productBySku(sku)!;
  return { sku, name: p.name, ...taxOf(sku), qty, rate: rate ?? p.cost, discountPct: 0 };
};

/** GST treatment for a supplier: unregistered → no GST; other state → IGST. */
export const gstFor = (s: Supplier | undefined) => {
  const gstApplies = !!s?.gstin;
  const interState = gstApplies && s!.gstin.slice(0, 2) !== profileStateCode(getBusinessProfile());
  return { gstApplies, interState };
};

/* =====================================================================
   Calculations
   ===================================================================== */

export const lineTaxable = (l: Pick<Line, 'qty' | 'rate' | 'discountPct'>) => r2(l.qty * l.rate * (1 - (l.discountPct || 0) / 100));
/** Effective cost per unit after discount — what price history tracks. */
export const netRate = (l: Pick<Line, 'rate' | 'discountPct'>) => r2(l.rate * (1 - (l.discountPct || 0) / 100));

export type Totals = { taxable: number; cgst: number; sgst: number; igst: number; tax: number; roundOff: number; total: number };

export function totalsOf(lines: Line[], gstApplies: boolean, interState: boolean): Totals {
  let taxable = 0;
  let tax = 0;
  for (const l of lines) {
    const t = lineTaxable(l);
    taxable += t;
    if (gstApplies) tax += (t * l.gst) / 100;
  }
  taxable = r2(taxable);
  tax = r2(tax);
  const cgst = interState ? 0 : r2(tax / 2);
  const sgst = interState ? 0 : r2(tax - cgst);
  const igst = interState ? tax : 0;
  const exact = r2(taxable + tax);
  const total = Math.round(exact);
  return { taxable, cgst, sgst, igst, tax, roundOff: r2(total - exact), total };
}

export const poTotals = (po: PurchaseOrder) => totalsOf(po.lines, gstFor(supplierById(po.supplierId)).gstApplies, gstFor(supplierById(po.supplierId)).interState);
export const billTotals = (b: SupplierBill) => totalsOf(b.lines, b.gstApplies, b.interState);
export const returnTotals = (r: PurchaseReturn) => totalsOf(r.lines, r.gstApplies, r.interState);

/** Accepted (received − rejected) per SKU across GRNs. */
export const acceptedBySku = (grns: Grn[]) => {
  const m = new Map<string, number>();
  for (const g of grns) for (const l of g.lines) m.set(l.sku, (m.get(l.sku) ?? 0) + l.received - l.rejected);
  return m;
};

/** How much of each PO line has been received so far. */
export function poProgress(po: PurchaseOrder, grns: Grn[]) {
  const got = acceptedBySku(grns.filter((g) => g.poId === po.id));
  const lines = po.lines.map((l) => ({ ...l, received: got.get(l.sku) ?? 0, pending: Math.max(0, l.qty - (got.get(l.sku) ?? 0)) }));
  const ordered = lines.reduce((s, l) => s + l.qty, 0);
  const received = lines.reduce((s, l) => s + Math.min(l.qty, l.received), 0);
  return { lines, ordered, received, pct: ordered ? Math.round((received / ordered) * 100) : 0 };
}

/** PO status follows its GRNs unless it is a draft or cancelled. */
export function poStatus(po: PurchaseOrder, grns: Grn[]): PoStatus {
  if (po.status === 'draft' || po.status === 'cancelled') return po.status;
  const { ordered, received } = poProgress(po, grns);
  if (received <= 0) return 'sent';
  return received >= ordered ? 'received' : 'partial';
}

export type MatchIssue = { sku: string; name: string; kind: 'qty' | 'price' | 'not-received'; detail: string };

/**
 * Three-way match: every billed line against what was accepted on the linked GRNs (quantity)
 * and against the PO rate (price, 0.5% tolerance).
 */
export function matchBill(bill: Pick<SupplierBill, 'lines' | 'grnIds' | 'poId'>, state: PurchaseState): MatchIssue[] {
  const issues: MatchIssue[] = [];
  const grns = state.grns.filter((g) => bill.grnIds.includes(g.id));
  const accepted = acceptedBySku(grns);
  const po = bill.poId ? state.pos.find((p) => p.id === bill.poId) : undefined;
  for (const l of bill.lines) {
    if (grns.length) {
      const got = accepted.get(l.sku) ?? 0;
      if (got === 0) issues.push({ sku: l.sku, name: l.name, kind: 'not-received', detail: 'Billed but not on the goods receipt' });
      else if (l.qty > got + 1e-9) issues.push({ sku: l.sku, name: l.name, kind: 'qty', detail: `Billed ${l.qty}, accepted ${got}` });
    }
    const poLine = po?.lines.find((x) => x.sku === l.sku);
    if (poLine && netRate(l) > netRate(poLine) * 1.005)
      issues.push({ sku: l.sku, name: l.name, kind: 'price', detail: `Billed ₹${netRate(l)}, PO ₹${netRate(poLine)}` });
  }
  return issues;
}

/* ---------- payables ---------- */

export const paidOn = (billId: string, payments: SupplierPayment[]) =>
  r2(payments.reduce((s, p) => s + p.allocations.filter((a) => a.billId === billId).reduce((x, a) => x + a.amount, 0), 0));

/** Debit notes issued against a bill that reduce what we owe. */
export const debitedOn = (billId: string, returns: PurchaseReturn[]) =>
  r2(returns.filter((r) => r.billId === billId && r.settlement === 'adjust').reduce((s, r) => s + returnTotals(r).total, 0));

export const billBalance = (b: SupplierBill, s: PurchaseState) => r2(billTotals(b).total - paidOn(b.id, s.payments) - debitedOn(b.id, s.returns));

export type BillStatus = 'unpaid' | 'partial' | 'paid' | 'overdue';
export function billStatus(b: SupplierBill, s: PurchaseState): BillStatus {
  const bal = billBalance(b, s);
  if (bal <= 0.5) return 'paid';
  if (daysFromToday(b.dueDate) < 0) return 'overdue';
  return paidOn(b.id, s.payments) + debitedOn(b.id, s.returns) > 0 ? 'partial' : 'unpaid';
}

export type AgeBucket = 'current' | 'd1_30' | 'd31_60' | 'd60';
export const ageBuckets: Record<AgeBucket, string> = { current: 'Not yet due', d1_30: '1–30 days late', d31_60: '31–60 days late', d60: '60+ days late' };
export const ageOf = (b: SupplierBill): AgeBucket => {
  const late = -daysFromToday(b.dueDate);
  return late <= 0 ? 'current' : late <= 30 ? 'd1_30' : late <= 60 ? 'd31_60' : 'd60';
};

/** Money paid to a supplier that isn't allocated to any bill yet (advance). */
export const unallocated = (p: SupplierPayment) => r2(p.amount - p.allocations.reduce((s, a) => s + a.amount, 0));

/* ---------- price history ---------- */

export type PricePoint = { date: string; rate: number; supplierId: string; source: string };

export function priceHistory(sku: string, s: PurchaseState): PricePoint[] {
  const fromBills = s.bills.flatMap((b) =>
    b.lines.filter((l) => l.sku === sku).map((l) => ({ date: b.date, rate: netRate(l), supplierId: b.supplierId, source: `Bill ${b.number}` }))
  );
  const seed = s.priceSeed.filter((p) => p.sku === sku).map((p) => ({ ...p, source: 'Earlier purchase' }));
  return [...seed, ...fromBills].sort((a, b) => a.date.localeCompare(b.date));
}

/** Change of the latest cost vs the one before it (%). */
export const lastChangePct = (h: PricePoint[]) => {
  if (h.length < 2) return 0;
  const a = h[h.length - 2]!.rate;
  const b = h[h.length - 1]!.rate;
  return a ? Math.round(((b - a) / a) * 1000) / 10 : 0;
};

/* =====================================================================
   Sample documents (demo mode)
   ===================================================================== */

const sku = (name: string) => products.find((p) => p.name === name)!.sku;
const L = (name: string, qty: number, rate?: number, discountPct = 0): Line => ({ ...lineFor(sku(name), qty, rate), discountPct });
const G = (name: string, ordered: number | null, received: number, rejected = 0, reason = '', batch = '', expiry = ''): GrnLine => {
  const p = products.find((x) => x.name === name)!;
  return { sku: p.sku, name: p.name, ordered, received, rejected, rejectReason: reason, batch, expiry, rate: p.cost };
};
const d = (n: number) => addDays(TODAY, n);
const gstOf = (supplierId: string) => gstFor(supplierById(supplierId));

function seed(): PurchaseState {
  const sbt = 'sri-balaji-traders';
  const ndc = 'nandini-dairy-co-op';
  const fz = 'fizzo-beverages';
  const bh = 'bake-house';
  const pos: PurchaseOrder[] = [
    { id: 'PO-1041', supplierId: ndc, date: d(-14), expected: d(-13), status: 'sent', notes: '', lines: [L('Nandini Milk 1L', 200), L('Nandini Curd 400g', 80), L('Paneer Fresh 200g', 40)] },
    { id: 'PO-1042', supplierId: sbt, date: d(-12), expected: d(-11), status: 'sent', notes: 'Monthly staples', lines: [L('Gehu Gold Atta 5kg', 60, 186), L('Sagar Rice Ponni 10kg', 30, 465), L('Toor Dal 1kg', 50, 124), L('Kavya Sunflower Oil 1L', 40, 132)] },
    { id: 'PO-1043', supplierId: fz, date: d(-5), expected: d(-5), status: 'sent', notes: '', lines: [L('Fizzo Cola 750ml', 144, 30)] },
    { id: 'PO-1044', supplierId: bh, date: d(-1), expected: d(-1), status: 'sent', notes: '', lines: [L('Bake House Bread', 60)] },
    { id: 'PO-1045', supplierId: ndc, date: d(-1), expected: d(0), status: 'sent', notes: 'Weekend stock-up', lines: [L('Nandini Milk 1L', 240), L('Nandini Curd 400g', 60), L('Eggs Tray 30', 20)] },
    { id: 'PO-1046', supplierId: fz, date: d(0), expected: d(2), status: 'sent', notes: '', lines: [L('Fizzo Cola 750ml', 192, 32)] },
    { id: 'PO-1047', supplierId: sbt, date: d(0), expected: d(2), status: 'draft', notes: 'Low-stock reorder', lines: [L('Kavya Sunflower Oil 1L', 48, 138), L('Toor Dal 1kg', 40, 128), L('Sudha Detergent 1kg', 24)] },
  ];
  const grns: Grn[] = [
    { id: 'GRN-0225', supplierId: ndc, poId: 'PO-1041', date: d(-13), receivedBy: 'Arun K', supplierChallan: 'NDC-DC-5512', notes: '', lines: [G('Nandini Milk 1L', 200, 200), G('Nandini Curd 400g', 80, 80), G('Paneer Fresh 200g', 40, 40)] },
    { id: 'GRN-0226', supplierId: sbt, poId: 'PO-1042', date: d(-11), receivedBy: 'Arun K', supplierChallan: 'SBT/DC/0931', notes: '', lines: [G('Gehu Gold Atta 5kg', 60, 60), G('Sagar Rice Ponni 10kg', 30, 30), G('Toor Dal 1kg', 50, 50), G('Kavya Sunflower Oil 1L', 40, 40)] },
    { id: 'GRN-0227', supplierId: fz, poId: 'PO-1043', date: d(-5), receivedBy: 'Priya S', supplierChallan: 'FZ-88213', notes: '', lines: [G('Fizzo Cola 750ml', 144, 144)] },
    { id: 'GRN-0228', supplierId: bh, poId: 'PO-1044', date: d(-1), receivedBy: 'Priya S', supplierChallan: '', notes: '', lines: [G('Bake House Bread', 60, 60, 0, '', 'BK-0514', d(2))] },
    {
      id: 'GRN-0229', supplierId: ndc, poId: 'PO-1045', date: d(0), receivedBy: 'Arun K', supplierChallan: 'NDC-DC-5590', notes: 'One curd crate crushed in transit',
      lines: [G('Nandini Milk 1L', 240, 240, 0, '', 'DC-2310', d(6)), G('Nandini Curd 400g', 60, 60, 6, 'Damaged', 'DC-2291', d(1)), G('Eggs Tray 30', 20, 16, 0)],
    },
  ];
  const bills: SupplierBill[] = [
    { id: 'PB-0101', supplierId: ndc, number: 'NDC/2425/7702', date: d(-13), dueDate: d(-6), poId: 'PO-1041', grnIds: ['GRN-0225'], ...gstOf(ndc), lines: [L('Nandini Milk 1L', 200), L('Nandini Curd 400g', 80), L('Paneer Fresh 200g', 40)] },
    { id: 'PB-0102', supplierId: sbt, number: 'SBT/24-25/0188', date: d(-11), dueDate: d(-1), poId: 'PO-1042', grnIds: ['GRN-0226'], ...gstOf(sbt), lines: [L('Gehu Gold Atta 5kg', 60, 186), L('Sagar Rice Ponni 10kg', 30, 465), L('Toor Dal 1kg', 50, 124), L('Kavya Sunflower Oil 1L', 40, 132, 2)] },
    { id: 'PB-0103', supplierId: fz, number: 'FZ/S/24/4410', date: d(-5), dueDate: d(10), poId: 'PO-1043', grnIds: ['GRN-0227'], ...gstOf(fz), lines: [L('Fizzo Cola 750ml', 144, 30)] },
    { id: 'PB-0104', supplierId: bh, number: 'BH-3391', date: d(-1), dueDate: d(6), poId: 'PO-1044', grnIds: ['GRN-0228'], ...gstOf(bh), lines: [L('Bake House Bread', 60)] },
    // Billed for 60 curd although only 54 were accepted, and eggs billed at a higher rate than the PO.
    { id: 'PB-0105', supplierId: ndc, number: 'NDC/2425/7781', date: d(0), dueDate: d(7), poId: 'PO-1045', grnIds: ['GRN-0229'], ...gstOf(ndc), lines: [L('Nandini Milk 1L', 240), L('Nandini Curd 400g', 60), L('Eggs Tray 30', 16, 176)] },
  ];
  const returns: PurchaseReturn[] = [
    { id: 'DN-0012', supplierId: ndc, billId: 'PB-0105', grnId: 'GRN-0229', date: d(0), status: 'pending', settlement: 'adjust', ...gstOf(ndc), lines: [{ ...L('Nandini Curd 400g', 6), reason: 'Damaged' }] },
  ];
  const payments: SupplierPayment[] = [
    { id: 'PAY-0043', supplierId: ndc, date: d(-7), amount: totalsOf(bills[0]!.lines, true, false).total, mode: 'UPI', ref: 'UPI/412873', notes: '', allocations: [{ billId: 'PB-0101', amount: totalsOf(bills[0]!.lines, true, false).total }] },
    { id: 'PAY-0044', supplierId: sbt, date: d(-4), amount: 15000, mode: 'Bank transfer', ref: 'NEFT/88213', notes: 'Part payment', allocations: [{ billId: 'PB-0102', amount: 15000 }] },
    { id: 'PAY-0045', supplierId: fz, date: d(-4), amount: 4600, mode: 'UPI', ref: 'UPI/409911', notes: '', allocations: [{ billId: 'PB-0103', amount: 4600 }] },
  ];
  const months = [-150, -120, -90, -60, -30];
  const hist: [string, string, number[]][] = [
    [sbt, 'Kavya Sunflower Oil 1L', [118, 122, 124, 128, 130]],
    [sbt, 'Toor Dal 1kg', [112, 114, 118, 118, 121]],
    [sbt, 'Gehu Gold Atta 5kg', [178, 180, 180, 184, 186]],
    [sbt, 'Sagar Rice Ponni 10kg', [470, 470, 468, 465, 465]],
    [ndc, 'Nandini Milk 1L', [52.8, 52.8, 52.8, 52.8, 52.8]],
    [ndc, 'Eggs Tray 30', [150, 156, 162, 160, 166]],
    [fz, 'Fizzo Cola 750ml', [29, 29, 30, 30, 30]],
  ];
  const priceSeed = hist.flatMap(([sup, name, rates]) => rates.map((rate, i) => ({ sku: sku(name), date: d(months[i]!), rate, supplierId: sup })));
  return { version: 1, pos, grns, bills, returns, payments, priceSeed, next: { po: 1048, grn: 230, bill: 106, ret: 13, pay: 46 } };
}

const empty = (): PurchaseState => ({
  version: 1,
  pos: [],
  grns: [],
  bills: [],
  returns: [],
  payments: [],
  priceSeed: [],
  next: { po: 1, grn: 1, bill: 1, ret: 1, pay: 1 },
});

/* =====================================================================
   Numbering
   ===================================================================== */

export const docNo = {
  po: (n: number) => `PO-${String(n).padStart(4, '0')}`,
  grn: (n: number) => `GRN-${String(n).padStart(4, '0')}`,
  bill: (n: number) => `PB-${String(n).padStart(4, '0')}`,
  ret: (n: number) => `DN-${String(n).padStart(4, '0')}`,
  pay: (n: number) => `PAY-${String(n).padStart(4, '0')}`,
};

/* =====================================================================
   Store (browser storage + live hook)
   ===================================================================== */

const KEY = 'kirana:purchases';
let cache: PurchaseState | null = null;
const listeners = new Set<() => void>();

function read(): PurchaseState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as PurchaseState;
      if (s.version === 1) return s;
    }
  } catch {
    /* fall through */
  }
  // First use on this computer: sample documents only in demo mode.
  return getSetup()?.mode === 'store' ? empty() : seed();
}

export function getPurchases(): PurchaseState {
  if (typeof window === 'undefined') return seedForServer;
  cache ??= read();
  return cache;
}
const seedForServer = empty();

export function updatePurchases(fn: (s: PurchaseState) => PurchaseState) {
  cache = fn(getPurchases());
  try {
    // Connected to a backend: the documents live on the server (lib/live), not in this browser.
    if (!apiConfigured) window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage full / blocked — changes last for this session */
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return;
    cache = null;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function usePurchases() {
  return useSyncExternalStore(subscribe, getPurchases, () => seedForServer);
}

/** Reloads the sample documents (demo mode / testing). */
export function resetPurchasesToSample() {
  updatePurchases(() => seed());
}
