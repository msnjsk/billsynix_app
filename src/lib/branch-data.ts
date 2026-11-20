/**
 * Multi-store management: branches (stores + warehouses), one central product catalogue with
 * branch-level prices and listings, stock per branch, stock transfers, and branch sales.
 *
 * Kept per computer in browser storage until a backend exists. Each computer works "at" one
 * branch (chosen in the header); the POS bills with that branch's prices, stock and GSTIN.
 * A real store (set up with the wizard) starts with one branch built from its business profile;
 * demo mode gets a five-location sample chain.
 */
import { apiConfigured } from '@/lib/api/client';
import { useSyncExternalStore } from 'react';
import { inventoryItems } from '@/lib/inventory-data';
import { dailySales } from '@/lib/dashboard-data';
import { TODAY, addDays, fmtDate } from '@/lib/suppliers-data';
import { getBusinessProfile, gstStates, type BusinessProfile } from '@/lib/business-profile';
import { getSetup } from '@/lib/setup';

export { TODAY, fmtDate };

/* =====================================================================
   Types
   ===================================================================== */

export type Branch = {
  id: string;
  /** Short code (2–4 characters), also the invoice prefix for non-HQ branches — CODE/24-25/00001 stays within GST's 16-character limit. */
  code: string;
  name: string;
  kind: 'store' | 'warehouse';
  isHq: boolean;
  address: { line1: string; city: string; pincode: string; stateCode: string };
  phone: string;
  /** GSTIN of the registration this branch bills under (one per state). */
  gstin: string;
  manager: string;
  openedOn: string;
  active: boolean;
  /** Monthly sales target (stores). */
  monthlyTarget: number;
};

export type TransferStatus = 'requested' | 'in-transit' | 'received' | 'cancelled';
export type Transfer = {
  id: string;
  from: string;
  to: string;
  date: string;
  status: TransferStatus;
  lines: { sku: string; qty: number; received: number | null }[];
  requestedBy: string;
  notes: string;
  dispatchedOn: string | null;
  receivedOn: string | null;
};

export type BranchState = {
  version: 1;
  branches: Branch[];
  /** Branch this computer works at. */
  currentId: string;
  /** Selling-price overrides: branchId → sku → price (GST inclusive). */
  prices: Record<string, Record<string, number>>;
  /** Products a branch doesn't sell: branchId → skus. */
  unlisted: Record<string, string[]>;
  stock: Record<string, Record<string, number>>;
  transfers: Transfer[];
  next: { trf: number };
};

/* =====================================================================
   Central catalogue
   ===================================================================== */

export type CatalogueItem = { sku: string; name: string; category: string; mrp: number; cost: number };

/** The central catalogue: every branch sells from this list. Base price = MRP (the legal maximum). */
export const catalogue: CatalogueItem[] = inventoryItems.map((i) => ({ sku: i.sku, name: i.name, category: i.category, mrp: i.price, cost: i.cost }));
export const itemBySku = (sku: string) => catalogue.find((c) => c.sku === sku);

/** Stores reorder below this; transfers top them up to TARGET_STOCK. */
export const REORDER_AT = 15;
export const TARGET_STOCK = 40;

/* =====================================================================
   Queries
   ===================================================================== */

export const branchById = (s: BranchState, id: string) => s.branches.find((b) => b.id === id);
export const currentBranch = (s: BranchState) => branchById(s, s.currentId) ?? s.branches[0]!;
export const stores = (s: BranchState) => s.branches.filter((b) => b.kind === 'store' && b.active);

export const priceAt = (s: BranchState, branchId: string, sku: string) => s.prices[branchId]?.[sku] ?? itemBySku(sku)?.mrp ?? 0;
export const hasOverride = (s: BranchState, branchId: string, sku: string) => s.prices[branchId]?.[sku] !== undefined;
export const listedAt = (s: BranchState, branchId: string, sku: string) => !(s.unlisted[branchId] ?? []).includes(sku);
export const stockAt = (s: BranchState, branchId: string, sku: string) => s.stock[branchId]?.[sku] ?? 0;
export const lowAt = (s: BranchState, branchId: string) =>
  catalogue.filter((c) => listedAt(s, branchId, c.sku) && stockAt(s, branchId, c.sku) < REORDER_AT);

