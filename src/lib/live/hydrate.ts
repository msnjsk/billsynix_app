/**
 * Loads the business from the API into the stores the screens already read (business profile,
 * branches & stock, catalogue, suppliers, purchase documents), so the existing UI works on real
 * data without being rewritten. Runs after sign-in and again after each change (`reload`).
 * The server is the source of truth. Only on a registered counter device are the answers kept
 * (src/lib/offline) so it can open and bill without a connection.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, get } from '@/lib/api/client';
import type {
  Category,
  Counter,
  GoodsReceipt,
  Movement as ApiMovement,
  Page,
  Product,
  PurchaseOrder,
  PurchaseReturn,
  SalesSummary,
  StockRow,
  Store,
  Supplier as ApiSupplier,
  SupplierPayment,
  TaxRate,
  Tenant,
  Unit,
} from '@/lib/api/types';
import { num } from '@/lib/api/types';
import { businessTypes, getBusinessProfile, presetModules, saveBusinessProfile, type BusinessType, type Registration } from '@/lib/business-profile';
import { catalogue, getBranches, updateBranches, type Branch } from '@/lib/branch-data';
import { initialMovements, inventoryItems, productCategories, supplierNames, type InventoryItem } from '@/lib/inventory-data';
import { posCatalog, type GstRate, type PosItem } from '@/lib/pos/catalog';
import { initialBatches } from '@/lib/pos/expiry';
import { categoryTone, products as baseProducts } from '@/lib/store-data';
import { suppliers as purchaseSuppliers, updatePurchases, type Grn, type Line, type PurchaseState } from '@/lib/purchase-data';
import { addDays, TODAY, type Supplier } from '@/lib/suppliers-data';
import { can, currentMe, registerLoader } from './session';
import { loadDashboard, loadTodaysBills } from './dashboard';
import { syncShopLogo } from '@/lib/shop-logo';

/** Ids the write-through actions need (the UI keys products by SKU). */
export const live = {
  tenant: null as Tenant | null,
  stores: [] as Store[],
  counters: [] as Counter[],
  products: new Map<string, Product>(), // by SKU
  taxRates: [] as TaxRate[],
  units: [] as Unit[],
  categories: [] as Category[],
  suppliers: [] as ApiSupplier[],
  grns: [] as GoodsReceipt[],
  pos: [] as PurchaseOrder[],
  summary: null as SalesSummary | null,
  previousSummary: null as SalesSummary | null,
};

const replace = <T>(target: T[], items: T[]) => {
  target.splice(0, target.length, ...items);
};

async function all<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await get<Page<T>>(path, { ...query, page, pageSize: 200 });
    out.push(...r.data);
    if (out.length >= r.meta.total || !r.data.length) break;
  }
  return out;
}

const businessTypeOf = (t: string): BusinessType => (t in businessTypes ? t : 'supermarket') as BusinessType;

const regOf = (r: Tenant['registration']): Registration => (r === 'REGULAR' ? 'regular' : r === 'COMPOSITION' ? 'composition' : 'unregistered');

const TONES = ['amber', 'sky', 'cyan', 'lime', 'vio'];
const gst = (rate: number): GstRate => ([0, 5, 12, 18, 28, 40].includes(rate) ? rate : 18) as GstRate;

/** Top-level department of a product ("Staples" for Staples > Rice). */
const departmentOf = (p: Product, cats: Map<string, Category>) => (p.category ? (cats.get(p.category.id)?.path[0] ?? p.category.name) : 'Other');

export const currentStoreId = () => getBranches().currentId;

async function loadBusiness() {
  const t = await get<Tenant>('/tenants/current');
  live.tenant = t;
  const cur = getBusinessProfile();
  const type = businessTypeOf(t.businessType);
  saveBusinessProfile({
    ...cur,
    businessType: type,
    displayName: t.displayName,
    legalName: t.legalName ?? '',
    ownerName: currentMe()?.user.name ?? cur.ownerName,
    phone: t.phone ?? '',
    email: t.email ?? '',
    address: { line1: t.address.line1 ?? '', line2: t.address.line2 ?? '', city: t.address.city ?? '', pincode: t.address.pincode ?? '', stateCode: t.stateCode },
    registration: regOf(t.registration),
    gstin: t.gstin ?? '',
    modules: presetModules[type],
  });
  // The shop logo: fetched only when it changed on the server (a copy is kept on this computer).
  void syncShopLogo(t);
}

