/**
 * What the screens do, sent to the API (connected mode). Each action calls the backend — which
 * checks permissions and business rules — and then reloads the stores so every screen shows the
 * server's result. Errors are thrown as `ApiError`; show them with `errorMessage()`.
 */
import { api, ApiError, isReachable, newKey } from '@/lib/api/client';
import { kvSet, posDb } from '../offline/db';
import { offlineActive, syncNow } from '../offline/engine';
import { getSyncStatus, refreshCounts } from '../offline/outbox';
import { billOffline } from '../offline/sale';
import type { Category, Product } from '@/lib/api/types';
import { num } from '@/lib/api/types';
import type { InventoryItem } from '@/lib/inventory-data';
import { currentStoreId, live, reload } from './hydrate';
import { can, currentMe } from './session';
import { askCloseOtherDrawer, askOpeningFloat } from './ask';

export type ActionResult = { message: string | null };

const pcs = () => live.units.find((u) => u.code === 'PCS')?.id ?? live.units[0]?.id ?? '';
const defaultTax = () => live.taxRates.find((t) => t.name === 'GST 5%')?.id ?? live.taxRates[0]?.id ?? '';
const productOf = (sku: string) => {
  const p = live.products.get(sku);
  if (!p) throw new Error('This product is no longer in the catalogue — reload the page.');
  return p;
};