/** Stock value at cost for a branch. */
export const stockValue = (s: BranchState, branchId: string) =>
  catalogue.reduce((t, c) => t + stockAt(s, branchId, c.sku) * c.cost, 0);

/**
 * A transfer between different GSTINs (e.g. a Tamil Nadu warehouse to a Karnataka store) is a
 * taxable supply: it needs a tax invoice and, above ₹50,000, an e-way bill. Within one GSTIN a
 * delivery challan is enough.
 */
export const transferDoc = (s: BranchState, t: Pick<Transfer, 'from' | 'to'>) => {
  const a = branchById(s, t.from);
  const b = branchById(s, t.to);
  const crossGstin = !!a && !!b && a.gstin !== b.gstin;
  return crossGstin
    ? { label: 'Tax invoice + e-way bill', note: 'Different GSTINs — this transfer is a taxable supply between your registrations.', crossGstin }
    : { label: 'Delivery challan', note: 'Same GSTIN — move the stock with a delivery challan.', crossGstin };
};
export const transferValue = (t: Transfer) => t.lines.reduce((s, l) => s + l.qty * (itemBySku(l.sku)?.cost ?? 0), 0);

/** Stores below reorder level that the warehouse (or a branch with plenty) can top up. */
export function transferSuggestions(s: BranchState) {
  const sources = s.branches.filter((b) => b.active);
  const out: { to: Branch; from: Branch; lines: { sku: string; qty: number }[] }[] = [];
  for (const to of stores(s)) {
    const need = lowAt(s, to.id).map((c) => ({ sku: c.sku, qty: TARGET_STOCK - stockAt(s, to.id, c.sku) }));
    if (!need.length) continue;
    // Prefer the warehouse; otherwise the branch with the most spare stock.
    const from =
      sources.find((b) => b.kind === 'warehouse' && need.some((n) => stockAt(s, b.id, n.sku) > n.qty)) ??
      sources
        .filter((b) => b.id !== to.id)
        .sort((x, y) => need.reduce((t, n) => t + stockAt(s, y.id, n.sku), 0) - need.reduce((t, n) => t + stockAt(s, x.id, n.sku), 0))[0];
    if (!from) continue;
    const spare = (sku: string) => Math.max(0, stockAt(s, from.id, sku) - (from.kind === 'warehouse' ? 0 : TARGET_STOCK));
    const lines = need.map((n) => ({ sku: n.sku, qty: Math.min(n.qty, spare(n.sku)) })).filter((l) => l.qty > 0);
    const alreadyMoving = s.transfers.some((t) => t.to === to.id && (t.status === 'requested' || t.status === 'in-transit'));
    if (lines.length && !alreadyMoving) out.push({ to, from, lines });
  }
  return out;
}

/* =====================================================================
   Branch identity on bills
   ===================================================================== */

/**
 * The business profile as printed at a branch: its own address, phone, GSTIN and invoice series.
 * The head-office branch prints the profile as-is.
 */
export function profileForBranch(p: BusinessProfile, b: Branch | undefined): BusinessProfile {
  if (!b || b.isHq) return p;
  return {
    ...p,
    displayName: p.displayName,
    address: { line1: b.address.line1, line2: '', city: b.address.city, pincode: b.address.pincode, stateCode: b.address.stateCode },
    phone: b.phone || p.phone,
    gstin: p.registration === 'unregistered' ? '' : b.gstin || p.gstin,
    invoicePrefix: b.code,
  };
}

/* =====================================================================
   Branch sales (sample)
   ===================================================================== */

export type DaySales = { date: string; label: string; revenue: number; bills: number; profit: number };

/** Small deterministic noise so each branch has its own shape. */
const wobble = (seed: number, i: number) => 1 + Math.sin(seed * 12.9898 + i * 78.233) * 0.07;

