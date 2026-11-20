/**
 * What a counter keeps so it can bill offline, refreshed whenever it can reach the server:
 * the device configuration (GET /sync/config), the branch catalogue (GET /sync/catalogue, a
 * delta after the first download), the branch stock (GET /sync/stock) and its reserved blocks of
 * invoice numbers (POST /sync/number-blocks).
 */
import { api, ApiError } from '@/lib/api/client';
import { kvGet, kvSet, posDb, type CachedProduct } from './db';

export type Block = {
  id: string;
  fy: string;
  series: string;
  from: number;
  to: number;
  highestUsed: number | null;
};
/** A block as this device uses it: `next` is the next number it will print. */
export type LocalBlock = Omit<Block, 'highestUsed'> & { next: number };

export type SyncConfig = {
  serverTime: string;
  device: { id: string; name: string };
  counter: { id: string; number: number; name: string };
  store: {
    id: string;
    code: string;
    name: string;
    stateCode: string;
    gstin: string | null;
    timezone: string;
    address: string;
    phone: string | null;
  };
  business: {
    displayName: string;
    legalName: string | null;
    registration: string;
    documentType: 'TAX_INVOICE' | 'BILL_OF_SUPPLY';
  };
  cashier: { id: string; name: string; sessionEndsAt: string };
  drawer: {
    id: string;
    userId: string;
    openingFloat: string;
    openedAt: string;
  } | null;
  series: string;
  fy: string;
  policy: {
    maxOfflineHours: number;
    maxPendingSales: number;
    blockSize: number;
    blockLowWater: number;
    allowOversell: boolean;
  };
  discountLimitPct: number;
  blocks: Block[];
};

export const getConfig = () => kvGet<SyncConfig>('config');
export const getBlocks = async () =>
  (await kvGet<LocalBlock[]>('blocks')) ?? [];
/** Last time the server answered this device. */
export const lastOnlineAt = async () =>
  (await kvGet<string>('lastOnlineAt')) ?? null;
export const markOnline = () => kvSet('lastOnlineAt', new Date().toISOString());

/** Server blocks merged with local use: never go back below a number this device already printed. */
async function mergeBlocks(server: Block[]) {
  const db = posDb();
  await db.transaction('rw', db.kv, async () => {
    const local = new Map(
      ((await kvGet<LocalBlock[]>('blocks')) ?? []).map((b) => [b.id, b])
    );
    const merged: LocalBlock[] = server.map((b) => {
      const mine = local.get(b.id);
      const afterServer = (b.highestUsed ?? b.from - 1) + 1;
      return {
        id: b.id,
        fy: b.fy,
        series: b.series,
        from: b.from,
        to: b.to,
        next: Math.max(mine?.next ?? b.from, afterServer),
      };
    });
    // A block the server closed (used up, year over, device re-registered) is no longer used.
    await kvSet('blocks', merged);
  });
}

export async function refreshConfig(): Promise<SyncConfig> {
  const c = await api<SyncConfig>('GET', '/sync/config');
  await kvSet('config', c);
  await mergeBlocks(c.blocks);
  // A drawer opened here offline is the server's now (or was closed there): stop using the local copy,
  // unless its opening is still waiting to be sent.
  const local = await kvGet<{ id: string }>('drawer');
  if (local && local.id !== c.drawer?.id) {
    const waiting = await posDb()
      .outbox.where('id')
      .equals(local.id)
      .filter((r) => r.status === 'pending')
      .count();
    if (!waiting) await kvSet('drawer', null);
  }
  await markOnline();
  return c;
}

/** Numbers left in blocks of a financial year. */
export const numbersLeft = (blocks: LocalBlock[], fy: string) =>
  blocks
    .filter((b) => b.fy === fy)
    .reduce((s, b) => s + Math.max(0, b.to - b.next + 1), 0);

/** Reserves another block when few numbers are left (online only). */
export async function ensureNumbers(): Promise<void> {
  const c = (await getConfig()) ?? (await refreshConfig());
  if (numbersLeft(await getBlocks(), c.fy) >= c.policy.blockLowWater) return;
  try {
    await api('POST', '/sync/number-blocks', { body: {} });
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'BLOCKS_AVAILABLE') throw e;
  }
  await refreshConfig();
}

const pad = (n: number) => String(n).padStart(5, '0');

/**
 * The next invoice number of this device's blocks for `fy`. Call inside a Dexie transaction that
 * also writes the bill, so a number is never used without a bill or twice.
 */
export async function takeInvoiceNo(fy: string): Promise<string | null> {
  const blocks = (await kvGet<LocalBlock[]>('blocks')) ?? [];
  const b = blocks
    .filter((x) => x.fy === fy && x.next <= x.to)
    .sort((x, y) => x.from - y.from)[0];
  if (!b) return null;
  const n = b.next;
  b.next += 1;
  await kvSet('blocks', blocks);
  return `${b.series}/${b.fy}/${pad(n)}`;
}

/* ---------- catalogue ---------- */

type CataloguePage = {
  reset: boolean;
  full: boolean;
  hasMore: boolean;
  cursor: string;
  products: Omit<CachedProduct, 'codes'>[];
  units: { id: string; code: string; decimals: number }[];
  taxRates: { id: string; name: string; rate: number; cessRate: number }[];
};

/** Brings the cached catalogue up to date (full download the first time, then deltas). */
export async function refreshCatalogue(): Promise<{ products: number }> {
  const db = posDb();
  let cursor = await kvGet<string>('catalogueCursor');
  let count = 0;
  for (let page = 0; page < 200; page++) {
    const r = await api<CataloguePage>('GET', '/sync/catalogue', {
      query: { ...(cursor ? { cursor } : {}), limit: 1000 },
    });
    await db.transaction('rw', db.products, db.kv, async () => {
      if (page === 0 && (r.reset || !cursor)) await db.products.clear();
      await db.products.bulkPut(
        r.products.map((p) => ({
          ...p,
          codes: [p.sku, ...p.barcodes.map((b) => b.code)],
        }))
      );
      await kvSet('units', r.units);
      await kvSet('catalogueCursor', r.cursor);
    });
    count += r.products.length;
    cursor = r.cursor;
    if (!r.hasMore) break;
  }
  await kvSet('catalogueAt', new Date().toISOString());
  return { products: count };
}

export async function refreshStock() {
  const r = await api<{
    asOf: string;
    data: { productId: string; qty: string }[];
  }>('GET', '/sync/stock');
  await kvSet(
    'stock',
    Object.fromEntries(r.data.map((x) => [x.productId, Number(x.qty)]))
  );
  await kvSet('stockAt', r.asOf);
}

export const productBySku = (sku: string) =>
  posDb().products.where('sku').equals(sku).first();

/** Everything an offline counter needs, refreshed together (when online). */
export async function prime() {
  await refreshConfig();
  await ensureNumbers();
  await refreshCatalogue();
  await refreshStock();
}