/** The top-level category with this name, created if the business doesn't have it yet. */
async function departmentId(name: string): Promise<string | undefined> {
  if (!name || name === 'Other') return undefined;
  const found = live.categories.find((c) => !c.parentId && c.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  const c = await api<Category>('POST', '/categories', { body: { name } });
  live.categories.push(c);
  return c.id;
}

const skuFor = (category: string) =>
  `${(category.replace(/[^A-Za-z]/g, '').slice(0, 2) || 'GN').toUpperCase()}-${Date.now().toString(36).toUpperCase().slice(-6)}`;

type AdjustmentReason = 'OPENING' | 'DAMAGE' | 'EXPIRY' | 'WASTAGE' | 'THEFT' | 'FOUND' | 'COUNT_CORRECTION' | 'OTHER';

async function adjust(reason: AdjustmentReason, items: { productId: string; qty: number; unitCost?: number }[], note?: string) {
  const r = await api<{ status: string }>('POST', `/stores/${currentStoreId()}/stock-adjustments`, {
    idempotencyKey: newKey(),
    body: {
      reason,
      ...(note ? { note } : {}),
      items: items.map((i) => ({ productId: i.productId, qty: String(i.qty), ...(i.unitCost !== undefined ? { unitCost: i.unitCost.toFixed(2) } : {}) })),
    },
  });
  return r.status === 'PENDING_APPROVAL' ? 'The stock change is waiting for a manager to approve it.' : null;
}

/* ---------- products ---------- */

export type ProductInput = { name: string; category: string; supplier: string; price: number; cost: number; stock: number; taxRateId?: string | undefined };

export async function saveProduct(v: ProductInput, existing: InventoryItem | null): Promise<ActionResult> {
  const categoryId = await departmentId(v.category);
  let product: Product;
  let message: string | null = null;
  if (!existing) {
    product = await api<Product>('POST', '/products', {
      body: {
        sku: skuFor(v.category),
        name: v.name,
        ...(categoryId ? { categoryId } : {}),
        unitId: pcs(),
        taxRateId: v.taxRateId ?? defaultTax(),
        sellingPrice: v.price.toFixed(2),
        purchaseCost: v.cost.toFixed(2),
      },
    });
    if (v.stock > 0) message = await adjust('OPENING', [{ productId: product.id, qty: v.stock, unitCost: v.cost }]);
  } else {
    const cur = productOf(existing.sku);
    product = await api<Product>('PATCH', `/products/${cur.id}`, {
      body: {
        name: v.name,
        categoryId: categoryId ?? null,
        sellingPrice: v.price.toFixed(2),
        purchaseCost: v.cost.toFixed(2),
        ...(v.taxRateId ? { taxRateId: v.taxRateId } : {}),
        version: cur.version,
      },
    });
    const delta = v.stock - existing.stock;
    if (delta !== 0) message = await adjust('COUNT_CORRECTION', [{ productId: product.id, qty: delta }], 'Edited on the products screen');
  }
  const supplier = live.suppliers.find((s) => s.name === v.supplier);
  if (supplier)
    await api('PUT', `/suppliers/${supplier.id}/products`, { body: { items: [{ productId: product.id, cost: v.cost.toFixed(2) }] } }).catch(() => undefined);
  await reload();
  return { message };
}

/** Products are archived, never deleted: their sales and stock history stay. */
export async function archiveProduct(item: InventoryItem): Promise<ActionResult> {
  await api('POST', `/products/${productOf(item.sku).id}/archive`);
  await reload();
  return { message: null };
}

/* ---------- stock ---------- */

const REASONS: Record<string, AdjustmentReason> = {
  Purchase: 'FOUND',
  'Customer return': 'FOUND',
  'Count correction': 'COUNT_CORRECTION',
  Damaged: 'DAMAGE',
  Expired: 'EXPIRY',
};

export async function changeStock(sku: string, qty: number, reason: string): Promise<ActionResult> {
  const p = productOf(sku);
  const message = await adjust(REASONS[reason] ?? 'OTHER', [{ productId: p.id, qty }], reason);
  await reload();
  return { message };
}

export const taxOptions = () => live.taxRates.filter((t) => t.isActive).map((t) => ({ id: t.id, label: t.name }));
export const taxIdOf = (sku: string) => live.products.get(sku)?.taxRate.id;
export const priceOf = (sku: string) => num(live.products.get(sku)?.sellingPrice);

/* ---------- purchasing ---------- */

type UiLine = { sku: string; qty: number; rate: number; discountPct: number; gst: number };
type UiPo = { supplierId: string; date: string; expected: string; status: string; lines: UiLine[]; notes: string };
type UiGrn = {
  supplierId: string;
  poId: string | null;
  date: string;
  supplierChallan: string;
  lines: { sku: string; received: number; rejected: number; rejectReason: string; batch: string; expiry: string; rate: number }[];
  notes: string;
};
type UiReturn = { supplierId: string; billId: string | null; grnId: string | null; date: string; lines: (UiLine & { reason: string })[] };
type UiPayment = { supplierId: string; date: string; amount: number; mode: string; ref: string; allocations: { billId: string; amount: number }[]; notes: string };

const RETURN_REASON: Record<string, string> = {
  Damaged: 'DAMAGED',
  Expired: 'EXPIRED',
  'Short expiry': 'SHORT_EXPIRY',
  'Wrong item': 'WRONG_ITEM',
  'Excess supply': 'EXCESS',
  'Quality issue': 'QUALITY',
};
const PAY_MODE: Record<string, string> = { 'Bank transfer': 'BANK_TRANSFER', UPI: 'UPI', Cheque: 'CHEQUE', Cash: 'CASH' };

const poItems = (lines: UiLine[]) =>
  lines.map((l) => ({ productId: productOf(l.sku).id, qty: String(l.qty), rate: l.rate.toFixed(2), discountPct: l.discountPct, gstRate: l.gst }));

/** Creates a PO; "sent" also submits it (which may wait for approval above the limit). */
export async function createPurchaseOrder(po: UiPo): Promise<{ number: string; message: string | null }> {
  const created = await api<{ id: string; number: string }>('POST', '/purchase-orders', {
    body: { supplierId: po.supplierId, storeId: currentStoreId(), ...(po.expected ? { expectedDate: po.expected } : {}), ...(po.notes ? { notes: po.notes } : {}), items: poItems(po.lines) },
  });
  let message: string | null = null;
  if (po.status !== 'draft') {
    const sent = await api<{ status: string }>('POST', `/purchase-orders/${created.id}/submit`);
    if (sent.status === 'PENDING_APPROVAL') message = `${created.number} is waiting for approval (above the purchase limit).`;
  }
  await reload();
  return { number: created.number, message };
}

export async function updatePurchaseOrder(id: string, po: UiPo) {
  await api('PATCH', `/purchase-orders/${id}`, { body: { expectedDate: po.expected || null, notes: po.notes || null, items: poItems(po.lines) } });
  await reload();
}

export async function sendPurchaseOrder(id: string): Promise<ActionResult> {
  const r = await api<{ status: string; number: string }>('POST', `/purchase-orders/${id}/submit`);
  await reload();
  return { message: r.status === 'PENDING_APPROVAL' ? `${r.number} is waiting for approval (above the purchase limit).` : null };
}

export async function cancelPurchaseOrder(id: string) {
  await api('POST', `/purchase-orders/${id}/cancel`);
  await reload();
}

/** Receives goods with the supplier's invoice: stock in + payable, in one go on the server. */
export async function receiveGoods(grn: UiGrn, returnRejected: boolean): Promise<{ number: string; issues: number }> {
  const po = grn.poId ? live.pos.find((p) => p.id === grn.poId) : undefined;
  const created = await api<{ id: string; number: string; matchIssues: unknown[]; items: { id: string; product: { sku: string }; damagedQty: string; rate: string; discountPct: number; gstRate: number }[] }>(
    'POST',
    '/goods-receipts',
    {
      idempotencyKey: newKey(),
      body: {
        supplierId: grn.supplierId,
        storeId: po?.store.id ?? currentStoreId(),
        ...(grn.poId ? { poId: grn.poId } : {}),
        receivedDate: grn.date,
        ...(grn.supplierChallan ? { supplierInvoiceNo: grn.supplierChallan } : {}),
        ...(grn.notes ? { notes: grn.notes } : {}),
        items: grn.lines
          .filter((l) => l.received > 0)
          .map((l) => ({
            productId: productOf(l.sku).id,
            receivedQty: String(l.received),
            damagedQty: String(l.rejected),
            rate: l.rate.toFixed(2),
            ...(l.batch ? { batchNo: l.batch } : {}),
            ...(l.expiry ? { expiryDate: l.expiry } : {}),
          })),
      },
    },
  );
  const damaged = created.items.filter((i) => num(i.damagedQty) > 0);
  if (returnRejected && damaged.length) {
    const reason = grn.lines.find((l) => l.rejected > 0)?.rejectReason ?? 'Damaged';
    await api('POST', '/purchase-returns', {
      idempotencyKey: newKey(),
      body: {
        supplierId: grn.supplierId,
        storeId: po?.store.id ?? currentStoreId(),
        grnId: created.id,
        reason: RETURN_REASON[reason] ?? 'DAMAGED',
        items: damaged.map((i) => ({ productId: productOf(i.product.sku).id, qty: i.damagedQty, grnItemId: i.id, fromDamaged: true })),
      },
    });
  }
  await reload();
  return { number: created.number, issues: created.matchIssues.length };
}

export async function createPurchaseReturn(r: UiReturn): Promise<{ number: string }> {
  const grn = live.grns.find((g) => g.id === (r.grnId ?? r.billId));
  const created = await api<{ number: string }>('POST', '/purchase-returns', {
    idempotencyKey: newKey(),
    body: {
      supplierId: r.supplierId,
      storeId: grn?.store.id ?? currentStoreId(),
      ...(grn ? { grnId: grn.id } : {}),
      reason: RETURN_REASON[r.lines[0]?.reason ?? ''] ?? 'QUALITY',
      items: r.lines.map((l) => {
        const gi = grn?.items.find((i) => i.product.sku === l.sku);
        return { productId: productOf(l.sku).id, qty: String(l.qty), ...(gi ? { grnItemId: gi.id } : { rate: l.rate.toFixed(2), discountPct: l.discountPct, gstRate: l.gst }) };
      }),
    },
  });
  await reload();
  return created;
}

export async function recordSupplierPayment(p: UiPayment): Promise<{ number: string }> {
  const created = await api<{ number: string }>('POST', '/supplier-payments', {
    idempotencyKey: newKey(),
    body: {
      supplierId: p.supplierId,
      amount: p.amount.toFixed(2),
      mode: PAY_MODE[p.mode] ?? 'BANK_TRANSFER',
      ...(p.ref ? { reference: p.ref } : {}),
      paidOn: p.date,
      ...(p.notes ? { notes: p.notes } : {}),
      ...(p.allocations.length ? { allocations: p.allocations.filter((a) => a.amount > 0).map((a) => ({ grnId: a.billId, amount: a.amount.toFixed(2) })) } : {}),
    },
  });
  await reload();
  return created;
}

/* ---------- POS ---------- */

type PosLine = { key: string; sku: string | null; name: string; price: number; qty: number; discount: { kind: 'pct' | 'amt'; value: number } | null };
type PosBuyer = { name: string; phone: string; gstin: string } | null;
type PosPayment = { method: 'Cash' | 'UPI' | 'Card'; amount: number; ref?: string | undefined; tendered?: number | undefined };

/** Sales made at this counter in this session: invoice no → sale id and line ids (for returns). */
const sold = new Map<string, { saleId: string; itemIds: string[]; keys: string[] }>();

const METHOD = { Cash: 'CASH', UPI: 'UPI', Card: 'CARD' } as const;
const disc = (d: PosLine['discount']) => (d && d.value > 0 ? { kind: d.kind === 'pct' ? 'PCT' : 'AMT', value: d.value.toFixed(2) } : undefined);

/** The counter this browser bills at in a branch: the device's, else the branch's first active counter. */
export function counterFor(storeId: string) {
  const device = currentMe()?.session.device;
  if (device) return device.counterId;
  const c = live.counters.filter((x) => x.storeId === storeId && x.status === 'ACTIVE').sort((a, b) => a.number - b.number)[0];
  if (!c) throw new Error('This branch has no active billing counter. Add one on the Branches screen.');
  return c.id;
}

type OpenDrawer = { id: string; userId: string; storeId: string; counterId: string; openedAt: string; expectedCash: string };

const counterLabel = (counterId: string, storeId: string) => {
  const c = live.counters.find((x) => x.id === counterId);
  const s = live.stores.find((x) => x.id === storeId);
  return [c?.name ?? 'another counter', s && live.stores.length > 1 ? s.name : null].filter(Boolean).join(' · ');
};

/**
 * Makes sure the cashier has a drawer open where they bill, and returns the counter to bill on.
 * - A browser that isn't a registered counter simply bills on the counter whose drawer they
 *   already have open in this branch (one drawer per person; any counter of the branch will do).
 * - A registered counter is fixed, so a drawer left open elsewhere (or in another branch) is
 *   counted and closed here first — the server allows one open drawer per person.
 * Otherwise asks for the opening cash once.
 */
async function ensureDrawer(storeId: string): Promise<string> {
  // A registered counter remembers the drawer, so bills made offline later go into the same one.
  const remember = (d: { id: string; userId: string }) =>
    offlineActive() ? kvSet('drawer', { id: d.id, userId: d.userId, offline: false }) : Promise.resolve();
  const device = currentMe()?.session.device;
  let counterId = counterFor(storeId);
  let cur: OpenDrawer | null = null;
  try {
    cur = await api<OpenDrawer>('GET', '/cash-sessions/current');
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
  }
  if (cur) {
    if (cur.counterId === counterId) {
      await remember(cur);
      return counterId;
    }
    if (!device && cur.storeId === storeId) {
      await remember(cur);
      return cur.counterId;
    }
    const counted = await askCloseOtherDrawer({
      id: cur.id,
      where: counterLabel(cur.counterId, cur.storeId),
      openedAt: cur.openedAt,
      expectedCash: num(cur.expectedCash),
      here: counterLabel(counterId, storeId),
    });
    if (counted === null) throw new Error(`Your cash drawer is still open on ${counterLabel(cur.counterId, cur.storeId)} — close it to bill here.`);
    await api('POST', `/cash-sessions/${cur.id}/close`, {
      idempotencyKey: newKey(),
      body: { countedCash: counted.toFixed(2), note: `Closed from ${counterLabel(counterId, storeId)} to start billing there` },
    });
    counterId = counterFor(storeId);
  }

  // Someone else's drawer may be open on the counter. A browser moves on to a free counter of the
  // branch; a registered counter is fixed, so a manager can count and close that drawer here.
  const takenBy = await otherDrawersOn(storeId);
  if (!device) {
    const free = live.counters
      .filter((c) => c.storeId === storeId && c.status === 'ACTIVE')
      .sort((a, b) => a.number - b.number)
      .find((c) => !takenBy.has(c.id));
    if (free) counterId = free.id;
  }
  const float = await askOpeningFloat();
  if (float === null) throw new Error('Open the cash drawer first — cash for bills and refunds goes in and out of it.');
  const open = () => api<{ id: string; userId: string }>('POST', '/cash-sessions', { body: { counterId, openingFloat: float.toFixed(2) } });
  try {
    await remember(await open());
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'SESSION_ALREADY_OPEN') throw e;
    const other = takenBy.get(counterId) ?? (await otherDrawersOn(storeId)).get(counterId);
    if (!device || !other || !can('cash:reconcile'))
      throw new Error(
        device
          ? `${other?.who ?? 'Another cashier'} still has a cash drawer open on this counter. They — or a manager — need to close it before you can bill here.`
          : 'Every counter in this branch has someone’s cash drawer open. Close one, or add a counter on the Branches screen.'
      );
    const counted = await askCloseOtherDrawer({
      id: other.id,
      where: counterLabel(counterId, storeId),
      openedAt: other.openedAt,
      expectedCash: other.expectedCash,
      here: counterLabel(counterId, storeId),
      owner: other.who,
    });
    if (counted === null) throw new Error(`${other.who}’s cash drawer is still open on this counter.`);
    await api('POST', `/cash-sessions/${other.id}/close`, {
      idempotencyKey: newKey(),
      body: { countedCash: counted.toFixed(2), note: `Closed by ${currentMe()?.user.name ?? 'a manager'} to start billing on this counter` },
    });
    await remember(await open());
  }
  return counterId;
}