const salesShape: Record<string, { factor: number; margin: number; seed: number; mix: Record<string, number> }> = {
  'anna-nagar': { factor: 1, margin: 0.185, seed: 1, mix: { Grocery: 41, Dairy: 22, Beverages: 9, Snacks: 12, Household: 9, Bakery: 7 } },
  't-nagar': { factor: 0.84, margin: 0.178, seed: 2, mix: { Grocery: 36, Dairy: 19, Beverages: 14, Snacks: 16, Household: 8, Bakery: 7 } },
  koramangala: { factor: 0.73, margin: 0.204, seed: 3, mix: { Grocery: 28, Dairy: 24, Beverages: 15, Snacks: 18, Household: 6, Bakery: 9 } },
  andheri: { factor: 0.61, margin: 0.169, seed: 4, mix: { Grocery: 38, Dairy: 20, Beverages: 11, Snacks: 14, Household: 11, Bakery: 6 } },
};

/** Last 14 days for a store (sample data; the HQ branch matches the main dashboard). */
/** Connected mode: last 14 days per branch from the API (filled by lib/live/hydrate). */
export const liveBranchSales: Record<string, DaySales[]> = {};

export function branchSales(branchId: string): DaySales[] {
  if (apiConfigured) return liveBranchSales[branchId] ?? [];
  const shape = salesShape[branchId];
  if (!shape) return [];
  return dailySales.map((d, i) => {
    const revenue = Math.round((d.revenue * shape.factor * (branchId === 'anna-nagar' ? 1 : wobble(shape.seed, i))) / 10) * 10;
    const avg = 369 * (0.9 + shape.seed * 0.04);
    return { date: addDays(TODAY, i - (dailySales.length - 1)), label: d.label, revenue, bills: Math.round(revenue / avg), profit: Math.round(revenue * shape.margin) };
  });
}
export const branchMix = (branchId: string) => salesShape[branchId]?.mix ?? {};
export const hasSales = (branchId: string) => (apiConfigured ? !!liveBranchSales[branchId]?.length : !!salesShape[branchId]);

/* =====================================================================
   Sample chain + first-run state
   ===================================================================== */

const seedStock = (factor: number, offset: number) =>
  Object.fromEntries(
    inventoryItems.map((it, i) => [it.sku, Math.max(0, Math.round(it.stock * factor + (((i + offset) * 37) % 23) - 11))])
  );