async function loadBranches() {
  const stores = await all<Store>('/stores');
  live.stores = stores;
  const counters: Counter[] = [];
  for (const s of stores.filter((x) => x.kind === 'STORE' && x.status === 'ACTIVE'))
    counters.push(...(await get<{ data: Counter[] }>(`/stores/${s.id}/counters`)).data);
  live.counters = counters;
  const device = currentMe()?.session.device;
  const prev = getBranches().currentId;
  const currentId = device?.storeId ?? (stores.some((s) => s.id === prev) ? prev : (stores.find((s) => s.isHq) ?? stores[0])?.id ?? '');
  const branches: Branch[] = stores.map((s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    kind: s.kind === 'WAREHOUSE' ? 'warehouse' : 'store',
    isHq: s.isHq,
    address: { line1: s.address.line1, city: s.address.city, pincode: s.address.pincode, stateCode: s.address.stateCode },
    phone: s.phone ?? '',
    gstin: s.gstin ?? '',
    manager: s.managerName ?? '',
    openedOn: s.openedOn ?? '',
    active: s.status === 'ACTIVE',
    monthlyTarget: num(s.monthlyTarget),
  }));
  updateBranches((b) => ({ ...b, version: 1, branches, currentId, prices: {}, unlisted: {}, stock: b.stock ?? {}, transfers: [], next: b.next ?? { trf: 1 } }));
}

async function loadCatalogue() {
  const storeId = currentStoreId();
  const [prods, cats, taxes, units] = [
    await all<Product>('/products', { status: 'ACTIVE', ...(storeId ? { storeId } : {}) }),
    (await get<{ data: Category[] }>('/categories')).data,
    (await get<{ data: TaxRate[] }>('/tax-rates')).data,
    (await get<{ data: Unit[] }>('/units')).data,
  ];
  live.products = new Map(prods.map((p) => [p.sku, p]));
  live.categories = cats;
  live.taxRates = taxes;
  live.units = units;
  const catById = new Map(cats.map((c) => [c.id, c]));
  // Every active top-level category (even with no products yet), plus whatever products still use.
  const departments = [
    ...new Set([...cats.filter((c) => !c.parentId && c.isActive).map((c) => c.name), ...prods.map((p) => departmentOf(p, catById))]),
  ].sort((a, b) => a.localeCompare(b));
  departments.forEach((d, i) => {
    categoryTone[d] ??= TONES[i % TONES.length]!;
  });
  replace(productCategories, departments);

  // Stock per branch the caller can see.
  const stock: Record<string, Record<string, number>> = {};
  if (can('inventory:read'))
    for (const s of live.stores.filter((x) => x.status === 'ACTIVE')) {
      const rows = await all<StockRow>(`/stores/${s.id}/stock`);
      stock[s.id] = Object.fromEntries(rows.map((r) => [r.product.sku, num(r.qty)]));
    }
  updateBranches((b) => ({ ...b, stock }));

  // Units sold over the last 14 days (and the 14 before, for the trend), all branches.
  const units14 = new Map<string, number>();
  const unitsPrev = new Map<string, number>();
  if (can('reports:sales')) {
    const from = addDays(TODAY, -13);
    live.summary = await get<SalesSummary>('/reports/sales-summary', { from, to: TODAY });
    live.previousSummary = await get<SalesSummary>('/reports/sales-summary', { from: addDays(TODAY, -27), to: addDays(TODAY, -14) });
    for (const r of live.summary.byProduct) units14.set(r.sku, num(r.units));
    for (const r of live.previousSummary.byProduct) unitsPrev.set(r.sku, num(r.units));
  }

  const here = stock[storeId] ?? {};
  const items: InventoryItem[] = prods.map((p) => {
    const units = units14.get(p.sku) ?? 0;
    const before = unitsPrev.get(p.sku) ?? 0;
    return {
      sku: p.sku,
      name: p.name,
      category: departmentOf(p, catById),
      price: num(p.storePrice?.sellingPrice ?? p.sellingPrice),
      cost: num(p.purchaseCost),
      units: Math.round(units),
      stock: here[p.sku] ?? 0,
      trend: before > 0 ? Math.round(((units - before) / before) * 100) : 0,
      supplier: '',
    };
  });
  replace(inventoryItems, items);
  // The Branches screens (stock value, low stock, suggested transfers) read the central catalogue.
  replace(
    catalogue,
    items.map((i) => ({ sku: i.sku, name: i.name, category: i.category, mrp: i.price, cost: i.cost }))
  );
  replace(baseProducts, items);
  const pos: PosItem[] = prods.map((p, i) => ({
    sku: p.sku,
    name: p.name,
    category: items[i]!.category,
    price: items[i]!.price,
    stock: items[i]!.stock,
    units: items[i]!.units,
    barcode: p.barcodes.find((b) => b.isPrimary)?.code ?? p.barcodes[0]?.code ?? p.sku,
    hsn: p.hsnCode ?? '',
    gst: gst(p.taxRate.kind === 'TAXABLE' ? p.taxRate.rate : 0),
  }));
  replace(posCatalog, pos);
  // Near-expiry markdown batches come from the stock ledger later; none of the sample ones apply.
  replace(initialBatches, []);
}

