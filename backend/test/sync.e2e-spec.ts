import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp } from './utils.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { gstinCheckChar } from '../src/common/gst.js';
import { fyOf } from '../src/sales/bill-math.js';

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
const FY = fyOf(
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(),
  ),
);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

type Biz = {
  tenantId: string;
  storeId: string;
  counterId: string;
  token: string;
  units: Record<string, string>;
  taxes: Record<string, string>;
};
type Result = {
  id: string;
  status: string;
  replayed?: boolean;
  saleId?: string;
  invoiceNo?: string;
  warnings: { code: string }[];
  error?: { code: string; message: string };
};

describe('Phase 9 — offline POS and synchronisation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());
  const as = (t: string) => ({
    get: (url: string) =>
      http().get(`/api/v1${url}`).set('Authorization', `Bearer ${t}`),
    post: (url: string, body?: object, key: string = randomUUID()) =>
      http()
        .post(`/api/v1${url}`)
        .set('Authorization', `Bearer ${t}`)
        .set('Idempotency-Key', key)
        .send(body ?? {}),
    put: (url: string, body: object) =>
      http()
        .put(`/api/v1${url}`)
        .set('Authorization', `Bearer ${t}`)
        .send(body),
    del: (url: string) =>
      http().delete(`/api/v1${url}`).set('Authorization', `Bearer ${t}`),
  });

  async function register(name: string, code: string): Promise<Biz> {
    const res = await http()
      .post('/api/v1/tenants')
      .set(native)
      .send({
        business: {
          displayName: name,
          businessType: 'supermarket',
          registration: 'REGULAR',
          gstin: gstin('33', randomPan()),
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
    const token = res.body.accessToken as string;
    const units = Object.fromEntries(
      (
        (await as(token).get('/units')).body.data as {
          id: string;
          code: string;
        }[]
      ).map((u) => [u.code, u.id]),
    );
    const taxes = Object.fromEntries(
      (
        (await as(token).get('/tax-rates')).body.data as {
          id: string;
          name: string;
        }[]
      ).map((t) => [t.name, t.id]),
    );
    return {
      tenantId: res.body.tenant.id,
      storeId: res.body.store.id,
      counterId: res.body.counter.id,
      token,
      units,
      taxes,
    };
  }

  const product = async (b: Biz, over: Record<string, unknown>) =>
    (
      await as(b.token)
        .post('/products', {
          sku: `P-${randomUUID().slice(0, 8)}`,
          unitId: b.units['PCS'],
          taxRateId: b.taxes['GST 5%'],
          ...over,
        })
        .expect(201)
    ).body.id as string;

  /** A cashier with a PIN, signed in on a newly registered device of `counterId`. */
  async function deviceCashier(b: Biz, counterId: string, name: string) {
    const m = (
      await as(b.token)
        .post('/memberships', {
          name,
          email: `c-${randomUUID()}@example.test`,
          password: PASSWORD,
          roleKeys: ['cashier'],
          storeIds: [b.storeId],
          pin: '2468',
        })
        .expect(201)
    ).body;
    const device = (
      await as(b.token)
        .post(`/counters/${counterId}/devices`, { name: `${name}'s till` })
        .expect(201)
    ).body;
    const login = (
      await http()
        .post('/api/v1/auth/pin-login')
        .set('X-Device-Key', device.deviceKey)
        .set(native)
        .send({ membershipId: m.id, pin: '2468' })
        .expect(200)
    ).body;
    const me = (await as(login.accessToken).get('/auth/me').expect(200)).body;
    return {
      token: login.accessToken as string,
      userId: me.user.id as string,
      deviceId: device.device.id as string,
      membershipId: m.id as string,
      deviceKey: device.deviceKey as string,
    };
  }
  const pinLogin = async (deviceKey: string, membershipId: string) =>
    (
      await http()
        .post('/api/v1/auth/pin-login')
        .set('X-Device-Key', deviceKey)
        .set(native)
        .send({ membershipId, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;

  const stockOf = async (b: Biz, productId: string) =>
    (
      await as(b.token)
        .get(`/stores/${b.storeId}/stock/${productId}`)
        .expect(200)
    ).body.qty as string;
  const salesCount = (tenantId: string) =>
    prisma.withTenant(tenantId, (tx) => tx.sale.count({ where: { tenantId } }));

  let A: Biz;
  let B: Biz;
  let till: { token: string; userId: string; deviceId: string };
  let manager: string;
  let atta: string, milk: string, last: string;
  let drawerId: string;

  const invoice = (n: number) => `SYN1/${FY}/${String(n).padStart(5, '0')}`;
  const sync = (token: string, transactions: object[], extra: object = {}) =>
    as(token).post('/sync/batch', { transactions, ...extra });
  const results = async (
    token: string,
    transactions: object[],
    extra?: object,
  ) =>
    (await sync(token, transactions, extra).expect(200)).body
      .results as Result[];

  /** An offline bill of `lines` [productId, qty, unitPrice] paid in cash. */
  const bill = (
    no: number | string,
    lines: [string, number | string, string, number?][],
    over: Record<string, unknown> = {},
  ) => {
    const total = lines.reduce((s, [, q, p]) => s + Number(q) * Number(p), 0);
    const payable = String(Math.round(total));
    return {
      id: randomUUID(),
      type: 'SALE',
      occurredAt: ago(5),
      cashierUserId: till.userId,
      cashSessionId: drawerId,
      invoiceNo: typeof no === 'number' ? invoice(no) : no,
      documentType: 'TAX_INVOICE',
      lines: lines.map(([productId, qty, unitPrice, gstRate]) => ({
        productId,
        qty,
        unitPrice,
        // As the device's catalogue has them: milk is nil-rated, the rest 5%.
        gstRate: gstRate ?? (productId === milk ? 0 : 5),
      })),
      payments: [{ method: 'CASH', amount: payable }],
      payable,
      ...over,
    };
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    [A, B] = await Promise.all([
      register('Sync Mart', 'SYN'),
      register('Other Mart', 'OTH'),
    ]);
    atta = await product(A, {
      name: 'Atta 5kg',
      sellingPrice: '299',
      mrp: '320',
    });
    milk = await product(A, {
      name: 'Milk 500ml',
      taxRateId: A.taxes['GST 0% (nil-rated)'],
      sellingPrice: '27',
      mrp: '27',
    });
    last = await product(A, {
      name: 'Ghee 1L',
      sellingPrice: '650',
      mrp: '700',
    });
    await as(A.token)
      .post(`/stores/${A.storeId}/stock-adjustments`, {
        reason: 'OPENING',
        items: [
          { productId: atta, qty: 20, unitCost: '255' },
          { productId: milk, qty: 50, unitCost: '24' },
          { productId: last, qty: 1, unitCost: '560' },
        ],
      })
      .expect(201);
    till = await deviceCashier(A, A.counterId, 'Kavitha');
    // The cashier signed in on the device three hours ago (start of the shift).
    await prisma.withTenant(A.tenantId, (tx) =>
      tx.session.updateMany({
        where: { userId: till.userId, deviceId: till.deviceId },
        data: { createdAt: new Date(Date.now() - 3 * 3_600_000) },
      }),
    );
    const mgrEmail = `bm-${randomUUID()}@example.test`;
    await as(A.token)
      .post('/memberships', {
        name: 'Ravi',
        email: mgrEmail,
        password: PASSWORD,
        roleKeys: ['branch_manager'],
        storeIds: [A.storeId],
        pin: '5678',
      })
      .expect(201);
    manager = (
      await http()
        .post('/api/v1/auth/login')
        .set(native)
        .send({ email: mgrEmail, password: PASSWORD })
        .expect(200)
    ).body.accessToken;
  });
  afterAll(async () => {
    await app.close();
  });

  describe('device set-up', () => {
    it('sync endpoints are for registered POS devices only', async () => {
      const r = await as(A.token).get('/sync/config').expect(403);
      expect(r.body.error.code).toBe('DEVICE_REQUIRED');
      await as(A.token).post('/sync/batch', { transactions: [] }).expect(403);
    });

    it('config: who and where the device is, the offline policy, no blocks yet', async () => {
      const c = (await as(till.token).get('/sync/config').expect(200)).body;
      expect(c).toMatchObject({
        device: { id: till.deviceId },
        counter: { id: A.counterId, number: 1 },
        store: { code: 'SYN', stateCode: '33' },
        business: { registration: 'REGULAR', documentType: 'TAX_INVOICE' },
        cashier: { id: till.userId, name: 'Kavitha' },
        series: 'SYN1',
        fy: FY,
        policy: {
          maxOfflineHours: 24,
          maxPendingSales: 500,
          blockSize: 200,
          allowOversell: true,
        },
        discountLimitPct: 10,
        blocks: [],
        drawer: null,
      });
    });

    it('catalogue: full download in pages, then only what changed', async () => {
      const seen = new Map<string, { billPrice: string; version: number }>();
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const r = (
          await as(till.token)
            .get(`/sync/catalogue?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
            .expect(200)
        ).body;
        pages++;
        for (const p of r.products) seen.set(p.id, p);
        cursor = r.cursor;
        if (!r.hasMore) break;
      }
      expect(pages).toBe(2);
      expect(seen.get(atta)).toMatchObject({
        billPrice: '299.00',
        gstRate: 5,
        priceSource: 'PRODUCT',
      });
      expect(seen.get(milk)).toMatchObject({ billPrice: '27.00', gstRate: 0 });

      const none = (
        await as(till.token).get(`/sync/catalogue?cursor=${cursor}`).expect(200)
      ).body;
      expect(none).toMatchObject({ reset: false, full: false, hasMore: false });
      // Overlap window: rows changed in the last minute may come again — harmless (same version).
      for (const p of none.products)
        expect(p.version).toBe(seen.get(p.id)!.version);

      // A branch price list: the branch changed, so the device must start over.
      const list = (
        await as(A.token)
          .post('/price-lists', { name: 'Sync branch' })
          .expect(201)
      ).body;
      await as(A.token)
        .put(`/price-lists/${list.id}/prices`, {
          items: [{ productId: milk, sellingPrice: '26' }],
        })
        .expect(200);
      await as(A.token)
        .put(`/stores/${A.storeId}/price-list`, { priceListId: list.id })
        .expect(200);
      const reset = (
        await as(till.token).get(`/sync/catalogue?cursor=${cursor}`).expect(200)
      ).body;
      expect(reset).toMatchObject({
        reset: true,
        full: true,
        priceList: { id: list.id },
      });
      expect(
        reset.products.find((p: { id: string }) => p.id === milk),
      ).toMatchObject({
        billPrice: '26.00',
        priceSource: 'PRICE_LIST',
      });

      // Removing the branch price shows up in the next delta.
      await as(A.token)
        .del(`/price-lists/${list.id}/prices/${milk}`)
        .expect((r) => {
          expect([200, 204]).toContain(r.status);
        });
      const delta = (
        await as(till.token)
          .get(`/sync/catalogue?cursor=${reset.cursor}`)
          .expect(200)
      ).body;
      expect(
        delta.products.find((p: { id: string }) => p.id === milk),
      ).toMatchObject({
        billPrice: '27.00',
        priceSource: 'PRODUCT',
      });
      await as(A.token)
        .put(`/stores/${A.storeId}/price-list`, { priceListId: null })
        .expect(200);
    });

    it('stock: the branch’s balances for the local copy', async () => {
      const s = (await as(till.token).get('/sync/stock').expect(200)).body;
      const of = (id: string) =>
        s.data.find((r: { productId: string }) => r.productId === id)?.qty;
      expect(of(atta)).toBe('20.000');
      expect(s.allowOversell).toBe(true);
    });

    it('reserves blocks of the counter’s numbers; online sales carry on after them', async () => {
      const b1 = (
        await as(till.token).post('/sync/number-blocks', {}).expect(201)
      ).body;
      expect(b1).toMatchObject({
        from: 1,
        to: 200,
        first: invoice(1),
        last: invoice(200),
        series: 'SYN1',
      });
      const cfg = (await as(till.token).get('/sync/config').expect(200)).body;
      expect(cfg.blocks).toEqual([
        expect.objectContaining({ id: b1.id, highestUsed: null }),
      ]);
      const b2 = (
        await as(till.token)
          .post('/sync/number-blocks', { size: 50 })
          .expect(201)
      ).body;
      expect(b2).toMatchObject({ from: 201, to: 250 });
      expect(
        (await as(till.token).post('/sync/number-blocks', {}).expect(409)).body
          .error.code,
      ).toBe('BLOCKS_AVAILABLE');
    });
  });

  describe('uploading offline work', () => {
    it('a drawer opened offline, then bills taken in it: recorded as billed', async () => {
      drawerId = randomUUID();
      const open = {
        id: drawerId,
        type: 'CASH_SESSION_OPEN',
        occurredAt: ago(60),
        cashierUserId: till.userId,
        openingFloat: '500',
      };
      const cashBill = bill(
        1,
        [
          [atta, 1, '299'],
          [milk, 2, '27'],
        ],
        {
          occurredAt: ago(50),
          payments: [{ method: 'CASH', amount: '353', tendered: '500' }],
        },
      );
      const upiBill = bill(2, [[atta, 1, '299']], {
        occurredAt: ago(40),
        payments: [{ method: 'UPI', amount: '299', reference: 'UTR123' }],
      });
      const r = await results(till.token, [open, cashBill, upiBill]);
      expect(r.map((x) => x.status)).toEqual([
        'ACCEPTED',
        'ACCEPTED',
        'ACCEPTED',
      ]);
      expect(r[1]).toMatchObject({ invoiceNo: invoice(1), warnings: [] });

      const s1 = (await as(A.token).get(`/sales/${r[1]!.saleId}`).expect(200))
        .body;
      expect(s1).toMatchObject({
        invoiceNo: invoice(1),
        cashSessionId: drawerId,
        cashierUserId: till.userId,
        paymentStatus: 'PAID',
        changeGiven: '147.00',
        totals: { payable: '353.00' },
      });
      expect(new Date(s1.issuedAt).toISOString()).toBe(cashBill.occurredAt);
      const s2 = (await as(A.token).get(`/sales/${r[2]!.saleId}`).expect(200))
        .body;
      expect(s2).toMatchObject({
        paymentStatus: 'PENDING',
        payments: [
          expect.objectContaining({
            status: 'PENDING_VERIFICATION',
            reference: 'UTR123',
          }),
        ],
      });
      const row = await prisma.withTenant(A.tenantId, (tx) =>
        tx.sale.findUniqueOrThrow({ where: { id: s1.id } }),
      );
      expect(row).toMatchObject({
        offline: true,
        deviceId: till.deviceId,
        clientRef: cashBill.id,
      });
      const drawer = await prisma.withTenant(A.tenantId, (tx) =>
        tx.cashSession.findUniqueOrThrow({ where: { id: drawerId } }),
      );
      expect(drawer).toMatchObject({
        offline: true,
        status: 'OPEN',
        userId: till.userId,
      });
      expect(await stockOf(A, atta)).toBe('18.000');
      const receipt = (
        await as(A.token).get(`/sales/${s1.id}/receipt`).expect(200)
      ).body;
      expect(receipt.invoice).toMatchObject({
        number: invoice(1),
        cashier: 'Kavitha',
        change: '147.00',
      });

      // Retried upload (e.g. the response was lost): answered from the record, nothing new.
      const before = await salesCount(A.tenantId);
      const again = await results(till.token, [open, cashBill, upiBill]);
      expect(again.every((x) => x.status === 'ACCEPTED' && x.replayed)).toBe(
        true,
      );
      expect(again[1]!.saleId).toBe(r[1]!.saleId);
      expect(await salesCount(A.tenantId)).toBe(before);
      expect(await stockOf(A, atta)).toBe('18.000');
    });

    it('the same bill uploaded three times at once is recorded once', async () => {
      const b = bill(3, [[milk, 1, '27']]);
      const before = await salesCount(A.tenantId);
      const all = await Promise.all([1, 2, 3].map(() => sync(till.token, [b])));
      const rs = all.map((x) => (x.body.results as Result[])[0]!);
      expect(rs.every((x) => x.status === 'ACCEPTED')).toBe(true);
      expect(new Set(rs.map((x) => x.saleId)).size).toBe(1);
      expect(await salesCount(A.tenantId)).toBe(before + 1);
    });

    it('an id reused for a different bill is refused', async () => {
      const b = bill(4, [[milk, 1, '27']]);
      expect((await results(till.token, [b]))[0]!.status).toBe('ACCEPTED');
      const r = (
        await results(till.token, [
          { ...b, lines: [{ ...b.lines[0], qty: 2 }] },
        ])
      )[0]!;
      expect(r).toMatchObject({
        status: 'FAILED',
        error: { code: 'ID_REUSED' },
      });
    });

    it('online sales continue after the reserved numbers', async () => {
      const s = (
        await as(till.token)
          .post('/sales', {
            lines: [{ productId: milk, qty: 1 }],
            payments: [{ method: 'CASH', amount: '27' }],
          })
          .expect(201)
      ).body;
      expect(s.invoiceNo).toBe(invoice(251));
    });

    it('selling more than the stock offline is accepted and flagged for reconciliation', async () => {
      const r = (await results(till.token, [bill(5, [[last, 3, '650']])]))[0]!;
      expect(r.status).toBe('ACCEPTED');
      expect(r.warnings.map((w) => w.code)).toEqual(['NEGATIVE_STOCK']);
      expect(await stockOf(A, last)).toBe('-2.000');
      const moves = await prisma.withTenant(A.tenantId, (tx) =>
        tx.stockMovement.findMany({
          where: { refId: r.saleId!, refType: 'SALE' },
        }),
      );
      expect(moves).toEqual([expect.objectContaining({ negative: true })]);
      const outbox = await prisma.withTenant(A.tenantId, (tx) =>
        tx.outboxEvent.findMany({
          where: { tenantId: A.tenantId, topic: 'stock.negative' },
        }),
      );
      expect(outbox).toHaveLength(1);
      // Online, the same would be refused.
      await as(till.token)
        .post('/sales', {
          lines: [{ productId: last, qty: 1 }],
          payments: [{ method: 'CASH', amount: '650' }],
        })
        .expect(409);
    });

    it('a bill made at an old price keeps the device’s price, with a warning', async () => {
      const cur = (await as(A.token).get(`/products/${atta}`).expect(200)).body;
      await http()
        .patch(`/api/v1/products/${atta}`)
        .set('Authorization', `Bearer ${A.token}`)
        .send({ sellingPrice: '310', version: cur.version })
        .expect(200);
      const r = (await results(till.token, [bill(6, [[atta, 2, '299']])]))[0]!;
      expect(r.status).toBe('ACCEPTED');
      expect(r.warnings.map((w) => w.code)).toEqual(['PRICE_CHANGED']);
      const s = (await as(A.token).get(`/sales/${r.saleId}`).expect(200)).body;
      expect(s.items[0]).toMatchObject({
        unitPrice: '299.00',
        final: '598.00',
      });
    });

    it('refused bills fail alone — the rest of the batch is recorded — and stay failed', async () => {
      const good = bill(7, [[milk, 1, '27']]);
      const taken = bill(1, [[milk, 1, '27']]); // 00001 is already used
      const unreserved = bill(900, [[milk, 1, '27']]);
      const wrongTotal = bill(8, [[milk, 1, '27']], {
        payable: '30',
        payments: [{ method: 'CASH', amount: '30' }],
      });
      const stranger = bill(9, [[milk, 1, '27']], {
        cashierUserId: randomUUID(),
      });
      const malformed = { id: randomUUID(), type: 'SALE', occurredAt: ago(1) };
      const future = bill(10, [[milk, 1, '27']], {
        occurredAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const r = await results(till.token, [
        taken,
        good,
        unreserved,
        wrongTotal,
        stranger,
        malformed,
        future,
      ]);
      expect(r.map((x) => [x.status, x.error?.code])).toEqual([
        ['FAILED', 'NUMBER_IN_USE'],
        ['ACCEPTED', undefined],
        ['FAILED', 'NUMBER_NOT_RESERVED'],
        ['FAILED', 'PAYABLE_MISMATCH'],
        ['FAILED', 'CASHIER_NOT_SIGNED_IN'],
        ['FAILED', 'VALIDATION_FAILED'],
        ['FAILED', 'FUTURE_DATED'],
      ]);
      // Sent again: the same answers, nothing re-run.
      const again = await results(till.token, [taken, unreserved]);
      expect(again.map((x) => [x.status, x.replayed, x.error?.code])).toEqual([
        ['FAILED', true, 'NUMBER_IN_USE'],
        ['FAILED', true, 'NUMBER_NOT_RESERVED'],
      ]);
    });

    it('a bill the online request already recorded is not recorded twice', async () => {
      const id = randomUUID();
      const online = (
        await as(till.token)
          .post('/sales', {
            lines: [{ productId: milk, qty: 1 }],
            payments: [{ method: 'CASH', amount: '27' }],
            clientRef: id,
          })
          .expect(201)
      ).body;
      const before = await salesCount(A.tenantId);
      // The POS never saw the response, so it billed the same cart offline under the same id.
      const r = (
        await results(till.token, [{ ...bill(11, [[milk, 1, '27']]), id }])
      )[0]!;
      expect(r).toMatchObject({
        status: 'ACCEPTED',
        saleId: online.id,
        invoiceNo: online.invoiceNo,
      });
      expect(r.warnings.map((w) => w.code)).toEqual(['RENUMBERED']);
      expect(await salesCount(A.tenantId)).toBe(before);
    });

    it('a heartbeat reports the device’s queue for monitoring', async () => {
      await sync(till.token, [], {
        deviceTime: new Date().toISOString(),
        appVersion: '1.9.0',
        queue: { pending: 4, failed: 1, oldestAt: ago(120) },
      }).expect(200);
      const d = (
        await as(manager).get('/sync/devices').expect(200)
      ).body.data.find((x: { id: string }) => x.id === till.deviceId);
      expect(d).toMatchObject({
        appVersion: '1.9.0',
        queue: { pending: 4, failed: 1 },
        needsReview: { failed: 6 },
      });
      expect(d.queue.ageMinutes).toBeGreaterThanOrEqual(119);
      expect(d.alerts).toEqual(
        expect.arrayContaining(['QUEUE_OLD', 'FAILED_SYNC', 'REVIEW_WARNINGS']),
      );
    });
  });

  describe('manager review', () => {
    type Issue = {
      id: string;
      status: string;
      error: { code: string } | null;
      warnings: { code: string }[];
      printedInvoiceNo: string;
    };
    let issues: Issue[];
    const byError = (code: string) =>
      issues.find((i) => i.error?.code === code)!;

    it('lists what needs attention; cashiers can’t', async () => {
      await as(till.token).get('/sync/issues').expect(403);
      issues = (await as(manager).get('/sync/issues?pageSize=50').expect(200))
        .body.data;
      const codes = issues.map(
        (i) => i.error?.code ?? i.warnings.map((w) => w.code).join(),
      );
      expect(codes.sort()).toEqual(
        [
          // failed, kept with their payload
          'CASHIER_NOT_SIGNED_IN',
          'FUTURE_DATED',
          'NUMBER_IN_USE',
          'NUMBER_NOT_RESERVED',
          'PAYABLE_MISMATCH',
          'VALIDATION_FAILED',
          // accepted with warnings
          'NEGATIVE_STOCK',
          'PRICE_CHANGED',
          'RENUMBERED',
        ].sort(),
      );
      expect(
        (await as(B.token).get('/sync/issues').expect(200)).body.data,
      ).toEqual([]);
    });

    it('re-runs a failed bill under the counter’s next number', async () => {
      const e = byError('NUMBER_IN_USE');
      const plain = (
        await as(manager).post(`/sync/events/${e.id}/retry`, {}).expect(200)
      ).body;
      expect(plain.result).toMatchObject({
        status: 'FAILED',
        error: { code: 'NUMBER_IN_USE' },
      });
      expect(plain.event.attempts).toBe(2);
      const before = await salesCount(A.tenantId);
      const r = (
        await as(manager)
          .post(`/sync/events/${e.id}/retry`, {
            renumber: true,
            note: 'Number clash after reinstall',
          })
          .expect(200)
      ).body;
      expect(r.result).toMatchObject({
        status: 'ACCEPTED',
        invoiceNo: invoice(253),
      });
      expect(r.event).toMatchObject({
        status: 'ACCEPTED',
        needsReview: false,
        review: { note: 'Number clash after reinstall' },
        warnings: [
          expect.objectContaining({ code: 'RENUMBERED', printed: invoice(1) }),
        ],
      });
      expect(await salesCount(A.tenantId)).toBe(before + 1);
      await as(manager).post(`/sync/events/${e.id}/retry`, {}).expect(409);
    });

    it('discards a failed bill with a reason, and acknowledges warnings', async () => {
      const e = byError('PAYABLE_MISMATCH');
      await as(manager).post(`/sync/events/${e.id}/discard`, {}).expect(400);
      const d = (
        await as(manager)
          .post(`/sync/events/${e.id}/discard`, {
            note: 'Test bill on the new till',
          })
          .expect(200)
      ).body;
      expect(d).toMatchObject({ status: 'DISCARDED', needsReview: false });
      await as(manager).post(`/sync/events/${e.id}/retry`, {}).expect(409);
      const w = issues.find((i) =>
        i.warnings.some((x) => x.code === 'NEGATIVE_STOCK'),
      )!;
      expect(
        (
          await as(manager)
            .post(`/sync/events/${w.id}/acknowledge`, {
              note: 'Counted: 2 short',
            })
            .expect(200)
        ).body,
      ).toMatchObject({
        needsReview: false,
        review: { note: 'Counted: 2 short' },
      });
      const left = (
        await as(manager).get('/sync/issues?pageSize=50').expect(200)
      ).body.data as Issue[];
      expect(left.map((i) => i.id)).not.toContain(w.id);
      expect(left.map((i) => i.id)).not.toContain(e.id);
    });

    it('the number-block register shows used and unused numbers', async () => {
      const blocks = (await as(manager).get('/sync/number-blocks').expect(200))
        .body.data;
      // Bills 1–7 were recorded from the first block; refused ones used nothing.
      expect(blocks[0]).toMatchObject({
        first: invoice(1),
        last: invoice(200),
        size: 200,
        used: 7,
        unused: 193,
        highestUsed: invoice(7),
        closedAt: null,
      });
      expect(blocks[1]).toMatchObject({
        first: invoice(201),
        used: 0,
        highestUsed: null,
      });
    });
  });

  describe('one counter at a time', () => {
    it('a PIN sign-in ends the same cashier’s session on another computer', async () => {
      const c2 = (
        await as(A.token)
          .post(`/stores/${A.storeId}/counters`, { name: 'Counter X' })
          .expect(201)
      ).body.id as string;
      const first = await deviceCashier(A, c2, 'Roaming');
      const d2 = (
        await as(A.token)
          .post(`/counters/${A.counterId}/devices`, { name: 'Second till' })
          .expect(201)
      ).body;
      const second = await pinLogin(d2.deviceKey, first.membershipId);
      await as(first.token).get('/auth/me').expect(401);
      await as(second).get('/auth/me').expect(200);
      const ended = await prisma.session.findMany({
        where: { userId: first.userId, deviceId: first.deviceId },
      });
      expect(ended.every((s) => s.revokedReason === 'PIN_ELSEWHERE')).toBe(
        true,
      );

      // The first computer was offline, didn't know, and opened a drawer after that sign-in.
      // It syncs later, when the cashier signs in there again (which ends the other session).
      await prisma.session.updateMany({
        where: { userId: first.userId, deviceId: first.deviceId },
        data: {
          createdAt: new Date(Date.now() - 3 * 3_600_000),
          revokedAt: new Date(Date.now() - 60 * 60_000),
        },
      });
      const back = await pinLogin(first.deviceKey, first.membershipId);
      await as(second).get('/auth/me').expect(401);
      const r = (
        await results(back, [
          {
            id: randomUUID(),
            type: 'CASH_SESSION_OPEN',
            occurredAt: ago(30),
            cashierUserId: first.userId,
            openingFloat: '100',
          },
        ])
      )[0]!;
      // Recorded (it happened), and flagged for the manager.
      expect(r.status).toBe('ACCEPTED');
      expect(r.warnings.map((w) => w.code)).toEqual([
        'CASHIER_SIGNED_IN_ELSEWHERE',
      ]);
    });
  });

  describe('isolation and consistency', () => {
    it('another business’s device can’t use these numbers or drawers', async () => {
      const other = await deviceCashier(B, B.counterId, 'Meena');
      const p = await product(B, {
        name: 'Rice',
        sellingPrice: '100',
        mrp: '110',
      });
      const r = (
        await results(other.token, [
          {
            ...bill(12, [[p, 1, '100']]),
            cashierUserId: other.userId,
            occurredAt: new Date().toISOString(),
          },
        ])
      )[0]!;
      expect(r.status).toBe('FAILED');
      expect(['NUMBER_NOT_RESERVED', 'UNKNOWN_DRAWER']).toContain(
        r.error!.code,
      );
      expect(
        (await as(other.token).get('/sync/config').expect(200)).body.blocks,
      ).toEqual([]);
    });

    it('a revoked device can’t sync and its blocks are closed', async () => {
      const spare = await deviceCashier(A, A.counterId, 'Spare');
      await as(spare.token)
        .post('/sync/number-blocks', { size: 10 })
        .expect(201);
      await as(A.token)
        .post(`/devices/${spare.deviceId}/revoke`)
        .expect((r) => expect([200, 201]).toContain(r.status));
      await as(spare.token)
        .post('/sync/batch', { transactions: [] })
        .expect(401);
      const blocks = await prisma.withTenant(A.tenantId, (tx) =>
        tx.invoiceBlock.findMany({ where: { deviceId: spare.deviceId } }),
      );
      expect(blocks.every((b) => b.closedAt)).toBe(true);
    });

    it('every sale — online or offline — has matching lines, payments, invoice and stock', async () => {
      const bad = await prisma.withTenant(
        A.tenantId,
        (tx) =>
          tx.$queryRaw<{ id: string; problem: string }[]>`
          SELECT s.id, 'lines' AS problem FROM sales s
            JOIN (SELECT sale_id, SUM(final) f FROM sale_items GROUP BY 1) i ON i.sale_id = s.id WHERE i.f <> s.total
          UNION ALL SELECT s.id, 'payments' FROM sales s
            LEFT JOIN (SELECT sale_id, SUM(amount) a FROM sale_payments GROUP BY 1) p ON p.sale_id = s.id
            WHERE COALESCE(p.a, 0) <> s.payable
          UNION ALL SELECT s.id, 'invoice' FROM sales s
            LEFT JOIN invoices v ON v.sale_id = s.id AND v.number = s.invoice_no WHERE v.id IS NULL
          UNION ALL SELECT s.id, 'stock' FROM sales s
            JOIN (SELECT si.sale_id, SUM(si.qty) q FROM sale_items si JOIN products p ON p.id = si.product_id AND p.track_inventory GROUP BY 1) i ON i.sale_id = s.id
            LEFT JOIN (SELECT ref_id, -SUM(qty) q FROM stock_movements WHERE ref_type = 'SALE' GROUP BY 1) m ON m.ref_id = s.id
            WHERE COALESCE(m.q, 0) <> i.q
          UNION ALL SELECT s.id, 'sync' FROM sales s
            WHERE s.offline AND NOT EXISTS (SELECT 1 FROM sync_events e WHERE e.sale_id = s.id AND e.status = 'ACCEPTED')`,
      );
      expect(bad).toEqual([]);
      const stock = await prisma.withTenant(
        A.tenantId,
        (tx) =>
          tx.$queryRaw<unknown[]>`
          SELECT b.product_id FROM stock_balances b
          LEFT JOIN (SELECT store_id, product_id, SUM(qty) t FROM stock_movements GROUP BY 1, 2) m USING (store_id, product_id)
          WHERE b.qty <> COALESCE(m.t, 0)`,
      );
      expect(stock).toEqual([]);
      const offline = await prisma.withTenant(A.tenantId, (tx) =>
        tx.sale.count({ where: { tenantId: A.tenantId, offline: true } }),
      );
      // Bills 1–7, and the one re-run under a new number.
      expect(offline).toBe(8);
    });
  });
});
