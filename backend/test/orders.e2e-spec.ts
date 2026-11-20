import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp } from './utils.js';

const PASSWORD = 'correct-horse-battery';
const native = { 'X-Client': 'native' };

describe('Customer orders and customer figures (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  const as = (t: string) => ({
    get: (url: string) =>
      http().get(`/api/v1${url}`).set('Authorization', `Bearer ${t}`),
    post: (url: string, body?: object) =>
      http()
        .post(`/api/v1${url}`)
        .set('Authorization', `Bearer ${t}`)
        .set('Idempotency-Key', randomUUID())
        .send(body ?? {}),
  });

  async function register(name: string, code: string) {
    const res = await http()
      .post('/api/v1/tenants')
      .set(native)
      .send({
        business: {
          displayName: name,
          businessType: 'supermarket',
          registration: 'UNREGISTERED',
          stateCode: '33',
          address: { line1: '1 Main Road', city: 'Chennai', pincode: '600001' },
        },
        owner: {
          name: `${name} Owner`,
          email: `own-${randomUUID()}@example.test`,
          password: PASSWORD,
        },
        hq: { code },
      })
      .expect(201);
    return {
      token: res.body.accessToken as string,
      storeId: res.body.store.id as string,
      counterId: res.body.counter.id as string,
    };
  }

  let A: Awaited<ReturnType<typeof register>>;
  let B: Awaited<ReturnType<typeof register>>;
  let rice: string;
  let customer: string;

  beforeAll(async () => {
    app = await createTestApp();
    [A, B] = await Promise.all([
      register('Order Mart', 'ORM'),
      register('Other Mart', 'OTM'),
    ]);
    const units = (await as(A.token).get('/units')).body.data as {
      id: string;
      code: string;
    }[];
    const taxes = (await as(A.token).get('/tax-rates')).body.data as {
      id: string;
      name: string;
    }[];
    rice = (
      await as(A.token)
        .post('/products', {
          sku: `R-${randomUUID().slice(0, 6)}`,
          name: 'Ponni Rice 5kg',
          unitId: units.find((u) => u.code === 'PCS')!.id,
          taxRateId: taxes[0]!.id,
          sellingPrice: '415',
        })
        .expect(201)
    ).body.id;
    customer = (
      await as(A.token)
        .post('/customers', {
          name: 'Lakshmi R',
          phone: '9840122334',
          creditLimit: '5000',
        })
        .expect(201)
    ).body.id;
  });
  afterAll(async () => {
    await app.close();
  });

  const order = (over: object = {}) => ({
    storeId: A.storeId,
    customerName: 'Lakshmi R',
    phone: '9840122334',
    address: '12 Anna Nagar West',
    channel: 'WhatsApp',
    fulfilment: 'DELIVERY',
    slot: '11:00–12:00',
    payment: 'CASH_ON_DELIVERY',
    items: [{ productId: rice, qty: 2, price: '415' }],
    deliveryFee: '0',
    ...over,
  });

  it('a delivery order: received → packing → ready → dispatched → delivered with cash collected', async () => {
    const o = (
      await as(A.token)
        .post('/customer-orders', order({ customerId: customer }))
        .expect(201)
    ).body;
    expect(o).toMatchObject({
      number: 'ORD-00001',
      status: 'NEW',
      paid: false,
      subtotal: '830.00',
      total: '830.00',
      storeId: A.storeId,
    });
    expect(o.items[0]).toMatchObject({ name: 'Ponni Rice 5kg', qty: 2 });
    await as(A.token)
      .post(`/customer-orders/${o.id}/advance`, {
        to: 'DISPATCHED',
        rider: 'Murugan',
      })
      .expect(409); // no skipping
    await as(A.token)
      .post(`/customer-orders/${o.id}/advance`, { to: 'PACKING' })
      .expect(200);
    await as(A.token)
      .post(`/customer-orders/${o.id}/advance`, { to: 'READY' })
      .expect(200);
    await as(A.token)
      .post(`/customer-orders/${o.id}/advance`, { to: 'DISPATCHED' })
      .expect(422); // who rides?
    await as(A.token)
      .post(`/customer-orders/${o.id}/advance`, {
        to: 'DISPATCHED',
        rider: 'Murugan',
      })
      .expect(200);
    await as(A.token)
      .post(`/customer-orders/${o.id}/advance`, { to: 'COMPLETED' })
      .expect(422); // how was it paid?
    const done = (
      await as(A.token)
        .post(`/customer-orders/${o.id}/advance`, {
          to: 'COMPLETED',
          collectedBy: 'Cash',
        })
        .expect(200)
    ).body;
    expect(done).toMatchObject({
      status: 'COMPLETED',
      paid: true,
      collectedBy: 'Cash',
      rider: 'Murugan',
    });
    expect(done.history.map((h: { status: string }) => h.status)).toEqual([
      'NEW',
      'PACKING',
      'READY',
      'DISPATCHED',
      'COMPLETED',
    ]);
    expect(done.history[4].note).toBe('Collected ₹830.00 by Cash');
    await as(A.token)
      .post(`/customer-orders/${o.id}/advance`, {
        to: 'CANCELLED',
        note: 'late',
      })
      .expect(409);
  });

  it('pickup and prepaid orders, khata only for a saved customer, cancelling needs a reason', async () => {
    const p = (
      await as(A.token)
        .post(
          '/customer-orders',
          order({ fulfilment: 'PICKUP', payment: 'PREPAID_UPI' }),
        )
        .expect(201)
    ).body;
    expect(p).toMatchObject({ address: 'Store pickup', paid: true });
    await as(A.token)
      .post(`/customer-orders/${p.id}/advance`, { to: 'PACKING' })
      .expect(200);
    await as(A.token)
      .post(`/customer-orders/${p.id}/advance`, { to: 'READY' })
      .expect(200);
    await as(A.token)
      .post(`/customer-orders/${p.id}/advance`, {
        to: 'DISPATCHED',
        rider: 'X',
      })
      .expect(409);
    await as(A.token)
      .post(`/customer-orders/${p.id}/advance`, { to: 'COMPLETED' })
      .expect(200);
    await as(A.token)
      .post('/customer-orders', order({ payment: 'KHATA' }))
      .expect(422);
    await as(A.token)
      .post(
        '/customer-orders',
        order({ fulfilment: 'PICKUP', deliveryFee: '30' }),
      )
      .expect(422);
    const c = (
      await as(A.token)
        .post(
          '/customer-orders',
          order({ customerId: customer, payment: 'KHATA', deliveryFee: '30' }),
        )
        .expect(201)
    ).body;
    expect(c).toMatchObject({ total: '860.00', paid: true });
    await as(A.token)
      .post(`/customer-orders/${c.id}/advance`, { to: 'CANCELLED' })
      .expect(422);
    expect(
      (
        await as(A.token)
          .post(`/customer-orders/${c.id}/advance`, {
            to: 'CANCELLED',
            note: 'Customer called off',
          })
          .expect(200)
      ).body.status,
    ).toBe('CANCELLED');
  });

  it('the board lists open orders and today’s closed ones; other businesses see nothing', async () => {
    const open = (
      await as(A.token).post('/customer-orders', order()).expect(201)
    ).body;
    const list = (await as(A.token).get('/customer-orders').expect(200)).body
      .data as { number: string; status: string }[];
    expect(list.map((o) => o.number)).toEqual([
      'ORD-00004',
      'ORD-00003',
      'ORD-00002',
      'ORD-00001',
    ]);
    expect(
      (
        await as(A.token)
          .get(`/customer-orders?customerId=${customer}`)
          .expect(200)
      ).body.data,
    ).toHaveLength(2);
    expect(
      (await as(B.token).get('/customer-orders').expect(200)).body.data,
    ).toEqual([]);
    await as(B.token)
      .post(`/customer-orders/${open.id}/advance`, { to: 'PACKING' })
      .expect(404);
    await as(B.token)
      .post('/customer-orders', { ...order(), storeId: A.storeId })
      .expect(404);
  });

  it('billing an order at the POS: stock out, invoice on the order, once', async () => {
    await as(A.token)
      .post(`/stores/${A.storeId}/stock-adjustments`, {
        reason: 'OPENING',
        items: [{ productId: rice, qty: 10, unitCost: '360' }],
      })
      .expect(201);
    await as(A.token)
      .post('/cash-sessions', { counterId: A.counterId, openingFloat: '0' })
      .expect(201);
    const o = (
      await as(A.token)
        .post('/customer-orders', order({ customerId: customer }))
        .expect(201)
    ).body;
    expect(
      (await as(A.token).get(`/customer-orders/${o.id}`).expect(200)).body,
    ).toMatchObject({ number: o.number, sale: null });
    const bill = {
      counterId: A.counterId,
      customerOrderId: o.id,
      lines: [{ productId: rice, qty: 2 }],
      payments: [{ method: 'CASH', amount: '830' }],
    };
    const sale = (await as(A.token).post('/sales', bill).expect(201)).body;
    expect(sale).toMatchObject({
      customerId: customer,
      buyer: { name: 'Lakshmi R' },
    });
    const billed = (
      await as(A.token).get(`/customer-orders/${o.id}`).expect(200)
    ).body;
    expect(billed).toMatchObject({
      paid: true,
      collectedBy: 'Cash',
      sale: { id: sale.id, invoiceNo: sale.invoiceNo },
    });
    expect(billed.history.at(-1).note).toBe(`Billed ${sale.invoiceNo}`);
    expect(
      (await as(A.token).get(`/stores/${A.storeId}/stock/${rice}`)).body.qty,
    ).toBe('8.000');

    expect(
      (await as(A.token).post('/sales', bill).expect(409)).body.error.code,
    ).toBe('ORDER_ALREADY_BILLED');
    expect(
      (
        await as(A.token)
          .post(`/customer-orders/${o.id}/advance`, {
            to: 'CANCELLED',
            note: 'x',
          })
          .expect(409)
      ).body.error.code,
    ).toBe('ORDER_BILLED');
    // Billed, so delivering it needs no cash collection.
    await as(A.token)
      .post(`/customer-orders/${o.id}/advance`, { to: 'PACKING' })
      .expect(200);

    // Voiding the bill opens the order to be billed again.
    await as(A.token)
      .post(`/sales/${sale.id}/void`, { reason: 'Wrong items' })
      .expect(200);
    const again = (
      await as(A.token).get(`/customer-orders/${o.id}`).expect(200)
    ).body;
    expect(again).toMatchObject({ sale: null, paid: false, collectedBy: null });
    await as(B.token)
      .post('/cash-sessions', { counterId: B.counterId, openingFloat: '0' })
      .expect(201);
    await as(B.token)
      .post('/sales', { ...bill, counterId: B.counterId })
      .expect((r) => expect([404, 422]).toContain(r.status));
  });

  it('customers carry their visits, spend and since when they owe', async () => {
    await as(A.token)
      .post('/sales', {
        counterId: A.counterId,
        customerId: customer,
        lines: [{ productId: rice, qty: 1 }],
        payments: [{ method: 'CREDIT', amount: '415' }],
      })
      .expect(201);
    const c = (
      (await as(A.token).get('/customers').expect(200)).body.data as Record<
        string,
        unknown
      >[]
    ).find((x) => x.id === customer)!;
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
    }).format(new Date());
    // Today's bill counts as the last visit; the 90-day figures exclude today.
    expect(c).toMatchObject({
      balance: '415.00',
      lastVisit: today,
      owingSince: today,
      visits90: 0,
      spend90: '0.00',
    });
  });
});
