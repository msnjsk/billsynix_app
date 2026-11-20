/**
 * Billing on a registered counter while the server can't be reached.
 *
 * The bill is priced from the cached catalogue (the price the counter shows is what the customer
 * pays), numbered from the device's reserved block and written to the outbox — together with the
 * drawer opening if the drawer was opened offline — in one IndexedDB transaction, *before* the POS
 * shows it as done. It reaches the server when the connection is back (outbox.ts).
 *
 * Limits (the business's offline policy): no billing after `maxOfflineHours` without reaching the
 * server, with `maxPendingSales` bills waiting, after the cashier's shift session ended, or
 * without invoice numbers left. Discounts above the limit need a manager online.
 */
import { discountAmount, r2 } from '@/lib/pos/billing';
import { kvGet, kvSet, posDb, type OutboxRow } from './db';
import { getConfig, lastOnlineAt, productBySku, takeInvoiceNo } from './cache';
import { flush, newRow, refreshCounts } from './outbox';

export class OfflineBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineBlocked';
  }
}

export type OfflineLine = {
  sku: string | null;
  name: string;
  price: number;
  qty: number;
  discount: { kind: 'pct' | 'amt'; value: number } | null;
};
export type OfflinePayment = {
  method: 'Cash' | 'UPI' | 'Card';
  amount: number;
  ref?: string | undefined;
  tendered?: number | undefined;
};

/** The drawer this counter bills into: the server's open one, or one opened here offline. */
type Drawer = { id: string; userId: string; offline: boolean };

const METHOD = { Cash: 'CASH', UPI: 'UPI', Card: 'CARD' } as const;
const money = (n: number) => n.toFixed(2);
const disc = (d: OfflineLine['discount']) =>
  d && d.value > 0
    ? { kind: d.kind === 'pct' ? 'PCT' : 'AMT', value: money(d.value) }
    : undefined;

/** Financial year "2627" of an instant in the branch's time zone. */
export function fyAt(at: Date, timeZone: string) {
  const [y, m] = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  })
    .format(at)
    .split('-')
    .map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Why this counter can't bill offline right now, or null. */
export async function offlineBlocker(): Promise<string | null> {
  const c = await getConfig();
  if (!c)
    return 'This counter has not been prepared for offline billing yet — connect once to download the catalogue.';
  if (Date.parse(c.cashier.sessionEndsAt) <= Date.now())
    return 'Your shift session has ended — connect to sign in again.';
  const online = await lastOnlineAt();
  if (
    online &&
    Date.now() - Date.parse(online) > c.policy.maxOfflineHours * 3_600_000
  )
    return `This counter has been offline for more than ${c.policy.maxOfflineHours} hours — connect to send the waiting bills first.`;
  const pending = await posDb()
    .outbox.where('status')
    .equals('pending')
    .count();
  if (pending >= c.policy.maxPendingSales)
    return `${pending} bills are waiting to be sent — connect before billing more.`;
  return null;
}

/** The drawer to bill into, if one is known. */
export async function currentDrawer(cashierId: string): Promise<Drawer | null> {
  const local = await kvGet<Drawer>('drawer');
  if (local && local.userId === cashierId) return local;
  const c = await getConfig();
  if (c?.drawer && c.drawer.userId === cashierId)
    return { id: c.drawer.id, userId: c.drawer.userId, offline: false };
  return null;
}

/**
 * Records a bill offline. `id` is the bill's UUID — the same one an online attempt used as its
 * `clientRef`, so if that attempt did reach the server the bill is not recorded twice.
 * `openingFloat` is needed only when no drawer is open for the cashier yet.
 */
