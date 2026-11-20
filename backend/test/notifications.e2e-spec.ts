import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp } from './utils.js';

const PASSWORD = 'correct-horse-battery';
const native = { 'X-Client': 'native' };

type Note = { id: string; kind: string; severity: string; title: string; body: string; active: boolean; read: boolean; link: string | null };

describe('Notifications (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  const as = (t: string) => ({
    get: (url: string) => http().get(`/api/v1${url}`).set('Authorization', `Bearer ${t}`),
    post: (url: string, body?: object) =>
      http().post(`/api/v1${url}`).set('Authorization', `Bearer ${t}`).set('Idempotency-Key', randomUUID()).send(body ?? {}),
    put: (url: string, body?: object) =>
      http().put(`/api/v1${url}`).set('Authorization', `Bearer ${t}`).set('Idempotency-Key', randomUUID()).send(body ?? {}),
  });
  const notes = async (t: string) =>
    (await as(t).get('/notifications').expect(200)).body as { data: Note[]; unread: number };
  const byKind = (n: { data: Note[] }, kind: string) => n.data.find((x) => x.kind === kind);

  async function register(name: string, code: string) {
    const res = await http()
      .post('/api/v1/tenants')
      .set(native)
      .send({
        business: { displayName: name, businessType: 'supermarket', registration: 'UNREGISTERED', stateCode: '33', address: { line1: '1 Main Road', city: 'Chennai', pincode: '600001' } },
        owner: { name: `${name} Owner`, email: `own-${randomUUID()}@example.test`, password: PASSWORD },
        hq: { code },
      })
      .expect(201);
    return { token: res.body.accessToken as string, storeId: res.body.store.id as string };
  }

  let A: Awaited<ReturnType<typeof register>>;
  let B: Awaited<ReturnType<typeof register>>;
  let cashier: string;
  let rice: string;

  beforeAll(async () => {
    app = await createTestApp();
    [A, B] = await Promise.all([register('Bell Mart', 'BLM'), register('Quiet Mart', 'QTM')]);
    const units = (await as(A.token).get('/units')).body.data as { id: string; code: string }[];
    const taxes = (await as(A.token).get('/tax-rates')).body.data as { id: string }[];
    rice = (
      await as(A.token)
        .post('/products', { sku: `R-${randomUUID().slice(0, 6)}`, name: 'Ponni Rice 5kg', unitId: units.find((u) => u.code === 'PCS')!.id, taxRateId: taxes[0]!.id, sellingPrice: '415' })
        .expect(201)
    ).body.id;
    await as(A.token).post(`/stores/${A.storeId}/stock-adjustments`, { reason: 'OPENING', items: [{ productId: rice, qty: 10, unitCost: '360' }] }).expect(201);
    // A cashier of the branch.
    const email = `cash-${randomUUID()}@example.test`;
    await as(A.token).post('/memberships', { name: 'Priya S', email, password: PASSWORD, roleKeys: ['cashier'], storeIds: [A.storeId] }).expect(201);
    cashier = (await http().post('/api/v1/auth/login').set(native).send({ email, password: PASSWORD }).expect(200)).body.accessToken;
  });
  afterAll(async () => {
    await app.close();
  });

  it('needs a signed-in member', async () => {
    await http().get('/api/v1/notifications').expect(401);
  });

  it('raises alerts from the business’s data, for the people who can act on them', async () => {
    await as(A.token).put(`/stores/${A.storeId}/stock/${rice}/reorder`, { reorderLevel: 15, reorderQty: 40 }).expect(200);
    await as(A.token)
      .post('/customer-orders', {
        storeId: A.storeId, customerName: 'Lakshmi R', phone: '9840122334', address: '12 Anna Nagar', channel: 'WhatsApp',
        fulfilment: 'DELIVERY', slot: '11:00–12:00', payment: 'CASH_ON_DELIVERY', items: [{ productId: rice, qty: 2, price: '415' }], deliveryFee: '0',
      })
      .expect(201);

    const owner = await notes(A.token);
    expect(byKind(owner, 'stock.low')).toMatchObject({ severity: 'WARNING', title: '1 product running low', active: true, read: false, link: '/purchases' });
    expect(byKind(owner, 'stock.low')!.body).toContain('Ponni Rice 5kg');
    expect(byKind(owner, 'order.new')).toMatchObject({ title: 'New delivery order ORD-00001', active: true });
    expect(byKind(owner, 'staff.added')).toMatchObject({ title: 'Priya S joined the team' });
    expect(owner.unread).toBe(owner.data.filter((n) => n.active).length);

    // The cashier sees the order to bill, not stock planning or staff changes.
    const till = await notes(cashier);
    expect(byKind(till, 'order.new')).toBeDefined();
    expect(byKind(till, 'stock.low')).toBeUndefined();
    expect(byKind(till, 'staff.added')).toBeUndefined();

    // Another business sees none of it.
    const other = await notes(B.token);
    expect(other.data.some((n) => n.kind === 'stock.low' || n.kind === 'order.new')).toBe(false);
  });

  it('reads are per person; read-all clears the count', async () => {
    const before = await notes(A.token);
    const low = byKind(before, 'stock.low')!;
    await as(A.token).post(`/notifications/${low.id}/read`).expect(200);
    const after = await notes(A.token);
    expect(byKind(after, 'stock.low')!.read).toBe(true);
    expect(after.unread).toBe(before.unread - 1);
    // The cashier's own count is untouched; they can't mark what they can't see.
    expect((await notes(cashier)).unread).toBeGreaterThan(0);
    await as(cashier).post(`/notifications/${low.id}/read`).expect(404);
    await as(B.token).post(`/notifications/${low.id}/read`).expect(404);

    await as(A.token).post('/notifications/read-all').expect(200);
    expect((await notes(A.token)).unread).toBe(0);
  });

  it('resolves when the condition clears, and comes back as new when it returns', async () => {
    await as(A.token).put(`/stores/${A.storeId}/stock/${rice}/reorder`, { reorderLevel: null, reorderQty: null }).expect(200);
    expect(byKind(await notes(A.token), 'stock.low')).toMatchObject({ active: false });

    await as(A.token).put(`/stores/${A.storeId}/stock/${rice}/reorder`, { reorderLevel: 12, reorderQty: 40 }).expect(200);
    const back = await notes(A.token);
    expect(byKind(back, 'stock.low')).toMatchObject({ active: true, read: false });
    expect(back.unread).toBe(1);
  });

  it('?unread=true lists only what is still unread', async () => {
    const r = (await as(A.token).get('/notifications?unread=true').expect(200)).body as { data: Note[] };
    expect(r.data.map((n) => n.kind)).toEqual(['stock.low']);
  });
});