/**
 * Other people's open drawers in the branch, by counter. Only managers can see them (cashiers
 * see their own drawers only), so for a cashier this is empty and the server's answer decides.
 */
async function otherDrawersOn(storeId: string) {
  const out = new Map<string, { id: string; who: string; openedAt: string; expectedCash: number }>();
  if (!can('cash:reconcile')) return out;
  try {
    const me = currentMe()?.user.id;
    const [sessions, members] = await Promise.all([
      api<{ data: OpenDrawer[] }>('GET', '/cash-sessions', { query: { storeId, status: 'OPEN', pageSize: 100 } }),
      api<{ data: { userId: string; name: string }[] }>('GET', '/memberships', { query: { pageSize: 200 } }).catch(() => ({ data: [] })),
    ]);
    const name = new Map(members.data.map((m) => [m.userId, m.name]));
    for (const s of sessions.data)
      if (s.userId !== me) out.set(s.counterId, { id: s.id, who: name.get(s.userId) ?? 'Another cashier', openedAt: s.openedAt, expectedCash: num(s.expectedCash) });
  } catch {
    /* best effort */
  }
  return out;
}

/** The counter this person's open drawer is on in the branch (browser sessions), else counterFor. */
async function billingCounter(storeId: string) {
  if (currentMe()?.session.device) return counterFor(storeId);
  try {
    const cur = await api<OpenDrawer>('GET', '/cash-sessions/current');
    if (cur.storeId === storeId) return cur.counterId;
  } catch {
    /* no drawer open: the default counter */
  }
  return counterFor(storeId);
}