export async function billOffline(input: {
  id: string;
  lines: OfflineLine[];
  billDiscount: OfflineLine['discount'];
  buyer: { name?: string; phone?: string; gstin?: string } | undefined;
  payments: OfflinePayment[];
  payable: number;
  openingFloat?: () => Promise<number | null>;
}): Promise<{ invoiceNo: string; offline: true }> {
  const blocked = await offlineBlocker();
  if (blocked) throw new OfflineBlocked(blocked);
  const c = (await getConfig())!;
  const cashierId = c.cashier.id;

  const lines: (Record<string, unknown> & {
    productId: string;
    qty: string;
  })[] = [];
  for (const l of input.lines) {
    if (!l.sku)
      throw new OfflineBlocked(
        `${l.name} isn't in the catalogue — add it on the Products screen first.`
      );
    const p = await productBySku(l.sku);
    if (!p)
      throw new OfflineBlocked(
        `${l.name} isn't in this counter's offline catalogue.`
      );
    const d = disc(l.discount);
    lines.push({
      productId: p.id,
      qty: String(l.qty),
      unitPrice: money(l.price),
      ...(p.mrp && l.price <= Number(p.mrp) ? { mrp: p.mrp } : {}),
      gstRate: p.gstRate,
      cessRate: p.cessRate,
      priceSource:
        p.allowOpenPrice && money(l.price) !== p.billPrice
          ? 'OPEN_PRICE'
          : p.priceSource,
      ...(d ? { discount: d } : {}),
    });
  }

  // Discounts above the limit (any line, or the bill overall) need a manager's PIN, which can only
  // be checked online — the same test the server applies.
  const rows = input.lines.map((l) => {
    const g = r2(l.price * l.qty);
    return { gross: g, off: discountAmount(g, l.discount) };
  });
  const gross = rows.reduce((s, r) => s + r.gross, 0);
  const net = rows.reduce((s, r) => s + r.gross - r.off, 0);
  const off =
    rows.reduce((s, r) => s + r.off, 0) +
    discountAmount(r2(net), input.billDiscount);
  const pct = (part: number, whole: number) =>
    whole > 0 ? (part * 100) / whole : 0;
  const worst = Math.max(
    pct(off, gross),
    ...rows.map((r) => pct(r.off, r.gross))
  );
  if (worst > c.discountLimitPct + 1e-9)
    throw new OfflineBlocked(
      `A discount above ${c.discountLimitPct}% needs a manager — connect to approve it.`
    );

  let drawer = await currentDrawer(cashierId);
  let openRow: OutboxRow | null = null;
  if (!drawer) {
    const float = input.openingFloat ? await input.openingFloat() : null;
    if (float === null)
      throw new OfflineBlocked('Open the cash drawer to start billing.');
    drawer = { id: crypto.randomUUID(), userId: cashierId, offline: true };
    openRow = newRow(
      'CASH_SESSION_OPEN',
      drawer.id,
      {
        id: drawer.id,
        type: 'CASH_SESSION_OPEN',
        occurredAt: new Date().toISOString(),
        cashierUserId: cashierId,
        openingFloat: money(float),
      },
      `Drawer opened · ₹${money(float)}`
    );
  }

  const billDiscount = disc(input.billDiscount);
  const occurredAt = new Date();
  const fy = fyAt(occurredAt, c.store.timezone);
  const db = posDb();
  const invoiceNo = await db.transaction('rw', db.kv, db.outbox, async () => {
    const no = await takeInvoiceNo(fy);
    if (!no)
      throw new OfflineBlocked(
        'No invoice numbers left for offline billing — connect to get more.'
      );
    if (openRow) {
      await db.outbox.add(openRow);
      await kvSet('drawer', drawer);
    }
    await db.outbox.add(
      newRow(
        'SALE',
        input.id,
        {
          id: input.id,
          type: 'SALE',
          occurredAt: occurredAt.toISOString(),
          cashierUserId: cashierId,
          cashSessionId: drawer.id,
          invoiceNo: no,
          documentType: c.business.documentType,
          lines,
          ...(billDiscount ? { billDiscount } : {}),
          ...(input.buyer && Object.keys(input.buyer).length
            ? { buyer: input.buyer }
            : {}),
          payments: input.payments.map((p) => ({
            method: METHOD[p.method],
            amount: money(p.amount),
            ...(p.tendered !== undefined &&
            p.method === 'Cash' &&
            p.tendered > p.amount
              ? { tendered: money(p.tendered) }
              : {}),
            ...(p.ref ? { reference: p.ref } : {}),
          })),
          payable: money(input.payable),
          ...((await kvGet<string>('catalogueAt'))
            ? { catalogueAt: await kvGet<string>('catalogueAt') }
            : {}),
        },
        `${no} · ₹${money(input.payable)}`
      )
    );
    // The counter's own stock goes down too (it may go below zero offline; the server flags that).
    const stock = (await kvGet<Record<string, number>>('stock')) ?? {};
    for (const l of lines)
      stock[l.productId] =
        Math.round(((stock[l.productId] ?? 0) - Number(l.qty)) * 1000) / 1000;
    await kvSet('stock', stock);
    return no;
  });
  await refreshCounts();
  void flush().catch(() => undefined);
  return { invoiceNo, offline: true };
}

/** After a drawer is closed (online), the next bill opens a new one. */
export const clearOfflineDrawer = () => kvSet('drawer', null);