function demo(): BranchState {
  // Same PAN, one GSTIN per state; Tamil Nadu locations share the head office registration.
  const tn = getBusinessProfile().gstin || '33ABCPS1234K1Z5';
  const branches: Branch[] = [
    {
      id: 'anna-nagar', code: 'SFM', name: 'Anna Nagar', kind: 'store', isHq: true,
      address: { line1: '12, 2nd Avenue, Anna Nagar', city: 'Chennai', pincode: '600040', stateCode: '33' },
      phone: '+91 44 2626 1234', gstin: tn, manager: 'Senthil Kumar', openedOn: '2016-04-14', active: true, monthlyTarget: 3600000,
    },
    {
      id: 't-nagar', code: 'TNG', name: 'T. Nagar', kind: 'store', isHq: false,
      address: { line1: '48, Usman Road, T. Nagar', city: 'Chennai', pincode: '600017', stateCode: '33' },
      phone: '+91 44 2434 5566', gstin: tn, manager: 'Revathi M', openedOn: '2019-08-01', active: true, monthlyTarget: 3000000,
    },
    {
      id: 'koramangala', code: 'KOR', name: 'Koramangala', kind: 'store', isHq: false,
      address: { line1: '80 Feet Road, 4th Block, Koramangala', city: 'Bengaluru', pincode: '560034', stateCode: '29' },
      phone: '+91 80 4110 2233', gstin: '29ABCPS1234K1ZI', manager: 'Naveen R', openedOn: '2021-11-20', active: true, monthlyTarget: 2600000,
    },
    {
      id: 'andheri', code: 'AND', name: 'Andheri West', kind: 'store', isHq: false,
      address: { line1: 'Lokhandwala Complex, Andheri West', city: 'Mumbai', pincode: '400053', stateCode: '27' },
      phone: '+91 22 2636 7788', gstin: '27ABCPS1234K1ZM', manager: 'Farah Shaikh', openedOn: '2023-02-10', active: true, monthlyTarget: 2300000,
    },
    {
      id: 'warehouse', code: 'WH1', name: 'Central Warehouse', kind: 'warehouse', isHq: false,
      address: { line1: 'Plot 22, SIDCO Industrial Estate, Ambattur', city: 'Chennai', pincode: '600098', stateCode: '33' },
      phone: '+91 44 2625 9900', gstin: tn, manager: 'Arun K', openedOn: '2020-06-01', active: true, monthlyTarget: 0,
    },
  ];
  const stock: BranchState['stock'] = {
    'anna-nagar': Object.fromEntries(inventoryItems.map((i) => [i.sku, i.stock])),
    't-nagar': seedStock(0.8, 3),
    koramangala: seedStock(0.6, 7),
    andheri: seedStock(0.45, 11),
    warehouse: Object.fromEntries(inventoryItems.map((i, n) => [i.sku, 180 + ((n * 53) % 140)])),
  };
  const sku = (name: string) => inventoryItems.find((i) => i.name === name)!.sku;
  return {
    version: 1,
    branches,
    currentId: 'anna-nagar',
    prices: {
      // Mumbai runs a little cheaper on staples to compete; Bengaluru lists bread and paneer at full MRP but discounts cola.
      andheri: { [sku('Gehu Gold Atta 5kg')]: 232, [sku('Toor Dal 1kg')]: 154 },
      koramangala: { [sku('Fizzo Cola 750ml')]: 38 },
    },
    unlisted: { andheri: [sku('Paneer Fresh 200g')] },
    stock,
    transfers: [
      {
        id: 'TRF-0101', from: 'warehouse', to: 'koramangala', date: addDays(TODAY, -1), status: 'in-transit', requestedBy: 'Naveen R', notes: '',
        dispatchedOn: addDays(TODAY, -1), receivedOn: null,
        lines: [{ sku: sku('Kavya Sunflower Oil 1L'), qty: 30, received: null }, { sku: sku('Toor Dal 1kg'), qty: 40, received: null }],
      },
      {
        id: 'TRF-0100', from: 'warehouse', to: 't-nagar', date: addDays(TODAY, -3), status: 'received', requestedBy: 'Revathi M', notes: '',
        dispatchedOn: addDays(TODAY, -3), receivedOn: addDays(TODAY, -2),
        lines: [{ sku: sku('Gehu Gold Atta 5kg'), qty: 50, received: 50 }, { sku: sku('Sagar Rice Ponni 10kg'), qty: 20, received: 19 }],
      },
      {
        id: 'TRF-0099', from: 'anna-nagar', to: 'andheri', date: addDays(TODAY, -6), status: 'received', requestedBy: 'Farah Shaikh', notes: 'Weekend promo stock',
        dispatchedOn: addDays(TODAY, -6), receivedOn: addDays(TODAY, -4),
        lines: [{ sku: sku('Crunchee Marie 250g'), qty: 60, received: 60 }],
      },
    ],
    next: { trf: 102 },
  };
}

/** A real store starts with one branch: the business itself, holding the current catalogue stock. */
function single(): BranchState {
  const p = getBusinessProfile();
  const hq: Branch = {
    id: 'main',
    code: p.invoicePrefix || 'HQ',
    name: p.address.city ? `${p.displayName} — ${p.address.city}` : p.displayName,
    kind: 'store',
    isHq: true,
    address: { line1: p.address.line1, city: p.address.city, pincode: p.address.pincode, stateCode: p.address.stateCode },
    phone: p.phone,
    gstin: p.gstin,
    manager: p.ownerName,
    openedOn: TODAY,
    active: true,
    monthlyTarget: 0,
  };
  return {
    version: 1,
    branches: [hq],
    currentId: hq.id,
    prices: {},
    unlisted: {},
    stock: { [hq.id]: Object.fromEntries(inventoryItems.map((i) => [i.sku, i.stock])) },
    transfers: [],
    next: { trf: 1 },
  };
}