/** Bills made offline at this counter in this session: invoice no → transaction id and line keys. */
const soldOffline = new Map<string, { txnId: string; keys: string[] }>();

/**
 * Completes a sale. Online, the server prices it again (`payable` guards against drift), takes the
 * stock and numbers the invoice. On a registered counter that can't reach the server — or still
 * has bills waiting to be sent, which must reach it first — the bill is recorded on this computer
 * and numbered from the counter's reserved block instead (src/lib/offline/sale.ts).
 *
 * One UUID per bill: the idempotency key and `clientRef` online, the transaction id offline — so
 * if an online attempt did reach the server but its answer was lost, the offline copy of the same
 * bill is recognised and not recorded twice.
 */
export async function sellLive(input: {
  storeId: string;
  lines: PosLine[];
  billDiscount: PosLine['discount'];
  buyer: PosBuyer;
  payments: PosPayment[];
  payable: number;
  /** A delivery / pickup order this bill is for (it's marked billed and paid). */
  customerOrderId?: string | undefined;
  /** The saved customer the bill is for. */
  customerId?: string | null | undefined;
}): Promise<{ invoiceNo: string; saleId: string | null; offline: boolean }> {
  const id = crypto.randomUUID();
  const buyer = input.buyer && (input.buyer.name || input.buyer.phone || input.buyer.gstin)
    ? { ...(input.buyer.name ? { name: input.buyer.name } : {}), ...(input.buyer.phone ? { phone: input.buyer.phone } : {}), ...(input.buyer.gstin ? { gstin: input.buyer.gstin } : {}) }
    : undefined;
  const offlineCapable = !!currentMe()?.session.device && offlineActive();
  const offline = async () => {
    if (input.customerOrderId)
      throw new Error('Billing an order needs a connection — bill it once the counter is back online.');
    const r = await billOffline({ id, lines: input.lines, billDiscount: input.billDiscount, buyer, payments: input.payments, payable: input.payable, openingFloat: askOpeningFloat });
    soldOffline.set(r.invoiceNo, { txnId: id, keys: input.lines.map((l) => l.key) });
    return { invoiceNo: r.invoiceNo, saleId: null, offline: true };
  };
  if (offlineCapable) {
    if ((await refreshCounts()).pending) await syncNow().catch(() => undefined);
    if (!isReachable() || getSyncStatus().pending > 0) return offline();
  }
  try {
    const counterId = await ensureDrawer(input.storeId);
    return await sellOnline(input, counterId, id, buyer);
  } catch (e) {
    if (offlineCapable && e instanceof ApiError && (e.code === 'NETWORK' || e.status >= 500)) return offline();
    throw e;
  }
}

