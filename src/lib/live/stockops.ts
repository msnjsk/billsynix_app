/**
 * Connected-mode back office: expenses, stock adjustments and counts, transfers between branches,
 * and branch price lists. Thin wrappers over the API; screens reload after every change.
 */
import { api, newKey } from '@/lib/api/client';
import type { Page, Product } from '@/lib/api/types';
import { live, reload } from './hydrate';

type Query = Record<string, string | number | boolean | undefined>;
const fresh = <T,>(path: string, query: Query = {}) => api<T>('GET', path, { query });

/** Every active product the server knows, for pickers. */
export const liveProducts = (): Product[] =>
  [...live.products.values()].filter((p) => p.status === 'ACTIVE').sort((a, b) => a.name.localeCompare(b.name));

export const productById = (id: string) => [...live.products.values()].find((p) => p.id === id);

/* ---------- expenses ---------- */

export type ExpenseCategory = { id: string; name: string; isActive: boolean };
export type PayMode = 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER' | 'CHEQUE';
export type Expense = {
  id: string;
  number: string;
  storeId: string;
  category: { id: string; name: string };
  spentOn: string;
  amount: string;
  gstAmount: string;
  mode: PayMode;
  payee: string | null;
  reference: string | null;
  note: string | null;
  cashSessionId: string | null;
  status: 'RECORDED' | 'VOIDED';
  voided: { at: string; byUserId: string; reason: string } | null;
  createdAt: string;
};

export const expenseCategories = () => fresh<{ data: ExpenseCategory[] }>('/expense-categories').then((r) => r.data);
export const addExpenseCategory = (name: string) => api<ExpenseCategory>('POST', '/expense-categories', { body: { name } });
export const listExpenses = (q: { from: string; to: string; storeId?: string; categoryId?: string }) =>
  fresh<Page<Expense>>('/expenses', { pageSize: 200, ...q });

export const addExpense = (e: {
  storeId: string;
  categoryId: string;
  spentOn: string;
  amount: number;
  gstAmount: number;
  mode: PayMode;
  payee: string;
  reference: string;
  note: string;
  fromDrawer: boolean;
}) =>
  api<Expense>('POST', '/expenses', {
    idempotencyKey: newKey(),
    body: {
      storeId: e.storeId,
      categoryId: e.categoryId,
      spentOn: e.spentOn,
      amount: e.amount.toFixed(2),
      gstAmount: e.gstAmount.toFixed(2),
      mode: e.mode,
      fromDrawer: e.fromDrawer,
      ...(e.payee.trim() ? { payee: e.payee.trim() } : {}),
      ...(e.reference.trim() ? { reference: e.reference.trim() } : {}),
      ...(e.note.trim() ? { note: e.note.trim() } : {}),
    },
  });

export const voidExpense = (id: string, reason: string) => api<Expense>('POST', `/expenses/${id}/void`, { body: { reason } });

/* ---------- stock adjustments ---------- */

export type AdjustmentStatus = 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED' | 'CANCELLED';
export type Adjustment = {
  id: string;
  store: { id: string; code: string; name: string };
  reason: string;
  note: string | null;
  status: AdjustmentStatus;
  value?: string;
  items: { id: string; product: { id: string; sku: string; name: string }; batchId: string | null; qty: string; unitCost?: string }[];
  createdByUserId: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  postedAt: string | null;
  createdAt: string;
};

export const listAdjustments = (status?: AdjustmentStatus) =>
  fresh<Page<Adjustment>>('/stock-adjustments', { pageSize: 100, ...(status ? { status } : {}) });

export async function approveAdjustment(id: string) {
  await api('POST', `/stock-adjustments/${id}/approve`, { idempotencyKey: newKey() });
  await reload();
}
export const rejectAdjustment = (id: string, reason: string) => api('POST', `/stock-adjustments/${id}/reject`, { body: { reason } });
export const cancelAdjustment = (id: string) => api('POST', `/stock-adjustments/${id}/cancel`, { body: {} });

/* ---------- stock counts ---------- */

export type CountStatus = 'OPEN' | 'SUBMITTED' | 'POSTED' | 'CANCELLED';
export type CountSummary = {
  id: string;
  store: { id: string; code: string; name: string };
  name: string;
  status: CountStatus;
  lines: number;
  createdAt: string;
  postedAt: string | null;
};
export type CountLine = {
  id: string;
  product: { id: string; sku: string; name: string };
  batchId: string | null;
  batchNo: string | null;
  systemQty: string;
  countedQty: string | null;
  difference: string | null;
  countedAt: string | null;
};
export type StockCount = Omit<CountSummary, 'lines'> & {
  summary: { lines: number; counted: number; uncounted: number; differences: number; varianceValue?: string };
  items: CountLine[];
};

export const listCounts = () => fresh<Page<CountSummary>>('/stock-counts', { pageSize: 100 });
export const getCount = (id: string) => fresh<StockCount>(`/stock-counts/${id}`);
export const createCount = (storeId: string, name: string, categoryId?: string) =>
  api<StockCount>('POST', `/stores/${storeId}/stock-counts`, { body: { name, ...(categoryId ? { categoryId } : {}) } });
