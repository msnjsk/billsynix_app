/**
 * Phase 9 exit criterion, from the counter's side: *a sale survives browser restart, is not
 * duplicated on retry, and is either synchronized or clearly retained as failed/pending for
 * operator action.* Drives the same functions the POS screen calls (sellLive, the outbox) on a
 * registered counter, with IndexedDB provided by fake-indexeddb and the network cut by failing
 * `fetch`, against a running API (see vitest.config.mts).
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_URL, enableNativeTokens, setAccessToken } from '@/lib/api/client';
// Relative, as the modules import each other: on Windows an alias can load a second copy.
import { answerOpeningFloat, onOpeningFloatRequest } from '../live/ask';
import { sellLive } from '../live/actions';
import { livePinSignIn } from '../live/session';
import { closePosDb, kvGet, kvSet, PosDatabase, posDb } from './db';
import { getBlocks, getConfig } from './cache';
import { registerThisDevice } from './device';
import { stopOffline, syncNow } from './engine';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffMs,
  flush,
  getSyncStatus,
  newRow,
  queueRows,
} from './outbox';

const PASSWORD = 'correct-horse-battery';
const json = { 'content-type': 'application/json', 'x-client': 'native' };

async function call<T>(
  method: string,
  path: string,
  token: string | null,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...json,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const out = (await res.json().catch(() => ({}))) as T;
  if (!res.ok)
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(out)}`);
  return out;
}

const offline = () =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new TypeError('Failed to fetch'));

describe('Phase 9 — offline billing at a registered counter', () => {
  let owner = '';
  let counterId = '';
  const sku = `RICE-${Date.now().toString(36).toUpperCase()}`;
  const line = (qty: number) => ({
    key: `l-${qty}-${Math.random()}`,
    sku,
    name: 'Ponni Rice 5kg',
    price: 415,
    qty,
    discount: null,
  });
  const sell = (
    qty: number,
    payments = [{ method: 'Cash' as const, amount: 415 * qty }]
  ) =>
    sellLive({
      storeId: '',
      lines: [line(qty)],
      billDiscount: null,
      buyer: null,
      payments,
      payable: 415 * qty,
    });
  const serverSales = async (invoiceNo: string) =>
    (
      await call<{
        data: { invoiceNo: string; totals: { payable: string } }[];
      }>('GET', `/sales?q=${encodeURIComponent(invoiceNo)}`, owner)
    ).data.filter((s) => s.invoiceNo === invoiceNo);

  beforeAll(async () => {
    enableNativeTokens();
    onOpeningFloatRequest(() => queueMicrotask(() => answerOpeningFloat(500)));
    const t = await call<{
      accessToken: string;
      counter: { id: string };
      store: { id: string };
    }>('POST', '/tenants', null, {
      business: {
        displayName: 'Offline Mart',
        businessType: 'supermarket',
        registration: 'UNREGISTERED',
        stateCode: '33',
        address: { line1: '1 Main Road', city: 'Chennai', pincode: '600001' },
      },
      owner: {
        name: 'Owner',
        email: `off-${Date.now()}@example.test`,
        password: PASSWORD,
      },
      hq: { code: 'OFL' },
    });
    owner = t.accessToken;
    counterId = t.counter.id;
    const units = (
      await call<{ data: { id: string; code: string }[] }>(
        'GET',
        '/units',
        owner
      )
    ).data;
    const taxes = (
      await call<{ data: { id: string; name: string }[] }>(
        'GET',
        '/tax-rates',
        owner
      )
    ).data;
    const p = await call<{ id: string }>('POST', '/products', owner, {
      sku,
      name: 'Ponni Rice 5kg',
      unitId: units.find((u) => u.code === 'PCS')!.id,
      taxRateId: taxes.find((x) => x.name === 'GST 5%')!.id,
      sellingPrice: '415',
      mrp: '450',
    });
    await call('POST', `/stores/${t.store.id}/stock-adjustments`, owner, {
      reason: 'OPENING',
      items: [{ productId: p.id, qty: 10, unitCost: '360' }],
    });
    const m = await call<{ id: string }>('POST', '/memberships', owner, {
      name: 'Kavitha',
      email: `kav-${Date.now()}@example.test`,
      password: PASSWORD,
      roleKeys: ['cashier'],
      storeIds: [t.store.id],
      pin: '1357',
    });
    // A manager registers this computer as counter 1 …
    setAccessToken(owner);
    await registerThisDevice(counterId, 'Till 1 PC');
    // … and the cashier signs in on it with her PIN.
    const r = await livePinSignIn(m.id, '1357');
    expect(r.ok).toBe(true);
    await syncNow(); // catalogue, stock, config and a block of invoice numbers
  });
  afterAll(() => {
    stopOffline();
    vi.restoreAllMocks();
  });

  it('the counter is ready to bill offline: catalogue, config and reserved numbers', async () => {
    const cfg = (await getConfig())!;
    expect(cfg).toMatchObject({
      series: 'OFL1',
      counter: { id: counterId },
      cashier: { name: 'Kavitha' },
      business: { documentType: 'BILL_OF_SUPPLY' },
    });
    expect(await getBlocks()).toEqual([
      expect.objectContaining({ from: 1, to: 200, next: 1 }),
    ]);
    expect(
      await posDb().products.where('sku').equals(sku).first()
    ).toMatchObject({ billPrice: '415.00' });
  });

  it('online, a sale goes straight to the server (numbers continue after the reserved block)', async () => {
    const r = await sell(1);
    expect(r).toMatchObject({
      offline: false,
      invoiceNo: `OFL1/${(await getConfig())!.fy}/00201`,
    });
  });

  let offlineNo = '';
  it('offline, the bill is saved on the counter before it is shown as done', async () => {
    const cut = offline();
    const r = await sell(2, [{ method: 'Cash', amount: 830 }]);
    cut.mockRestore();
    offlineNo = r.invoiceNo;
    expect(r).toMatchObject({
      offline: true,
      invoiceNo: `OFL1/${(await getConfig())!.fy}/00001`,
    });
    const rows = await queueRows();
    expect(rows).toEqual([
      expect.objectContaining({
        type: 'SALE',
        status: 'pending',
        label: `${offlineNo} · ₹830.00`,
      }),
    ]);
    // It went into the drawer the online sale opened, not a new one.
    expect(rows[0]!.payload).toMatchObject({
      cashSessionId: (await kvGet<{ id: string }>('drawer'))!.id,
    });
    expect(await serverSales(offlineNo)).toEqual([]);
  });

  it('it survives a browser restart', async () => {
    closePosDb();
    const reopened = new PosDatabase();
    const rows = await reopened.outbox
      .where('status')
      .equals('pending')
      .toArray();
    reopened.close();
    expect(rows.map((r) => r.label)).toEqual([`${offlineNo} · ₹830.00`]);
  });

  it('back online, it is sent once — sending it again records nothing new', async () => {
    const r = await flush({ force: true });
    expect(r).toMatchObject({ accepted: 1, failed: 0 });
    expect(await serverSales(offlineNo)).toEqual([
      expect.objectContaining({
        totals: expect.objectContaining({ payable: '830.00' }),
      }),
    ]);
    // A lost answer, a second tab, a restart mid-upload: the same transaction again.
    const row = (await posDb().outbox.toArray()).find((x) =>
      x.label.startsWith(offlineNo)
    )!;
    await posDb().outbox.update(row.seq!, { status: 'pending' });
    expect(await flush({ force: true })).toMatchObject({ accepted: 1 });
    expect(await serverSales(offlineNo)).toHaveLength(1);
    expect(getSyncStatus()).toMatchObject({
      pending: 0,
      failed: 0,
      online: true,
    });
  });

  it('no answer: the bill waits with backoff and jitter, nothing is lost', async () => {
    const cut = offline();
    const r = await sell(1);
    expect(r.offline).toBe(true);
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    expect(await flush({ force: true })).toMatchObject({
      offline: true,
      sent: 0,
    });
    rand.mockRestore();
    const [row] = await queueRows();
    // Tried by the send that billing starts, then by ours: each failure doubles the wait window.
    expect(row).toMatchObject({ status: 'pending' });
    expect(row!.attempts).toBeGreaterThanOrEqual(1);
    const window = BACKOFF_BASE_MS * 2 ** (row!.attempts - 1);
    expect(row!.nextAttemptAt - Date.now()).toBeGreaterThan(window * 0.9);
    expect(row!.nextAttemptAt - Date.now()).toBeLessThanOrEqual(window);
    cut.mockClear();
    // Not due yet: nothing is sent.
    expect(await flush()).toMatchObject({ waiting: 1, sent: 0 });
    // (The engine's heartbeat — an empty batch — may still go out; no bill does.)
    const sentBills = cut.mock.calls.filter(
      ([u, init]) =>
        String(u).includes('/sync/batch') &&
        !String((init as RequestInit | undefined)?.body ?? '').includes(
          '"transactions":[]'
        )
    );
    expect(sentBills).toEqual([]);
    cut.mockRestore();
    expect(await flush({ force: true })).toMatchObject({ accepted: 1 });
    expect(await serverSales(r.invoiceNo)).toHaveLength(1);
  });

  it('a bill the server refuses stays on the counter as refused — shown, not resent', async () => {
    const cfg = (await getConfig())!;
    const id = crypto.randomUUID();
    const product = (await posDb().products.where('sku').equals(sku).first())!;
    await posDb().outbox.add(
      newRow(
        'SALE',
        id,
        {
          id,
          type: 'SALE',
          occurredAt: new Date().toISOString(),
          cashierUserId: cfg.cashier.id,
          cashSessionId: (await kvGet<{ id: string }>('drawer'))!.id,
          invoiceNo: `OFL1/${cfg.fy}/00150`,
          documentType: cfg.business.documentType,
          lines: [
            {
              productId: product.id,
              qty: '1',
              unitPrice: '415.00',
              gstRate: 0,
            },
          ],
          payments: [{ method: 'CASH', amount: '400.00' }],
          payable: '400.00', // tampered: the line says 415
        },
        'tampered'
      )
    );
    expect(await flush({ force: true })).toMatchObject({ failed: 1 });
    expect(await queueRows()).toEqual([
      expect.objectContaining({
        id,
        status: 'failed',
        lastError: expect.objectContaining({ code: 'PAYABLE_MISMATCH' }),
      }),
    ]);
    expect(getSyncStatus()).toMatchObject({ failed: 1, pending: 0 });
    expect(await flush({ force: true })).toMatchObject({ sent: 0 });
    // The manager sees it on the server too.
    const issues = (
      await call<{ data: { id: string; status: string }[] }>(
        'GET',
        '/sync/issues',
        owner
      )
    ).data;
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id, status: 'FAILED' }),
      ])
    );
  });

  it('offline billing stops after the offline limit', async () => {
    const was = await kvGet<string>('lastOnlineAt');
    const cut = offline();
    await syncNow(); // any background sync settles (and can't reach the server now)
    await kvSet(
      'lastOnlineAt',
      new Date(Date.now() - 25 * 3_600_000).toISOString()
    );
    await expect(sell(1)).rejects.toThrow(/offline for more than 24 hours/);
    cut.mockRestore();
    await kvSet('lastOnlineAt', was);
  });

  it('backoff is full jitter, doubling from 2 s and capped at 5 min', () => {
    expect(backoffMs(1, () => 1)).toBe(2_000);
    expect(backoffMs(3, () => 1)).toBe(8_000);
    expect(backoffMs(30, () => 1)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(5, () => 0)).toBe(0);
  });
});