const PO_STATUS = {
  DRAFT: 'draft',
  PENDING_APPROVAL: 'draft',
  SENT: 'sent',
  PARTIAL: 'partial',
  RECEIVED: 'received',
  CLOSED: 'received',
  CANCELLED: 'cancelled',
} as const;
const REASON = {
  DAMAGED: 'Damaged',
  EXPIRED: 'Expired',
  SHORT_EXPIRY: 'Short expiry',
  WRONG_ITEM: 'Wrong item',
  EXCESS: 'Excess supply',
  QUALITY: 'Quality issue',
} as const;
const MODE = { BANK_TRANSFER: 'Bank transfer', UPI: 'UPI', CHEQUE: 'Cheque', CASH: 'Cash' } as const;

const lineOf = (x: { product: { sku: string; name: string }; qty: string; rate: string; discountPct: number; gstRate: number }): Line => ({
  sku: x.product.sku,
  name: x.product.name,
  hsn: live.products.get(x.product.sku)?.hsnCode ?? '',
  gst: gst(x.gstRate),
  qty: num(x.qty),
  rate: num(x.rate),
  discountPct: x.discountPct,
});

async function loadPurchasing() {
  const buyer = can('purchases:write');
  const payer = can('supplier-payments:write') || can('reports:finance');
  if (!buyer && !payer && !can('suppliers:manage')) return;
  const sups = await all<ApiSupplier>('/suppliers', { status: 'ALL' });
  live.suppliers = sups;
  const [pos, grns, returns, payments] = [
    buyer ? await all<PurchaseOrder>('/purchase-orders') : [],
    buyer ? await all<GoodsReceipt>('/goods-receipts') : [],
    buyer ? await all<PurchaseReturn>('/purchase-returns') : [],
    can('supplier-payments:write') ? await all<SupplierPayment>('/supplier-payments') : [],
  ];

  live.grns = grns;
  live.pos = pos;
  // Which supplier last delivered each product (the UI shows one per product).
  const lastSupplier = new Map<string, string>();
  for (const g of [...grns].reverse()) for (const i of g.items) lastSupplier.set(i.product.sku, g.supplier.name);
  for (const it of inventoryItems) it.supplier = lastSupplier.get(it.sku) ?? '';
  replace(supplierNames, sups.filter((s) => s.status === 'ACTIVE').map((s) => s.name));

  const owed = (id: string) =>
    grns.filter((g) => g.supplier.id === id && num(g.outstanding) > 0).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]?.dueDate ?? null;
  const uiSuppliers: Supplier[] = sups.map((s) => ({
    id: s.id,
    name: s.name,
    contact: s.contactName ?? '',
    phone: s.phone ?? '',
    email: s.email ?? '',
    gstin: s.gstin ?? '',
    supplies: s.supplies ?? '',
    creditDays: s.creditDays,
    since: Number(s.createdAt.slice(0, 4)),
    onTime: 100,
    lastDelivery: grns.find((g) => g.supplier.id === s.id)?.receivedDate ?? null,
    due: num(s.balance),
    dueDate: owed(s.id),
    payments: payments
      .filter((p) => p.supplier.id === s.id && p.direction === 'OUT')
      .map((p) => ({ date: p.paidOn, amount: num(p.amount), method: MODE[p.mode], ref: p.reference ?? p.number })),
  }));
  replace(purchaseSuppliers, uiSuppliers);

  const grnUi: Grn[] = grns.map((g) => ({
    id: g.id,
    supplierId: g.supplier.id,
    poId: g.po?.id ?? null,
    date: g.receivedDate,
    receivedBy: '',
    supplierChallan: g.supplierInvoiceNo ?? '',
    lines: g.items.map((i) => ({
      sku: i.product.sku,
      name: i.product.name,
      ordered: i.orderedQty === null ? null : num(i.orderedQty),
      received: num(i.receivedQty),
      rejected: num(i.damagedQty),
      rejectReason: num(i.damagedQty) ? 'Damaged' : '',
      batch: i.batch?.batchNo ?? '',
      expiry: i.batch?.expiryDate ?? '',
      rate: num(i.rate),
    })),
    notes: g.notes ?? '',
  }));

  const state: PurchaseState = {
    version: 1,
    pos: pos.map((p) => ({
      id: p.id,
      supplierId: p.supplier.id,
      date: p.orderDate,
      expected: p.expectedDate ?? p.orderDate,
      status: PO_STATUS[p.status],
      lines: p.items.map(lineOf),
      notes: p.notes ?? '',
    })),
    grns: grnUi,
    // A receipt carries the supplier's invoice, so each receipt is also its bill.
    bills: grns.map((g) => ({
      id: g.id,
      supplierId: g.supplier.id,
      number: g.supplierInvoiceNo ?? g.number,
      date: g.supplierInvoiceDate ?? g.receivedDate,
      dueDate: g.dueDate,
      poId: g.po?.id ?? null,
      grnIds: [g.id],
      lines: g.items.map((i) => lineOf({ product: i.product, qty: i.receivedQty, rate: i.rate, discountPct: i.discountPct, gstRate: i.gstRate })),
      gstApplies: g.gstApplies,
      interState: g.interState,
    })),
    returns: returns.map((r) => ({
      id: r.id,
      supplierId: r.supplier.id,
      billId: r.grn?.id ?? null,
      grnId: r.grn?.id ?? null,
      date: r.returnDate,
      lines: r.items.map((i) => ({ ...lineOf(i), reason: REASON[r.reason as keyof typeof REASON] ?? 'Quality issue' })),
      status: 'settled',
      settlement: 'adjust',
      gstApplies: r.gstApplies,
      interState: r.interState,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      supplierId: p.supplier.id,
      date: p.paidOn,
      amount: num(p.amount),
      mode: MODE[p.mode],
      ref: p.reference ?? '',
      allocations: p.allocations.map((a) => ({ billId: a.grnId, amount: num(a.amount) })),
      notes: p.notes ?? '',
    })),
    priceSeed: [],
    next: { po: pos.length + 1, grn: grns.length + 1, bill: grns.length + 1, ret: returns.length + 1, pay: payments.length + 1 },
  };
  updatePurchases(() => state);
}