export const recordCount = (id: string, items: { productId: string; batchId: string | null; countedQty: number }[]) =>
  api<StockCount>('PUT', `/stock-counts/${id}/items`, {
    body: {
      items: items.map((i) => ({ productId: i.productId, ...(i.batchId ? { batchId: i.batchId } : {}), countedQty: i.countedQty.toFixed(3) })),
    },
  });
export const submitCount = (id: string) => api<StockCount>('POST', `/stock-counts/${id}/submit`, { body: {} });
export async function postCount(id: string) {
  const r = await api<StockCount>('POST', `/stock-counts/${id}/post`, { idempotencyKey: newKey() });
  await reload();
  return r;
}
export const cancelCount = (id: string) => api('POST', `/stock-counts/${id}/cancel`, { body: {} });

/* ---------- transfers ---------- */

export type TransferStatus = 'REQUESTED' | 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED';
export type Transfer = {
  id: string;
  fromStore: { id: string; code: string; name: string };
  toStore: { id: string; code: string; name: string };
  status: TransferStatus;
  crossGstin: boolean;
  note: string | null;
  items: {
    id: string;
    product: { id: string; sku: string; name: string };
    batch: { id: string; batchNo: string; expiryDate: string | null } | null;
    requestedQty: string;
    dispatchedQty: string | null;
    receivedQty: string | null;
    lostQty: string | null;
  }[];
  dispatchedValue?: string;
  dispatchedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
};

export const listTransfers = (status?: TransferStatus) =>
  fresh<Page<Transfer>>('/stock-transfers', { pageSize: 100, ...(status ? { status } : {}) });
export const createTransfer = (fromStoreId: string, toStoreId: string, items: { productId: string; qty: number }[], note: string) =>
  api<Transfer>('POST', '/stock-transfers', {
    body: { fromStoreId, toStoreId, items: items.map((i) => ({ productId: i.productId, qty: String(i.qty) })), ...(note.trim() ? { note: note.trim() } : {}) },
  });
export async function dispatchTransfer(id: string) {
  const r = await api<Transfer>('POST', `/stock-transfers/${id}/dispatch`, { idempotencyKey: newKey(), body: {} });
  await reload();
  return r;
}
export async function receiveTransfer(id: string, received?: { itemId: string; receivedQty: number }[]) {
  const r = await api<Transfer>('POST', `/stock-transfers/${id}/receive`, {
    idempotencyKey: newKey(),
    body: received ? { items: received.map((i) => ({ itemId: i.itemId, receivedQty: String(i.receivedQty) })) } : {},
  });
  await reload();
  return r;
}
export const cancelTransfer = (id: string) => api<Transfer>('POST', `/stock-transfers/${id}/cancel`, { body: {} });

/* ---------- price lists ---------- */

export type PriceList = { id: string; name: string; isActive: boolean; storeIds: string[] };
export type ListPrice = { productId: string; sku: string; name: string; sellingPrice: string; defaultPrice: string; mrp: string | null };

export const listPriceLists = () => fresh<{ data: PriceList[] }>('/price-lists').then((r) => r.data);
export const createPriceList = (name: string) => api<PriceList>('POST', '/price-lists', { body: { name } });
export const renamePriceList = (id: string, patch: { name?: string; isActive?: boolean }) => api<PriceList>('PATCH', `/price-lists/${id}`, { body: patch });
export async function pricesOf(id: string): Promise<ListPrice[]> {
  const out: ListPrice[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await fresh<Page<ListPrice>>(`/price-lists/${id}/prices`, { page, pageSize: 200 });
    out.push(...r.data);
    if (out.length >= r.meta.total || !r.data.length) break;
  }
  return out;
}
export const setPrices = (id: string, items: { productId: string; sellingPrice: number }[]) =>
  api<{ updated: number }>('PUT', `/price-lists/${id}/prices`, { body: { items: items.map((i) => ({ productId: i.productId, sellingPrice: i.sellingPrice.toFixed(2) })) } });
export const removePrice = (id: string, productId: string) => api('DELETE', `/price-lists/${id}/prices/${productId}`);
export async function assignPriceList(storeId: string, priceListId: string | null) {
  await api('PUT', `/stores/${storeId}/price-list`, { body: { priceListId } });
  await reload();
}

/* ---------- labels ---------- */

export const ADJUSTMENT_REASON_LABEL: Record<string, string> = {
  OPENING: 'Opening stock',
  DAMAGE: 'Damaged',
  EXPIRY: 'Expired',
  WASTAGE: 'Wastage',
  THEFT: 'Theft / missing',
  FOUND: 'Found',
  COUNT_CORRECTION: 'Stock count correction',
  OTHER: 'Other',
};

export const PAY_MODE_LABEL: Record<PayMode, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK_TRANSFER: 'Bank transfer', CHEQUE: 'Cheque' };

export const qtyFmt = (v: string | number | null | undefined) => Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
