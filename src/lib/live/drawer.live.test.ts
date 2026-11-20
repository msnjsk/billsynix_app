/**
 * Billing when the person's cash drawer is already open on another counter of the branch (e.g.
 * opened from a different computer): a browser that isn't a registered counter bills into that
 * drawer instead of refusing. Needs a running API (see vitest.config.mts).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { api, API_URL, enableNativeTokens } from '@/lib/api/client';
import { liveSignIn } from './session';
import { saveProduct, sellLive } from './actions';
import { answerOpeningFloat, onOpeningFloatRequest } from './ask';
import { live, reload } from './hydrate';
import { getBranches } from '@/lib/branch-data';

const PASSWORD = 'correct-horse-battery';
const email = `drawer-${Date.now()}@example.test`;

describe('A drawer open on another counter', () => {
  let storeId = '';
  let second = '';

  beforeAll(async () => {
    enableNativeTokens();
    const res = await fetch(`${API_URL}/tenants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client': 'native' },
      body: JSON.stringify({
        business: { displayName: 'Two Counter Mart', businessType: 'supermarket', registration: 'UNREGISTERED', stateCode: '33', address: { line1: '1 Main Road', city: 'Chennai', pincode: '600001' } },
        owner: { name: 'Owner', email, password: PASSWORD },
        hq: { code: 'TCM' },
      }),
    });
    expect(res.status).toBe(201);
    expect((await liveSignIn(email, PASSWORD)).ok).toBe(true);
    storeId = getBranches().currentId;
    second = (await api<{ id: string }>('POST', `/stores/${storeId}/counters`, { body: { name: 'Counter 2' } })).id;
    await reload();
    await saveProduct({ name: 'Sugar 1kg', category: 'Staples', supplier: '', price: 50, cost: 40, stock: 10 }, null);
  });

  it('bills into the drawer already open on counter 2 (no "close it first")', async () => {
    const first = live.counters.filter((c) => c.storeId === storeId).sort((a, b) => a.number - b.number)[0]!;
    expect(first.id).not.toBe(second);
    const drawer = await api<{ id: string }>('POST', '/cash-sessions', { body: { counterId: second, openingFloat: '500.00' } });
    const sku = Object.keys(getBranches().stock[storeId] ?? {})[0]!;
    const sale = await sellLive({
      storeId,
      lines: [{ key: 'l1', sku, name: 'Sugar 1kg', price: 50, qty: 1, discount: null }],
      billDiscount: null,
      buyer: null,
      payments: [{ method: 'Cash', amount: 50 }],
      payable: 50,
    });
    // The drawer is counter 2's, so the bill went to counter 2.
    expect(await api<{ cashSessionId: string }>('GET', `/sales/${sale.saleId}`)).toMatchObject({ cashSessionId: drawer.id });
    // Done with it for the next case.
    await api('POST', `/cash-sessions/${drawer.id}/close`, { body: { countedCash: '550.00' } });
  });

  it('a cashier’s drawer on counter 1: the owner’s browser bills on the free counter 2', async () => {
    const cashierEmail = `till-${Date.now()}@example.test`;
    await api('POST', '/memberships', { body: { name: 'Priya', email: cashierEmail, password: PASSWORD, roleKeys: ['cashier'], storeIds: [storeId] } });
    const login = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client': 'native' },
      body: JSON.stringify({ email: cashierEmail, password: PASSWORD }),
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    const first = live.counters.filter((c) => c.storeId === storeId).sort((a, b) => a.number - b.number)[0]!;
    const theirs = await fetch(`${API_URL}/cash-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ counterId: first.id, openingFloat: '1000.00' }),
    });
    expect(theirs.status).toBe(201);

    const off = onOpeningFloatRequest(() => queueMicrotask(() => answerOpeningFloat(300)));
    const sku = Object.keys(getBranches().stock[storeId] ?? {})[0]!;
    const sale = await sellLive({
      storeId,
      lines: [{ key: 'l1', sku, name: 'Sugar 1kg', price: 50, qty: 1, discount: null }],
      billDiscount: null,
      buyer: null,
      payments: [{ method: 'Cash', amount: 50 }],
      payable: 50,
    });
    off();
    const mine = await api<{ id: string; counterId: string }>('GET', '/cash-sessions/current');
    expect(mine.counterId).toBe(second);
    expect(await api<{ cashSessionId: string }>('GET', `/sales/${sale.saleId}`)).toMatchObject({ cashSessionId: mine.id });
  });
});
