import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp } from './utils.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { gstinCheckChar } from '../src/common/gst.js';

const PASSWORD = 'correct-horse-battery';
const native = { 'X-Client': 'native' };
const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};
const randomPan = () => {
  const L = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${L()}${L()}${L()}P${L()}${String(Math.floor(Math.random() * 9000) + 1000)}${L()}`;
};
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

type Biz = {
  tenantId: string;
  storeId: string;
  token: string;
  pan: string;
  pcs: string;
  kg: string;
  gst5: string;
};

describe('Phase 5 — inventory and stock ledger (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const as = (t: string) => ({
    get: (url: string) => http().get(`/api/v1${url}`).set(bearer(t)),
    post: (url: string, body?: object, key: string | null = randomUUID()) => {
      const r = http().post(`/api/v1${url}`).set(bearer(t));
      if (key) r.set('Idempotency-Key', key);
      return r.send(body ?? {});
    },
    put: (url: string, body: object) =>
      http().put(`/api/v1${url}`).set(bearer(t)).send(body),
    patch: (url: string, body: object) =>
      http().patch(`/api/v1${url}`).set(bearer(t)).send(body),
  });

  async function register(name: string): Promise<Biz> {
    const pan = randomPan();
    const res = await http()
      .post('/api/v1/tenants')
      .set(native)
      .send({
        business: {
          displayName: name,
          businessType: 'supermarket',
          registration: 'REGULAR',
          gstin: gstin('33', pan),
          stateCode: '33',
          address: { line1: '1 Main Road', city: 'Chennai', pincode: '600001' },
        },
        owner: {
          name: `${name} Owner`,
          email: `own-${randomUUID()}@example.test`,
          password: PASSWORD,
        },
        hq: { code: 'HQ' },
      })
      .expect(201);
    const token = res.body.accessToken as string;
    const units = (await as(token).get('/units')).body.data as {
      id: string;
      code: string;
    }[];
    const taxes = (await as(token).get('/tax-rates')).body.data as {
      id: string;
      name: string;
    }[];
    return {
      tenantId: res.body.tenant.id,
      storeId: res.body.store.id,
      token,
      pan,
      pcs: units.find((u) => u.code === 'PCS')!.id,
      kg: units.find((u) => u.code === 'KG')!.id,
      gst5: taxes.find((t) => t.name === 'GST 5%')!.id,
    };
  }

  async function member(owner: Biz, roleKeys: string[], storeIds: string[]) {
    const email = `m-${randomUUID()}@example.test`;
    await as(owner.token)
      .post(
        '/memberships',
        {
          name: `${roleKeys[0]} member`,
          email,
          password: PASSWORD,
          roleKeys,
          storeIds,
        },
        null,
      )
      .expect(201);
    const res = await http()
      .post('/api/v1/auth/login')
      .set(native)
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function product(b: Biz, over: Record<string, unknown> = {}) {
    const res = await as(b.token)
      .post(
        '/products',
        {
          sku: `P-${randomUUID().slice(0, 8)}`,
          name: 'Item',
          unitId: b.pcs,
          taxRateId: b.gst5,
          sellingPrice: '60',
          mrp: '60',
          ...over,
        },
        null,
      )
      .expect(201);
    return res.body.id as string;
  }

  const adjust = (
    t: string,
    store: string,
    reason: string,
    items: object[],
    key?: string,
  ) =>
    as(t).post(
      `/stores/${store}/stock-adjustments`,
      { reason, items },
      key ?? randomUUID(),
    );
  const stockOf = async (t: string, store: string, productId: string) =>
    (await as(t).get(`/stores/${store}/stock/${productId}`).expect(200)).body;

  /** The exit criterion, straight from the database: balance = Σ movements, for every row. */
  async function assertLedgerExplainsBalances(tenantId: string) {
    const bad = await prisma.withTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<unknown[]>`
        SELECT b.store_id, b.product_id FROM stock_balances b
        LEFT JOIN (SELECT store_id, product_id, SUM(qty) s FROM stock_movements GROUP BY 1, 2) m USING (store_id, product_id)
        WHERE b.qty <> COALESCE(m.s, 0)
        UNION ALL
        SELECT s.store_id, s.batch_id FROM batch_stocks s
        LEFT JOIN (SELECT store_id, batch_id, SUM(qty) t FROM stock_movements WHERE batch_id IS NOT NULL GROUP BY 1, 2) m USING (store_id, batch_id)
        WHERE s.qty <> COALESCE(m.t, 0)`,
    );
    expect(bad).toEqual([]);
  }

  let A: Biz;
  let B: Biz;
  let tnr: string;
  let rice: string;
  let tomato: string;
  let paneer: string;
  let inv: string;
  let bm: string;
  let cashier: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    [A, B] = await Promise.all([register('Stock A'), register('Stock B')]);
    tnr = (
      await as(A.token)
        .post(
          '/stores',
          {
            code: 'TNR',
            name: 'T. Nagar',
            address: {
              line1: '5 Usman Road',
              city: 'Chennai',
              pincode: '600017',
              stateCode: '33',
            },
            gstin: gstin('33', A.pan),
          },
          null,
        )
        .expect(201)
    ).body.id;
    rice = await product(A, {
      name: 'Ponni Rice 5kg',
      sellingPrice: '415',
      mrp: '440',
    });
    tomato = await product(A, {
      name: 'Tomato',
      unitId: A.kg,
      sellingPrice: '40',
      mrp: undefined,
    });
    paneer = await product(A, {
      name: 'Paneer 200g',
      tracksBatches: true,
      sellingPrice: '90',
      mrp: '95',
    });
    [inv, bm, cashier] = await Promise.all([
      member(A, ['inventory_manager'], [A.storeId]),
      member(A, ['branch_manager'], [A.storeId]),
      member(A, ['cashier'], [A.storeId]),
    ]);
  });
  afterAll(async () => {
    await app.close();
  });

  describe('opening stock, valuation and idempotency', () => {
    it('opening stock is the first movement and needs a cost', async () => {
      await adjust(A.token, A.storeId, 'OPENING', [
        { productId: rice, qty: 100 },
      ]).expect(422);
      const res = await adjust(A.token, A.storeId, 'OPENING', [
        { productId: rice, qty: 100, unitCost: '40' },
      ]).expect(201);
      expect(res.body).toMatchObject({
        status: 'POSTED',
        reason: 'OPENING',
        value: '4000.00',
      });
      expect(await stockOf(A.token, A.storeId, rice)).toMatchObject({
        qty: '100.000',
        avgCost: '40.0000',
      });
      const again = await adjust(A.token, A.storeId, 'OPENING', [
        { productId: rice, qty: 5, unitCost: '40' },
      ]).expect(422);
      expect(again.body.error.code).toBe('OPENING_NOT_FIRST');
    });

    it('a retried request is done once; a reused key with another body is refused', async () => {
      const key = randomUUID();
      const body = [{ productId: tomato, qty: '20.5', unitCost: '25' }];
      const first = await adjust(
        A.token,
        A.storeId,
        'OPENING',
        body,
        key,
      ).expect(201);
      const retry = await adjust(
        A.token,
        A.storeId,
        'OPENING',
        body,
        key,
      ).expect(200);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.id).toBe(first.body.id);
      expect((await stockOf(A.token, A.storeId, tomato)).qty).toBe('20.500');
      const other = await adjust(
        A.token,
        A.storeId,
        'OPENING',
        [{ productId: tomato, qty: 1, unitCost: '25' }],
        key,
      ).expect(409);
      expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      const missing = await as(A.token)
        .post(
          `/stores/${A.storeId}/stock-adjustments`,
          { reason: 'FOUND', items: body },
          null,
        )
        .expect(400);
      expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('keeps a weighted average cost; stock leaves at that cost', async () => {
      await adjust(A.token, A.storeId, 'FOUND', [
        { productId: rice, qty: 50, unitCost: '46' },
      ]).expect(201);
      expect((await stockOf(A.token, A.storeId, rice)).avgCost).toBe('42.0000'); // (100×40 + 50×46) / 150
      await adjust(A.token, A.storeId, 'DAMAGE', [
        { productId: rice, qty: -10 },
      ]).expect(201);
      const ledger = (
        await as(A.token)
          .get(`/stores/${A.storeId}/stock-movements?productId=${rice}`)
          .expect(200)
      ).body.data;
      expect(ledger[0]).toMatchObject({
        type: 'WRITE_OFF',
        qty: '-10.000',
        unitCost: '42.0000',
        value: '-420.00',
        balanceAfter: '140.000',
        reason: 'DAMAGE',
      });
      expect(ledger.map((m: { type: string }) => m.type)).toEqual([
        'WRITE_OFF',
        'ADJUSTMENT',
        'OPENING',
      ]);
    });

    it('validates direction, units and stock on hand', async () => {
      await adjust(A.token, A.storeId, 'DAMAGE', [
        { productId: rice, qty: 1 },
      ]).expect(422);
      await adjust(A.token, A.storeId, 'FOUND', [
        { productId: rice, qty: -1 },
      ]).expect(422);
      expect(
        (
          await adjust(A.token, A.storeId, 'FOUND', [
            { productId: rice, qty: '1.5', unitCost: 40 },
          ]).expect(422)
        ).body.error.code,
      ).toBe('INVALID_QTY');
      await adjust(A.token, A.storeId, 'WASTAGE', [
        { productId: tomato, qty: '-0.250' },
      ]).expect(201);
      const short = await adjust(A.token, A.storeId, 'THEFT', [
        { productId: rice, qty: -1000 },
      ]).expect(409);
      expect(short.body.error).toMatchObject({
        code: 'STOCK_INSUFFICIENT',
        message: expect.stringContaining('140'),
      });
      expect((await stockOf(A.token, A.storeId, rice)).qty).toBe('140.000');
      await assertLedgerExplainsBalances(A.tenantId);
    });
  });

  describe('approvals', () => {
    it('large adjustments by branch staff wait for someone else to approve', async () => {
      // 130 × ₹42 = ₹5,460 > ₹5,000 limit
      const pending = (
        await adjust(inv, A.storeId, 'DAMAGE', [
          { productId: rice, qty: -130 },
        ]).expect(201)
      ).body;
      expect(pending).toMatchObject({
        status: 'PENDING_APPROVAL',
        value: '5460.00',
      });
      expect((await stockOf(A.token, A.storeId, rice)).qty).toBe('140.000');
      await as(inv)
        .post(`/stock-adjustments/${pending.id}/approve`)
        .expect(403);
      const approved = await as(bm)
        .post(`/stock-adjustments/${pending.id}/approve`)
        .expect(200);
      expect(approved.body).toMatchObject({
        status: 'POSTED',
        decidedByUserId: expect.any(String),
      });
      expect((await stockOf(A.token, A.storeId, rice)).qty).toBe('10.000');
      await as(bm).post(`/stock-adjustments/${pending.id}/approve`).expect(409);
    });

    it('a branch manager cannot approve their own large adjustment; an owner can', async () => {
      await adjust(A.token, A.storeId, 'FOUND', [
        { productId: rice, qty: 200, unitCost: '42' },
      ]).expect(201);
      const own = (
        await adjust(bm, A.storeId, 'THEFT', [
          { productId: rice, qty: -150 },
        ]).expect(201)
      ).body;
      expect(own.status).toBe('PENDING_APPROVAL');
      expect(
        (await as(bm).post(`/stock-adjustments/${own.id}/approve`).expect(403))
          .body.error.code,
      ).toBe('SELF_APPROVAL');
      await as(A.token)
        .post(`/stock-adjustments/${own.id}/approve`)
        .expect(200);
      const small = (
        await adjust(inv, A.storeId, 'WASTAGE', [
          { productId: rice, qty: -2 },
        ]).expect(201)
      ).body;
      expect(small.status).toBe('POSTED');
    });

    it('rejects and cancels without touching stock', async () => {
      const before = (await stockOf(A.token, A.storeId, rice)).qty;
      const a = (
        await adjust(inv, A.storeId, 'DAMAGE', [
          { productId: rice, qty: -130 },
        ]).expect(201)
      ).body;
      await as(bm)
        .post(
          `/stock-adjustments/${a.id}/reject`,
          { reason: 'Recount first' },
          null,
        )
        .expect(200);
      const b = (
        await adjust(inv, A.storeId, 'DAMAGE', [
          { productId: rice, qty: -130 },
        ]).expect(201)
      ).body;
      await as(inv)
        .post(`/stock-adjustments/${b.id}/cancel`, {}, null)
        .expect(200);
      await as(bm).post(`/stock-adjustments/${b.id}/approve`).expect(409);
      expect((await stockOf(A.token, A.storeId, rice)).qty).toBe(before);
      const pending = (
        await as(bm)
          .get('/stock-adjustments?status=PENDING_APPROVAL')
          .expect(200)
      ).body;
      expect(pending.data.map((x: { id: string }) => x.id)).not.toContain(a.id);
    });
  });

  describe('batches and expiry', () => {
    it('batch-tracked stock comes in per batch and goes out earliest-expiry first', async () => {
      expect(
        (
          await adjust(A.token, A.storeId, 'OPENING', [
            { productId: paneer, qty: 10, unitCost: 70 },
          ]).expect(422)
        ).body.error.code,
      ).toBe('BATCH_REQUIRED');
      await adjust(A.token, A.storeId, 'OPENING', [
        {
          productId: paneer,
          qty: 10,
          unitCost: 70,
          batchNo: 'pn-late',
          expiryDate: day(40),
        },
        {
          productId: paneer,
          qty: 10,
          unitCost: 70,
          batchNo: 'PN-SOON',
          expiryDate: day(5),
        },
      ]).expect(201);
      await adjust(A.token, A.storeId, 'EXPIRY', [
        { productId: paneer, qty: -12 },
      ]).expect(201);
      const s = await stockOf(A.token, A.storeId, paneer);
      expect(s.qty).toBe('8.000');
      expect(s.batches).toEqual([
        expect.objectContaining({ batchNo: 'PN-LATE', qty: '8.000' }),
      ]);
      const out = (
        await as(A.token)
          .get(
            `/stores/${A.storeId}/stock-movements?productId=${paneer}&type=WRITE_OFF`,
          )
          .expect(200)
      ).body.data;
      expect(out.map((m: { qty: string }) => m.qty).sort()).toEqual([
        '-10.000',
        '-2.000',
      ]);
    });

    it('alerts list batches expiring soon and already expired', async () => {
      await adjust(A.token, A.storeId, 'FOUND', [
        {
          productId: paneer,
          qty: 3,
          unitCost: 70,
          batchNo: 'PN-OLD',
          expiryDate: day(-1),
        },
      ]).expect(201);
      const alerts = (
        await as(A.token)
          .get(`/stock/alerts/expiry?storeId=${A.storeId}&days=45`)
          .expect(200)
      ).body.data;
      expect(
        alerts.map((a: { batch: { batchNo: string }; daysLeft: number }) => [
          a.batch.batchNo,
          a.daysLeft,
        ]),
      ).toEqual([
        ['PN-OLD', -1],
        ['PN-LATE', 40],
      ]);
      expect(
        (
          await as(A.token)
            .get(`/stock/alerts/expiry?storeId=${A.storeId}&days=10`)
            .expect(200)
        ).body.data,
      ).toHaveLength(1);
      await assertLedgerExplainsBalances(A.tenantId);
    });

    it("tracking can't be switched while stock is held", async () => {
      const r = await as(A.token)
        .patch(`/products/${paneer}`, { tracksBatches: false })
        .expect(422);
      expect(r.body.error.code).toBe('STOCK_HELD');
    });
  });

  describe('concurrency', () => {
    it('parallel write-offs never take more than is there', async () => {
      const p = await product(A, { name: 'Last few' });
      await adjust(A.token, A.storeId, 'OPENING', [
        { productId: p, qty: 5, unitCost: 10 },
      ]).expect(201);
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          adjust(A.token, A.storeId, 'WASTAGE', [{ productId: p, qty: -1 }]),
        ),
      );
      const codes = results.map((r) => r.status);
      expect(codes.filter((c) => c === 201)).toHaveLength(5);
      expect(codes.filter((c) => c === 409)).toHaveLength(7);
      expect((await stockOf(A.token, A.storeId, p)).qty).toBe('0.000');
      await assertLedgerExplainsBalances(A.tenantId);
    });

    it('parallel increments all land', async () => {
      const p = await product(A, { name: 'Busy shelf' });
      await adjust(A.token, A.storeId, 'OPENING', [
        { productId: p, qty: 1, unitCost: 10 },
      ]).expect(201);
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          adjust(A.token, A.storeId, 'FOUND', [
            { productId: p, qty: 1, unitCost: 10 + i },
          ]).expect(201),
        ),
      );
      const s = await stockOf(A.token, A.storeId, p);
      expect(s.qty).toBe('11.000');
      expect(s.avgCost).toBe('14.0909'); // (10 + 10+11+…+19) / 11
    });

    it('the same request sent five times at once is done once', async () => {
      const p = await product(A, { name: 'Retry storm' });
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          adjust(
            A.token,
            A.storeId,
            'OPENING',
            [{ productId: p, qty: 7, unitCost: 10 }],
            key,
          ),
        ),
      );
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 200, 200, 200, 201,
      ]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect((await stockOf(A.token, A.storeId, p)).qty).toBe('7.000');
    });
  });

  describe('physical count', () => {
    it('books counted − system as COUNT_ADJUSTMENT, leaves uncounted lines alone', async () => {
      const riceBefore = Number((await stockOf(A.token, A.storeId, rice)).qty);
      const count = (
        await as(inv)
          .post(
            `/stores/${A.storeId}/stock-counts`,
            { name: 'Aisle 3', productIds: [rice, tomato, paneer] },
            null,
          )
          .expect(201)
      ).body;
      expect(count.summary.lines).toBe(1 + 1 + 2); // paneer: two batches with stock
      const pnLate = count.items.find(
        (i: { batchNo: string | null }) => i.batchNo === 'PN-LATE',
      );
      await as(inv)
        .put(`/stock-counts/${count.id}/items`, {
          items: [
            { productId: rice, countedQty: riceBefore - 3 },
            { productId: tomato, countedQty: '20.750' },
            { productId: paneer, batchId: pnLate.batchId, countedQty: 8 },
          ],
        })
        .expect(200);
      await as(inv)
        .post(`/stock-counts/${count.id}/submit`, {}, null)
        .expect(200);
      await as(inv).post(`/stock-counts/${count.id}/post`).expect(403);
      const sheet = (
        await as(bm)
          .get(`/stock-counts/${count.id}?onlyDifferences=true`)
          .expect(200)
      ).body;
      expect(sheet.summary).toMatchObject({
        counted: 3,
        uncounted: 1,
        differences: 2,
      });
      const posted = await as(bm)
        .post(`/stock-counts/${count.id}/post`)
        .expect(200);
      expect(posted.body.status).toBe('POSTED');
      expect((await stockOf(A.token, A.storeId, rice)).qty).toBe(
        (riceBefore - 3).toFixed(3),
      );
      expect((await stockOf(A.token, A.storeId, tomato)).qty).toBe('20.750');
      expect((await stockOf(A.token, A.storeId, paneer)).qty).toBe('11.000'); // PN-OLD (3) not counted
      const moves = (
        await as(A.token)
          .get(`/stores/${A.storeId}/stock-movements?type=COUNT_ADJUSTMENT`)
          .expect(200)
      ).body.data;
      expect(moves).toHaveLength(2);
      await as(bm).post(`/stock-counts/${count.id}/post`).expect(409);
      await assertLedgerExplainsBalances(A.tenantId);
    });
  });

  describe('transfers', () => {
    it('dispatch puts stock in transit; receipt books arrivals and the shortfall', async () => {
      const t = (
        await as(A.token)
          .post(
            '/stock-transfers',
            {
              fromStoreId: A.storeId,
              toStoreId: tnr,
              items: [{ productId: rice, qty: 20 }],
            },
            null,
          )
          .expect(201)
      ).body;
      expect(t).toMatchObject({ status: 'REQUESTED', crossGstin: false });
      const hqBefore = Number((await stockOf(A.token, A.storeId, rice)).qty);
      const hqAvg = (await stockOf(A.token, A.storeId, rice)).avgCost;
      await as(A.token)
        .post(`/stock-transfers/${t.id}/dispatch`, {})
        .expect(200);
      expect(Number((await stockOf(A.token, A.storeId, rice)).qty)).toBe(
        hqBefore - 20,
      );
      const there = await stockOf(A.token, tnr, rice);
      expect(there).toMatchObject({ qty: '0.000', inTransitIn: '20.000' });
      expect((await stockOf(A.token, A.storeId, rice)).inTransitOut).toBe(
        '20.000',
      );
      await as(A.token)
        .post(`/stock-transfers/${t.id}/cancel`, {}, null)
        .expect(409);
      await as(A.token)
        .post(`/stock-transfers/${t.id}/receive`, {
          items: [{ itemId: t.items[0].id, receivedQty: 21 }],
        })
        .expect(422);
      const got = (
        await as(A.token)
          .post(`/stock-transfers/${t.id}/receive`, {
            items: [{ itemId: t.items[0].id, receivedQty: 18 }],
          })
          .expect(200)
      ).body;
      expect(got).toMatchObject({
        status: 'RECEIVED',
        items: [
          expect.objectContaining({
            dispatchedQty: '20.000',
            receivedQty: '18.000',
            lostQty: '2.000',
          }),
        ],
      });
      expect(await stockOf(A.token, tnr, rice)).toMatchObject({
        qty: '18.000',
        inTransitIn: '0.000',
        avgCost: hqAvg,
      });
      const tnrLedger = (
        await as(A.token)
          .get(`/stores/${tnr}/stock-movements?productId=${rice}`)
          .expect(200)
      ).body.data;
      expect(
        tnrLedger.map(
          (m: { type: string; qty: string }) => `${m.type} ${m.qty}`,
        ),
      ).toEqual(['TRANSFER_LOSS -2.000', 'TRANSFER_IN 20.000']);
      await assertLedgerExplainsBalances(A.tenantId);
    });

    it('batches travel with the stock', async () => {
      const t = (
        await as(A.token)
          .post(
            '/stock-transfers',
            {
              fromStoreId: A.storeId,
              toStoreId: tnr,
              items: [{ productId: paneer, qty: 5 }],
            },
            null,
          )
          .expect(201)
      ).body;
      const sent = (
        await as(A.token)
          .post(`/stock-transfers/${t.id}/dispatch`, {})
          .expect(200)
      ).body;
      // FEFO: the expired PN-OLD (3) goes first, then PN-LATE (2).
      expect(
        sent.items
          .map(
            (i: { batch: { batchNo: string }; dispatchedQty: string }) =>
              `${i.batch.batchNo} ${i.dispatchedQty}`,
          )
          .sort(),
      ).toEqual(['PN-LATE 2.000', 'PN-OLD 3.000']);
      await as(A.token)
        .post(`/stock-transfers/${t.id}/receive`, {})
        .expect(200);
      const there = await stockOf(A.token, tnr, paneer);
      expect(
        there.batches.map(
          (b: { batchNo: string; qty: string }) => `${b.batchNo} ${b.qty}`,
        ),
      ).toEqual(['PN-OLD 3.000', 'PN-LATE 2.000']);
    });

    it('only the right branches act on a transfer', async () => {
      const t = (
        await as(bm)
          .post(
            '/stock-transfers',
            {
              fromStoreId: tnr,
              toStoreId: A.storeId,
              items: [{ productId: rice, qty: 1 }],
            },
            null,
          )
          .expect(201)
      ).body;
      await as(bm).post(`/stock-transfers/${t.id}/dispatch`, {}).expect(404); // not their branch
      await as(A.token)
        .post(`/stock-transfers/${t.id}/dispatch`, {})
        .expect(200);
      await as(bm).post(`/stock-transfers/${t.id}/receive`, {}).expect(200);
      await as(cashier)
        .post(
          '/stock-transfers',
          {
            fromStoreId: tnr,
            toStoreId: A.storeId,
            items: [{ productId: rice, qty: 1 }],
          },
          null,
        )
        .expect(403);
    });
  });

  describe('views, alerts and roles', () => {
    it('reorder levels drive low-stock status and alerts', async () => {
      const qty = Number((await stockOf(A.token, A.storeId, tomato)).qty);
      await as(inv)
        .put(`/stores/${A.storeId}/stock/${tomato}/reorder`, {
          reorderLevel: qty + 5,
          reorderQty: 25,
        })
        .expect(200);
      const low = (
        await as(A.token)
          .get(`/stores/${A.storeId}/stock?status=LOW`)
          .expect(200)
      ).body.data;
      expect(
        low.map((r: { product: { id: string } }) => r.product.id),
      ).toContain(tomato);
      const alerts = (await as(A.token).get('/stock/alerts/low').expect(200))
        .body.data;
      expect(
        alerts.find(
          (a: { product: { id: string } }) => a.product.id === tomato,
        ),
      ).toMatchObject({ suggestedOrderQty: '25.000' });
    });

    it('cashiers see quantities but not costs, and cannot change stock', async () => {
      const list = (
        await as(cashier).get(`/stores/${A.storeId}/stock?q=ponni`).expect(200)
      ).body.data;
      expect(list[0]).toHaveProperty('qty');
      expect(list[0]).not.toHaveProperty('avgCost');
      const moves = (
        await as(cashier)
          .get(`/stores/${A.storeId}/stock-movements?limit=1`)
          .expect(200)
      ).body.data;
      expect(moves[0]).not.toHaveProperty('unitCost');
      await adjust(cashier, A.storeId, 'FOUND', [
        { productId: rice, qty: 1, unitCost: 1 },
      ]).expect(403);
      await as(cashier).get(`/stores/${tnr}/stock`).expect(404); // not their branch
    });

    it('the ledger pages with a cursor', async () => {
      const p1 = (
        await as(A.token)
          .get(`/stores/${A.storeId}/stock-movements?limit=3`)
          .expect(200)
      ).body;
      expect(p1.data).toHaveLength(3);
      const p2 = (
        await as(A.token)
          .get(
            `/stores/${A.storeId}/stock-movements?limit=3&cursor=${p1.meta.nextCursor}`,
          )
          .expect(200)
      ).body;
      expect(BigInt(p2.data[0].seq)).toBeLessThan(BigInt(p1.data[2].seq));
    });
  });

  describe('integrity and isolation', () => {
    it('the ledger cannot be edited or deleted, even directly in the database', async () => {
      await expect(
        prisma.withTenant(
          A.tenantId,
          (tx) =>
            tx.$executeRaw`UPDATE stock_movements SET qty = 999 WHERE tenant_id = ${A.tenantId}::uuid`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.withTenant(
          A.tenantId,
          (tx) =>
            tx.$executeRaw`DELETE FROM stock_movements WHERE tenant_id = ${A.tenantId}::uuid`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it("another business can't see or move this stock", async () => {
      const t = as(B.token);
      await t.get(`/stores/${A.storeId}/stock`).expect(404);
      await adjust(B.token, A.storeId, 'FOUND', [
        { productId: rice, qty: 1, unitCost: 1 },
      ]).expect(404);
      await adjust(B.token, B.storeId, 'FOUND', [
        { productId: rice, qty: 1, unitCost: 1 },
      ]).expect(422);
      const a = (
        await adjust(inv, A.storeId, 'DAMAGE', [{ productId: rice, qty: -140 }])
      ).body;
      await t.post(`/stock-adjustments/${a.id}/approve`).expect(404);
      await t
        .post(
          '/stock-transfers',
          {
            fromStoreId: A.storeId,
            toStoreId: B.storeId,
            items: [{ productId: rice, qty: 1 }],
          },
          null,
        )
        .expect(422);
      expect((await t.get('/stock/alerts/low').expect(200)).body.data).toEqual(
        [],
      );
      const leaked = await prisma.withTenant(B.tenantId, (tx) =>
        tx.stockMovement.count({ where: { tenantId: A.tenantId } }),
      );
      expect(leaked).toBe(0);
    });

    it('reconciliation confirms every balance is explained by its movements', async () => {
      const r = (await as(A.token).get('/stock/reconciliation').expect(200))
        .body;
      expect(r).toMatchObject({
        ok: true,
        balanceMismatches: [],
        batchMismatches: [],
        batchSplitMismatches: [],
      });
      expect(r.balancesChecked).toBeGreaterThan(5);
      await as(inv).get('/stock/reconciliation').expect(403);
      await assertLedgerExplainsBalances(A.tenantId);
    });
  });
});
