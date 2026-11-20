/**
 * End of shift and end of day (connected mode): the cashier's drawer, cancelling a bill, and the
 * manager's queue — drawers to sign off, UPI/card payments to verify, offline bills that failed.
 */
import { api, newKey } from '@/lib/api/client';

type Query = Record<string, string | number | undefined>;
const fresh = <T,>(path: string, query: Query = {}) => api<T>('GET', path, { query });
import type { Page } from '@/lib/api/types';
import { reload } from './hydrate';

/* ---------- drawers ---------- */

export type Drawer = {
  id: string;
  storeId: string;
  counterId: string;
  counter: { name: string; number: number } | null;
  userId: string;
  cashier: string | null;
  status: 'OPEN' | 'PENDING_REVIEW' | 'CLOSED';
  openedAt: string;
  closedAt: string | null;
  openingFloat: string;
  cashSales: string;
  cashRefunds: string;
  payIn: string;
  payOut: string;
  expectedCash: string | null;
  upi: { settled: string; pending: string };
  card: { settled: string; pending: string };
  failed: string;
  sales: { count: number; total: string; voided: number };
  refunds: { count: number; total: string };
  countedCash: string | null;
  variance: string | null;
  denominations: Record<string, number> | null;
  closingNote: string | null;
  review: { byUserId: string | null; by: string | null; at: string; note: string | null } | null;
  movements: { id: string; type: 'PAY_IN' | 'PAY_OUT'; amount: string; reason: string; createdAt: string }[];
};

/** Your open drawer, or null when none is open. */
export async function myDrawer(): Promise<Drawer | null> {
  try {
    return await api<Drawer>('GET', '/cash-sessions/current');
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

export const cashMovement = (id: string, type: 'PAY_IN' | 'PAY_OUT', amount: number, reason: string) =>
  api<{ id: string }>('POST', `/cash-sessions/${id}/movements`, { body: { type, amount: amount.toFixed(2), reason } });

export async function closeDrawer(id: string, countedCash: number, denominations: Record<string, number>, note: string) {
  const notes = Object.fromEntries(Object.entries(denominations).filter(([, n]) => n > 0));
  const r = await api<Drawer>('POST', `/cash-sessions/${id}/close`, {
    body: {
      countedCash: countedCash.toFixed(2),
      ...(Object.keys(notes).length ? { denominations: notes } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    },
  });
  await reload();
  return r;
}

export const listDrawers = (q: { status?: Drawer['status']; date?: string; storeId?: string }) =>
  fresh<Page<Drawer>>('/cash-sessions', { pageSize: 100, ...q });

export const reviewDrawer = (id: string, note: string) => api<Drawer>('POST', `/cash-sessions/${id}/review`, { body: { note } });

/* ---------- cancelling a bill ---------- */

export type Approver = { userId: string; name: string };

export const approvers = (storeId: string) =>
  fresh<{ data: Approver[] }>('/sales/approvers', { permission: 'sales:void', storeId }).then((r) => r.data);

export async function voidSale(saleId: string, reason: string, approval?: { userId: string; pin: string }) {
  const r = await api<{ invoiceNo: string; status: string }>('POST', `/sales/${saleId}/void`, {
    body: { reason, ...(approval ? { approval } : {}) },
  });
  await reload();
  return r;
}

/* ---------- payments to verify ---------- */

export type PendingPayment = {
  id: string;
  saleId: string;
  invoiceNo: string;
  storeId: string;
  method: 'UPI' | 'CARD';
  amount: string;
  reference: string | null;
  createdAt: string;
};

export const pendingPayments = () => fresh<{ data: PendingPayment[] }>('/sales/pending-payments').then((r) => r.data);

export const decidePayment = (id: string, ok: boolean, reference: string, note: string) =>
  api('POST', `/sale-payments/${id}/${ok ? 'confirm' : 'fail'}`, {
    body: { ...(reference.trim() ? { reference: reference.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
  });

/* ---------- offline sync issues ---------- */

export type SyncIssue = {
  id: string;
  type: string;
  status: 'ACCEPTED' | 'FAILED' | 'DISCARDED';
  needsReview: boolean;
  device: { id: string; name: string | null };
  storeId: string;
  counterId: string;
  cashier: { id: string; name: string | null };
  occurredAt: string;
  receivedAt: string;
  invoiceNo: string | null;
  printedInvoiceNo: string | null;
  payable: string | null;
  openingFloat: string | null;
  saleId: string | null;
  warnings: { code: string; message: string }[];
  error: { code: string; message: string | null } | null;
  attempts: number;
  review: { at: string; by: { id: string | null; name: string | null }; note: string | null } | null;
};

export const syncIssues = (storeId?: string) =>
  fresh<Page<SyncIssue>>('/sync/issues', { pageSize: 100, ...(storeId ? { storeId } : {}) });

export const retryIssue = (id: string, renumber: boolean, note: string) =>
  api<SyncIssue>('POST', `/sync/events/${id}/retry`, { idempotencyKey: newKey(), body: { renumber, ...(note.trim() ? { note: note.trim() } : {}) } });

export const discardIssue = (id: string, note: string) => api<SyncIssue>('POST', `/sync/events/${id}/discard`, { body: { note } });

export const acknowledgeIssue = (id: string, note: string) =>
  api<SyncIssue>('POST', `/sync/events/${id}/acknowledge`, { body: note.trim() ? { note: note.trim() } : {} });

/* ---------- formatting ---------- */

export const rupees = (v: string | number | null | undefined) =>
  `₹${Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Indian notes and coins counted at the drawer. */
export const DENOMINATIONS = ['500', '200', '100', '50', '20', '10', '5', '2', '1'] as const;