async function sellOnline(
  input: Parameters<typeof sellLive>[0],
  counterId: string,
  id: string,
  buyer: { name?: string; phone?: string; gstin?: string } | undefined,
): Promise<{ invoiceNo: string; saleId: string; offline: false }> {
  const billDiscount = disc(input.billDiscount);
  const sale = await api<{ id: string; invoiceNo: string; items: { id: string; lineNo: number }[] }>('POST', '/sales', {
    idempotencyKey: id,
    body: {
      clientRef: id,
      counterId,
      ...(input.customerOrderId ? { customerOrderId: input.customerOrderId } : {}),
      ...(input.customerId ? { customerId: input.customerId } : {}),
      lines: input.lines.map((l) => {
        if (!l.sku) throw new Error(`${l.name} isn't in the catalogue — add it on the Products screen first.`);
        const p = productOf(l.sku);
        const d = disc(l.discount);
        return { productId: p.id, qty: String(l.qty), ...(p.allowOpenPrice ? { unitPrice: l.price.toFixed(2) } : {}), ...(d ? { discount: d } : {}) };
      }),
      ...(billDiscount ? { billDiscount } : {}),
      ...(buyer ? { buyer } : {}),
      payments: input.payments.map((p) => ({
        method: METHOD[p.method],
        amount: p.amount.toFixed(2),
        ...(p.tendered !== undefined && p.method === 'Cash' && p.tendered > p.amount ? { tendered: p.tendered.toFixed(2) } : {}),
        ...(p.ref ? { reference: p.ref } : {}),
      })),
      expectedPayable: input.payable.toFixed(2),
    },
  });
  sold.set(sale.invoiceNo, { saleId: sale.id, itemIds: [...sale.items].sort((a, b) => a.lineNo - b.lineNo).map((i) => i.id), keys: input.lines.map((l) => l.key) });
  return { invoiceNo: sale.invoiceNo, saleId: sale.id, offline: false };
}