/* =====================================================================
   Store (browser storage + live hook)
   ===================================================================== */

const KEY = 'kirana:branches';
let cache: BranchState | null = null;
const listeners = new Set<() => void>();
const serverSnapshot = demo();

function read(): BranchState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as BranchState;
      if (s.version === 1 && s.branches?.length) return s;
    }
  } catch {
    /* fall through */
  }
  return getSetup()?.mode === 'store' ? single() : demo();
}

export function getBranches(): BranchState {
  if (typeof window === 'undefined') return serverSnapshot;
  cache ??= read();
  return cache;
}

export function updateBranches(fn: (s: BranchState) => BranchState) {
  cache = fn(getBranches());
  try {
    if (!apiConfigured) window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage blocked — changes last for this session */
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

export function useBranches() {
  return useSyncExternalStore(subscribe, getBranches, () => serverSnapshot);
}

/* =====================================================================
   Actions
   ===================================================================== */

export const setCurrentBranch = (id: string) => updateBranches((s) => ({ ...s, currentId: id }));

/** Adds (positive) or removes (negative) stock at a branch; never goes below zero. */
export function adjustStock(branchId: string, deltas: Record<string, number>) {
  updateBranches((s) => {
    const cur = { ...(s.stock[branchId] ?? {}) };
    for (const [sku, d] of Object.entries(deltas)) cur[sku] = Math.max(0, Math.round(((cur[sku] ?? 0) + d) * 1000) / 1000);
    return { ...s, stock: { ...s.stock, [branchId]: cur } };
  });
}

export function setBranchPrice(branchId: string, sku: string, price: number | null) {
  updateBranches((s) => {
    const p = { ...(s.prices[branchId] ?? {}) };
    if (price === null) delete p[sku];
    else p[sku] = price;
    return { ...s, prices: { ...s.prices, [branchId]: p } };
  });
}

export function setListed(branchId: string, sku: string, listed: boolean) {
  updateBranches((s) => {
    const set = new Set(s.unlisted[branchId] ?? []);
    if (listed) set.delete(sku);
    else set.add(sku);
    return { ...s, unlisted: { ...s.unlisted, [branchId]: [...set] } };
  });
}

export function saveBranch(b: Branch) {
  updateBranches((s) => {
    const exists = s.branches.some((x) => x.id === b.id);
    return {
      ...s,
      branches: exists ? s.branches.map((x) => (x.id === b.id ? b : x)) : [...s.branches, b],
      stock: exists ? s.stock : { ...s.stock, [b.id]: {} },
    };
  });
}

export function createTransfer(t: Omit<Transfer, 'id' | 'status' | 'dispatchedOn' | 'receivedOn'>) {
  let id = '';
  updateBranches((s) => {
    id = `TRF-${String(s.next.trf).padStart(4, '0')}`;
    return { ...s, transfers: [{ ...t, id, status: 'requested', dispatchedOn: null, receivedOn: null }, ...s.transfers], next: { trf: s.next.trf + 1 } };
  });
  return id;
}

/** Dispatch takes the stock out of the source branch. Returns an error if there isn't enough. */
export function dispatchTransfer(id: string): string | null {
  const s = getBranches();
  const t = s.transfers.find((x) => x.id === id);
  if (!t || t.status !== 'requested') return 'Only requested transfers can be dispatched.';
  const short = t.lines.filter((l) => stockAt(s, t.from, l.sku) < l.qty);
  if (short.length)
    return `Not enough stock at ${branchById(s, t.from)?.name}: ${short.map((l) => `${itemBySku(l.sku)?.name} (${stockAt(s, t.from, l.sku)} of ${l.qty})`).join(', ')}`;
  updateBranches((x) => {
    const from = { ...(x.stock[t.from] ?? {}) };
    for (const l of t.lines) from[l.sku] = (from[l.sku] ?? 0) - l.qty;
    return {
      ...x,
      stock: { ...x.stock, [t.from]: from },
      transfers: x.transfers.map((o) => (o.id === id ? { ...o, status: 'in-transit', dispatchedOn: TODAY } : o)),
    };
  });
  return null;
}

/** Receiving adds what actually arrived to the destination; any shortfall is recorded on the transfer. */
export function receiveTransfer(id: string, received: Record<string, number>) {
  updateBranches((x) => {
    const t = x.transfers.find((o) => o.id === id);
    if (!t || t.status !== 'in-transit') return x;
    const to = { ...(x.stock[t.to] ?? {}) };
    for (const l of t.lines) to[l.sku] = (to[l.sku] ?? 0) + (received[l.sku] ?? l.qty);
    return {
      ...x,
      stock: { ...x.stock, [t.to]: to },
      transfers: x.transfers.map((o) =>
        o.id === id ? { ...o, status: 'received', receivedOn: TODAY, lines: o.lines.map((l) => ({ ...l, received: received[l.sku] ?? l.qty })) } : o
      ),
    };
  });
}

export function cancelTransfer(id: string) {
  updateBranches((x) => ({ ...x, transfers: x.transfers.map((o) => (o.id === id && o.status === 'requested' ? { ...o, status: 'cancelled' } : o)) }));
}

/**
 * Why a branch can't be deleted (empty = safe to delete). Deleting removes it everywhere, so it's
 * only allowed for a branch with no stock and no history — e.g. one added by mistake. A branch
 * with history should be marked Closed instead, which keeps its transfers and reports intact.
 */
export function deleteBlockers(s: BranchState, id: string): string[] {
  const b = branchById(s, id);
  if (!b) return ['Branch not found.'];
  if (b.isHq) return ['The head office can’t be deleted — it holds your business profile and main invoice series.'];
  const out: string[] = [];
  const units = Object.values(s.stock[id] ?? {}).reduce((t, n) => t + Math.max(0, n), 0);
  if (units > 0) out.push(`${units.toLocaleString('en-IN')} units (worth ₹${Math.round(stockValue(s, id)).toLocaleString('en-IN')} at cost) are still in stock — transfer them to another branch first.`);
  const mine = s.transfers.filter((t) => t.from === id || t.to === id);
  const openT = mine.filter((t) => t.status === 'requested' || t.status === 'in-transit');
  if (openT.length) out.push(`${openT.map((t) => t.id).join(', ')} ${openT.length === 1 ? 'is' : 'are'} still open — receive or cancel ${openT.length === 1 ? 'it' : 'them'} first.`);
  const past = mine.length - openT.length;
  if (past > 0 || hasSales(id))
    out.push(
      `It has ${[past > 0 ? `${past} past transfer${past === 1 ? '' : 's'}` : '', hasSales(id) ? 'sales history' : ''].filter(Boolean).join(' and ')} — mark it Closed instead so those records stay intact.`
    );
  return out;
}

/** Removes a branch with its prices, listings and (empty) stock. Returns an error if it isn't allowed. */
export function deleteBranch(id: string): string | null {
  const blockers = deleteBlockers(getBranches(), id);
  if (blockers.length) return blockers[0]!;
  updateBranches((s) => {
    const drop = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== id));
    const hq = s.branches.find((b) => b.isHq) ?? s.branches.find((b) => b.id !== id)!;
    return {
      ...s,
      branches: s.branches.filter((b) => b.id !== id),
      currentId: s.currentId === id ? hq.id : s.currentId,
      prices: drop(s.prices),
      unlisted: drop(s.unlisted),
      stock: drop(s.stock),
    };
  });
  return null;
}

export const stateName = (code: string) => gstStates[code] ?? code;