/* ---------- data version (screens that copy data into local state re-read it on change) ---------- */

let version = 0;
const versionListeners = new Set<() => void>();
export function useLiveVersion() {
  return useSyncExternalStore(
    (l) => {
      versionListeners.add(l);
      return () => versionListeners.delete(l);
    },
    () => version,
    () => 0,
  );
}

/**
 * A registered counter that can't reach the server still opens (Phase 9): the business, branches
 * and catalogue come from its read cache; anything else it has no copy of is skipped, not fatal.
 */
async function optional(load: () => Promise<void>) {
  try {
    await load();
  } catch (e) {
    if (!(e instanceof ApiError) || (e.code !== 'NETWORK' && e.status < 500)) throw e;
  }
}

export async function loadAll() {
  await loadBusiness();
  await loadBranches();
  await loadCatalogue();
  await optional(loadPurchasing);
  await optional(loadMovements);
  const branch = getBranches();
  await optional(() =>
    loadDashboard(
      branch.branches.map((b) => ({ id: b.id, active: b.active, kind: b.kind })),
      branch.currentId,
      new Map(inventoryItems.map((i) => [i.sku, i.category])),
    ),
  );
  await optional(() => loadTodaysBills(branch.currentId));
  version++;
  versionListeners.forEach((l) => l());
}

/** Latest stock movements of the current branch, for the inventory screen's activity list. */
async function loadMovements() {
  if (!can('inventory:read')) return;
  const storeId = currentStoreId();
  if (!storeId) return;
  const r = await get<{ data: ApiMovement[] }>(`/stores/${storeId}/stock-movements`, { limit: 8 });
  const nameOf = new Map([...live.products.values()].map((p) => [p.id, p.name]));
  replace(
    initialMovements,
    r.data.map((m) => ({
      id: Number(m.seq),
      product: nameOf.get(m.productId) ?? m.productId,
      qty: Math.round(num(m.qty)),
      reason: m.reason ? m.reason.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : m.type.toLowerCase().replace(/_/g, ' '),
      time: new Date(m.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }),
    })),
  );
}

/** After a change: fetch again (cheap at shop scale; keeps every screen consistent with the server). */
export const reload = loadAll;

registerLoader(loadAll);