/** A bill made offline here, once the server has it: its sale id and line ids (for returns). */
async function syncedOfflineBill(invoiceNo: string) {
  const o = soldOffline.get(invoiceNo);
  if (!o) return null;
  const row = await posDb().outbox.where('id').equals(o.txnId).first();
  if (!row?.result?.saleId)
    throw new Error('This bill was made offline and hasn’t reached the server yet — returns work once it has synced.');
  const sale = await api<{ id: string; invoiceNo: string; items: { id: string; lineNo: number }[] }>('GET', `/sales/${row.result.saleId}`);
  const entry = { saleId: sale.id, itemIds: [...sale.items].sort((a, b) => a.lineNo - b.lineNo).map((i) => i.id), keys: o.keys };
  sold.set(invoiceNo, entry);
  // A bill renumbered by the server (rare) is found under either number.
  if (sale.invoiceNo !== invoiceNo) sold.set(sale.invoiceNo, entry);
  return entry;
}

const POS_RETURN_REASON: Record<string, string> = { 'Damaged / defective': 'DAMAGED', Expired: 'EXPIRED', 'Wrong item': 'WRONG_ITEM' };

/** Returns lines of a bill made on this counter; the server issues the credit note number. */
/** The server's sale id for a bill made on this counter (online, or offline and since synced). */
export async function saleIdForInvoice(invoiceNo: string): Promise<string | null> {
  const s = sold.get(invoiceNo) ?? (await syncedOfflineBill(invoiceNo));
  return s?.saleId ?? null;
}

export async function returnLive(invoiceNo: string, qtys: Record<string, number>, reason: string, method: PosPayment['method'], storeId: string) {
  const s = sold.get(invoiceNo) ?? (await syncedOfflineBill(invoiceNo));
  if (!s) throw new Error('Returns for this bill are taken at the counter that sold it (or from the Sales screen).');
  // Cash goes back out of a drawer: open one first (asking for the opening cash), as for a sale.
  const counterId = method === 'Cash' ? await ensureDrawer(storeId) : await billingCounter(storeId);
  const r = await api<{ creditNoteNo: string; refund: { amount: string } }>('POST', `/sales/${s.saleId}/returns`, {
    idempotencyKey: newKey(),
    body: {
      counterId,
      reason: POS_RETURN_REASON[reason] ?? 'CHANGED_MIND',
      refundMethod: METHOD[method],
      items: Object.entries(qtys)
        .filter(([, q]) => q > 0)
        .map(([key, q]) => ({ saleItemId: s.itemIds[s.keys.indexOf(key)] ?? '', qty: String(q) })),
    },
  });
  return { creditNoteNo: r.creditNoteNo, refund: num(r.refund.amount) };
}

/* ---------- suppliers & sales screen ---------- */

export async function createSupplier(v: { name: string; contact: string; phone: string; email: string; gstin: string; supplies: string; creditDays: number }) {
  const gstin = v.gstin.trim().toUpperCase();
  await api('POST', '/suppliers', {
    body: {
      name: v.name,
      ...(v.contact ? { contactName: v.contact } : {}),
      ...(v.phone ? { phone: v.phone } : {}),
      ...(v.email ? { email: v.email } : {}),
      ...(gstin ? { gstin } : { stateCode: live.tenant?.stateCode ?? '33' }),
      ...(v.supplies ? { supplies: v.supplies } : {}),
      creditDays: v.creditDays,
    },
  });
  await reload();
}

/** Refunds a whole bill from the Sales screen (every line still returnable, cash refund). */
export async function refundWholeBill(sale: { id: string; store: { id: string }; counter: { id: string }; items: { id: string; qty: string; returnedQty: string }[] }) {
  const items = sale.items.map((i) => ({ saleItemId: i.id, qty: (num(i.qty) - num(i.returnedQty)).toFixed(3) })).filter((i) => Number(i.qty) > 0);
  if (!items.length) throw new Error('Everything on this bill was already returned.');
  const r = await api<{ creditNoteNo: string }>('POST', `/sales/${sale.id}/returns`, {
    idempotencyKey: newKey(),
    // The cash comes out of the refunder's own drawer (opened first if needed), not the counter that sold it.
    body: { counterId: await ensureDrawer(sale.store.id), reason: 'OTHER', refundMethod: 'CASH', items },
  });
  await reload();
  return r;
}
