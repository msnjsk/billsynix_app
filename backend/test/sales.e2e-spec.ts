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

type Biz = {
  tenantId: string;
  storeId: string;
  counterId: string;
  token: string;
  units: Record<string, string>;
  taxes: Record<string, string>;
};

describe('Phase 7 — POS sales, invoices and payments (e2e)', () => {
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
  });

  async function register(
    name: string,
    registration: 'REGULAR' | 'UNREGISTERED',
    code: string,
  ): Promise<Biz> {
    const res = await http()
      .post('/api/v1/tenants')
      .set(native)
      .send({
        business: {
          displayName: name,
          businessType: 'supermarket',
          registration,
          ...(registration === 'REGULAR'
            ? { gstin: gstin('33', randomPan()) }
            : {}),
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

  async function product(b: Biz, over: Record<string, unknown>) {
    return (
      await as(b.token)
        .post('/products', {
          sku: `P-${randomUUID().slice(0, 8)}`,
          unitId: b.units['PCS'],
          taxRateId: b.taxes['GST 5%'],
          ...over,
        })
        .expect(201)
    ).body.id as string;
  }

  const stockOf = async (b: Biz, productId: string) =>
    (
      await as(b.token)
        .get(`/stores/${b.storeId}/stock/${productId}`)
        .expect(200)
    ).body.qty;
  const sell = (t: string, body: object, key?: string) =>
    as(t).post('/sales', body, key);
  const cash = (amount: string, tendered?: string) => ({
    method: 'CASH',
    amount,
    ...(tendered ? { tendered } : {}),
  });

  let A: Biz;
  let B: Biz;
  let cashier: string;
  let manager: { token: string; userId: string };
  let counter2: string;
  let atta: string,
    milk: string,
    cola: string,
    tomato: string,
    soap: string,
    service: string,
    last: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    [A, B] = await Promise.all([
      register('Shop A', 'REGULAR', 'ANR'),
      register('Shop B', 'UNREGISTERED', 'BBB'),
    ]);
    counter2 = (
      await as(A.token)
        .post(`/stores/${A.storeId}/counters`, { name: 'Counter 2' })
        .expect(201)
    ).body.id;
    atta = await product(A, {
      name: 'Gehu Gold Atta 5kg',
      sellingPrice: '299',
      mrp: '320',
    });
    milk = await product(A, {
      name: 'Toned Milk 500ml',
      taxRateId: A.taxes['GST 0% (nil-rated)'],
      sellingPrice: '27',
      mrp: '27',
    });
    cola = await product(A, {
      name: 'Fizzo Cola 750ml',
      taxRateId: A.taxes['GST 40%'],
      sellingPrice: '45',
      mrp: '45',
    });
    tomato = await product(A, {
      name: 'Tomato',
      unitId: A.units['KG'],
      taxRateId: A.taxes['GST 0% (nil-rated)'],
      sellingPrice: '40',
    });
    soap = await product(A, {
      name: 'Sandal Soap',
      taxRateId: A.taxes['GST 18%'],
      sellingPrice: '100',
      mrp: '120',
      priceIncludesTax: false,
    });
    service = await product(A, {
      name: 'Home delivery',
      taxRateId: A.taxes['GST 18%'],
      sellingPrice: '0',
      allowOpenPrice: true,
      trackInventory: false,
    });
    last = await product(A, {
      name: 'Last one',
      sellingPrice: '10',
      mrp: '10',
    });
    await as(A.token)
      .post(`/stores/${A.storeId}/stock-adjustments`, {
        reason: 'OPENING',
        items: [
          { productId: atta, qty: 20, unitCost: '255' },
          { productId: milk, qty: 50, unitCost: '24' },
          { productId: cola, qty: 10, unitCost: '36' },
          { productId: tomato, qty: '20.500', unitCost: '28' },
          { productId: soap, qty: 10, unitCost: '70' },
          { productId: last, qty: 1, unitCost: '7' },
        ],
      })
      .expect(201);

    // A cashier signed in by PIN on a registered counter device, and a branch manager with a PIN.
    const cashierEmail = `c-${randomUUID()}@example.test`;
    const m = (
      await as(A.token)
        .post('/memberships', {
          name: 'Kavitha',
          email: cashierEmail,
          password: PASSWORD,
          roleKeys: ['cashier'],
          storeIds: [A.storeId],
          pin: '1234',
        })
        .expect(201)
    ).body;
    const device = (
      await as(A.token)
        .post(`/counters/${A.counterId}/devices`, { name: 'Till 1' })
        .expect(201)
    ).body;
    cashier = (
      await http()
        .post('/api/v1/auth/pin-login')
        .set('X-Device-Key', device.deviceKey)
        .set(native)
        .send({ membershipId: m.id, pin: '1234' })
        .expect(200)
    ).body.accessToken;
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
    const mgrToken = (
      await http()
        .post('/api/v1/auth/login')
        .set(native)
        .send({ email: mgrEmail, password: PASSWORD })
        .expect(200)
    ).body.accessToken;
    manager = {
      token: mgrToken,
      userId: (await as(mgrToken).get('/auth/me').expect(200)).body.user.id,
    };
  });
  afterAll(async () => {
    await app.close();
  });

  /** The exit criterion, checked straight in the database for every sale of the business. */
  async function assertSalesConsistent(tenantId: string) {
    const bad = await prisma.withTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<{ id: string; problem: string }[]>`
        SELECT s.id, 'lines' AS problem FROM sales s
          JOIN (SELECT sale_id, SUM(final) f FROM sale_items GROUP BY 1) i ON i.sale_id = s.id WHERE i.f <> s.total
        UNION ALL SELECT s.id, 'rounding' FROM sales s WHERE s.payable <> ROUND(s.total, 0)
        UNION ALL SELECT s.id, 'payments' FROM sales s
          LEFT JOIN (SELECT sale_id, SUM(amount) a FROM sale_payments GROUP BY 1) p ON p.sale_id = s.id
          WHERE COALESCE(p.a, 0) <> s.payable
        UNION ALL SELECT s.id, 'invoice' FROM sales s
          LEFT JOIN invoices v ON v.sale_id = s.id AND v.number = s.invoice_no WHERE v.id IS NULL
        UNION ALL SELECT s.id, 'stock' FROM sales s
          JOIN (SELECT si.sale_id, SUM(si.qty) q FROM sale_items si JOIN products p ON p.id = si.product_id AND p.track_inventory GROUP BY 1) i ON i.sale_id = s.id
          LEFT JOIN (SELECT ref_id, -SUM(qty) q FROM stock_movements WHERE ref_type = 'SALE' GROUP BY 1) m ON m.ref_id = s.id
          WHERE COALESCE(m.q, 0) <> i.q`,
    );
    expect(bad).toEqual([]);
    const stock = await prisma.withTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<unknown[]>`
        SELECT b.product_id FROM stock_balances b
        LEFT JOIN (SELECT store_id, product_id, SUM(qty) t FROM stock_movements GROUP BY 1, 2) m USING (store_id, product_id)
        WHERE b.qty <> COALESCE(m.t, 0)`,
    );
    expect(stock).toEqual([]);
  }

  describe('drawer and pricing', () => {
    it('a sale needs the cashier’s own open drawer', async () => {
      const r = await sell(cashier, {
        lines: [{ productId: milk, qty: 1 }],
        payments: [cash('27')],
      }).expect(409);
      expect(r.body.error.code).toBe('NO_OPEN_SESSION');
      const s = await as(cashier)
        .post('/cash-sessions', { openingFloat: '500' })
        .expect(201);
      expect(s.body).toMatchObject({
        status: 'OPEN',
        counterId: A.counterId,
        expectedCash: '500.00',
      });
      await as(cashier)
        .post('/cash-sessions', { openingFloat: '1' })
        .expect(409);
      await as(A.token)
        .post('/cash-sessions', { counterId: A.counterId, openingFloat: '1' })
        .expect(409); // counter busy
      await as(A.token)
        .post('/cash-sessions', { counterId: counter2, openingFloat: '1000' })
        .expect(201);
    });

    it('quotes with the server’s prices, GST worked back out, and stock on hand', async () => {
      const q = (
        await as(cashier)
          .post('/sales/quote', {
            lines: [
              { productId: atta, qty: 1 },
              { productId: milk, qty: 2 },
              { productId: cola, qty: 1 },
            ],
          })
          .expect(200)
      ).body;
      expect(q).toMatchObject({
        documentType: 'TAX_INVOICE',
        interState: false,
        totals: { total: '398.00', payable: '398.00', roundOff: '0.00' },
      });
      expect(q.lines[0]).toMatchObject({
        unitPrice: '299.00',
        taxable: '284.76',
        tax: '14.24',
        available: '20.000',
        inStock: true,
      });
      expect(
        q.slabs.map((s: { rate: number; cgst: string }) => [s.rate, s.cgst]),
      ).toEqual([
        [0, '0.00'],
        [5, '7.12'],
        [40, '6.43'],
      ]);
    });

    it('prices are the server’s: fixed prices can’t be overridden, open prices stay within MRP, exclusive prices get GST added', async () => {
      expect(
        (
          await as(cashier)
            .post('/sales/quote', {
              lines: [{ productId: atta, qty: 1, unitPrice: '1' }],
            })
            .expect(422)
        ).body.error.code,
      ).toBe('OPEN_PRICE_NOT_ALLOWED');
      const open = (
        await as(cashier)
          .post('/sales/quote', {
            lines: [{ productId: service, qty: 1, unitPrice: '50' }],
          })
          .expect(200)
      ).body;
      expect(open.lines[0]).toMatchObject({
        priceSource: 'OPEN_PRICE',
        final: '50.00',
        taxable: '42.37',
      });
      const excl = (
        await as(cashier)
          .post('/sales/quote', { lines: [{ productId: soap, qty: 1 }] })
          .expect(200)
      ).body;
      expect(excl.lines[0]).toMatchObject({
        unitPrice: '118.00',
        taxable: '100.00',
        tax: '18.00',
      });
      await as(cashier)
        .post('/sales/quote', { lines: [{ productId: atta, qty: '1.5' }] })
        .expect(422);
      await as(cashier)
        .post('/sales/quote', { lines: [{ productId: tomato, qty: '1.25' }] })
        .expect(200);
    });
  });

  describe('selling', () => {
    let first: {
      id: string;
      invoiceNo: string;
      items: { id: string; productId: string }[];
    };

    it('a cash sale: stock out, numbered invoice, payment, change — in one go', async () => {
      const res = await sell(cashier, {
        lines: [
          { productId: atta, qty: 1 },
          { productId: milk, qty: 2 },
          { productId: cola, qty: 1 },
        ],
        payments: [cash('398', '500')],
        clientRef: 'till1-0001',
      }).expect(201);
      first = res.body;
      expect(res.body).toMatchObject({
        invoiceNo: `ANR1/${FY}/00001`,
        documentType: 'TAX_INVOICE',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        changeGiven: '102.00',
        totals: { payable: '398.00', cgst: '13.55', sgst: '13.55' },
      });
      expect(res.body.items[0]).toMatchObject({
        lineNo: 1,
        sku: expect.any(String),
        hsnCode: null,
        unitPrice: '299.00',
        final: '299.00',
        gstRate: 5,
      });
      expect(await stockOf(A, atta)).toBe('19.000');
      const moves = (
        await as(A.token)
          .get(
            `/stores/${A.storeId}/stock-movements?productId=${atta}&type=SALE`,
          )
          .expect(200)
      ).body.data;
      expect(moves[0]).toMatchObject({
        refType: 'SALE',
        refId: first.id,
        qty: '-1.000',
        unitCost: '255.0000',
      });
      const full = (await as(A.token).get(`/sales/${first.id}`).expect(200))
        .body;
      expect(full.items[0].unitCost).toBe('255.0000'); // margin snapshot, owners only
      expect(res.body.items[0]).not.toHaveProperty('unitCost');
    });

    it('prints the invoice exactly as issued', async () => {
      const r = (
        await as(cashier).get(`/sales/${first.id}/receipt`).expect(200)
      ).body;
      expect(r).toMatchObject({
        status: 'ISSUED',
        invoice: {
          title: 'TAX INVOICE',
          number: first.invoiceNo,
          totals: { total: '398.00' },
          change: '102.00',
          cashier: 'Kavitha',
        },
      });
      const html = await as(cashier)
        .get(`/sales/${first.id}/receipt.html`)
        .expect(200);
      expect(html.headers['content-type']).toContain('text/html');
      expect(html.text).toContain(first.invoiceNo);
      expect(html.text).toContain('GSTIN');
    });

    it('a retry is the same sale; the POS bill id can’t be saved twice', async () => {
      const key = randomUUID();
      const body = {
        lines: [{ productId: milk, qty: 1 }],
        payments: [cash('27')],
      };
      const a = await sell(cashier, body, key).expect(201);
      const b = await sell(cashier, body, key).expect(200);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.body.invoiceNo).toBe(a.body.invoiceNo);
      expect(
        (await sell(cashier, { ...body, clientRef: 'till1-0001' }).expect(409))
          .body.error.code,
      ).toBe('DUPLICATE_CLIENT_REF');
      const conflict = await sell(
        cashier,
        { ...body, payments: [cash('27', '50')] },
        key,
      ).expect(409);
      expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('the same request sent five times at once makes one sale', async () => {
      const before = await prisma.withTenant(A.tenantId, (tx) =>
        tx.sale.count({ where: { tenantId: A.tenantId } }),
      );
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          sell(
            cashier,
            { lines: [{ productId: milk, qty: 1 }], payments: [cash('27')] },
            key,
          ),
        ),
      );
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        200, 200, 200, 200, 201,
      ]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(
        await prisma.withTenant(A.tenantId, (tx) =>
          tx.sale.count({ where: { tenantId: A.tenantId } }),
        ),
      ).toBe(before + 1);
    });

    it('a failed sale leaves nothing — not even a used invoice number', async () => {
      const before = (await as(cashier).get('/sales?pageSize=1').expect(200))
        .body.data[0].invoiceNo as string;
      const stock = await stockOf(A, atta);
      await sell(cashier, {
        lines: [{ productId: atta, qty: 1 }],
        payments: [cash('100')],
      }).expect(422); // short payment
      await sell(cashier, {
        lines: [
          { productId: atta, qty: 1 },
          { productId: cola, qty: 99 },
        ],
        payments: [cash('4754')],
      }).expect(409); // not enough cola
      expect(await stockOf(A, atta)).toBe(stock);
      const next = (
        await sell(cashier, {
          lines: [{ productId: milk, qty: 1 }],
          payments: [cash('27')],
        }).expect(201)
      ).body.invoiceNo as string;
      expect(Number(next.slice(-5))).toBe(Number(before.slice(-5)) + 1);
    });

    it('two counters selling the last unit: exactly one succeeds', async () => {
      const results = await Promise.all([
        sell(cashier, {
          lines: [{ productId: last, qty: 1 }],
          payments: [cash('10')],
        }),
        sell(A.token, {
          counterId: counter2,
          lines: [{ productId: last, qty: 1 }],
          payments: [cash('10')],
        }),
      ]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        201, 409,
      ]);
      expect(results.find((r) => r.status === 409)!.body.error.code).toBe(
        'STOCK_INSUFFICIENT',
      );
      expect(await stockOf(A, last)).toBe('0.000');
    });

    it('a price change since the POS loaded is caught', async () => {
      const list = (
        await as(A.token)
          .post('/price-lists', { name: `HQ ${randomUUID().slice(0, 4)}` })
          .expect(201)
      ).body;
      await as(A.token)
        .put(`/price-lists/${list.id}/prices`, {
          items: [{ productId: atta, sellingPrice: '289' }],
        })
        .expect(200);
      await as(A.token)
        .put(`/stores/${A.storeId}/price-list`, { priceListId: list.id })
        .expect(200);
      const r = await sell(cashier, {
        lines: [{ productId: atta, qty: 1 }],
        payments: [cash('299')],
        expectedPayable: '299',
      }).expect(409);
      expect(r.body.error).toMatchObject({
        code: 'PRICE_CHANGED',
        message: expect.stringContaining('289'),
      });
      const ok = (
        await sell(cashier, {
          lines: [{ productId: atta, qty: 1 }],
          payments: [cash('289')],
          expectedPayable: '289',
        }).expect(201)
      ).body;
      expect(ok.items[0].priceSource).toBe('PRICE_LIST');
      await as(A.token)
        .put(`/stores/${A.storeId}/price-list`, { priceListId: null })
        .expect(200);
    });

    it('discounts above 10% need a manager’s PIN', async () => {
      const line = {
        productId: atta,
        qty: 1,
        discount: { kind: 'PCT', value: '15' },
      };
      expect(
        (
          await sell(cashier, {
            lines: [line],
            payments: [cash('254')],
          }).expect(403)
        ).body.error.code,
      ).toBe('APPROVAL_REQUIRED');
      expect(
        (
          await sell(cashier, {
            lines: [line],
            payments: [cash('254')],
            approval: { userId: manager.userId, pin: '0000' },
          }).expect(403)
        ).body.error.code,
      ).toBe('APPROVAL_INVALID');
      const ok = (
        await sell(cashier, {
          lines: [line],
          payments: [cash('254')],
          approval: { userId: manager.userId, pin: '5678' },
        }).expect(201)
      ).body;
      expect(ok.totals).toMatchObject({
        lineDiscounts: '44.85',
        payable: '254.00',
      });
      const audit = await prisma.withTenant(A.tenantId, (tx) =>
        tx.sale.findUniqueOrThrow({ where: { id: ok.id } }),
      );
      expect(audit.discountApprovedBy).toBe(manager.userId);
      await sell(cashier, {
        lines: [{ ...line, discount: { kind: 'PCT', value: '10' } }],
        payments: [cash('269')],
      }).expect(201);
    });

    it('a business buyer from another state gets an IGST invoice', async () => {
      const r = (
        await sell(cashier, {
          lines: [{ productId: soap, qty: 2 }],
          buyer: { name: 'Hotel Udupi', gstin: gstin('29', randomPan()) },
          payments: [cash('236')],
        }).expect(201)
      ).body;
      expect(r).toMatchObject({
        interState: true,
        placeOfSupply: '29',
        totals: { igst: '36.00', cgst: '0.00', taxable: '200.00' },
      });
      await as(cashier)
        .post('/sales/quote', {
          lines: [{ productId: soap, qty: 1 }],
          buyer: { gstin: '29ABCDE1234F1Z0' },
        })
        .expect(422);
    });

    it('an unregistered business issues a bill of supply without GST', async () => {
      const p = await product(B, {
        name: 'Rice',
        sellingPrice: '105',
        mrp: '110',
      });
      await as(B.token)
        .post(`/stores/${B.storeId}/stock-adjustments`, {
          reason: 'OPENING',
          items: [{ productId: p, qty: 5, unitCost: '80' }],
        })
        .expect(201);
      await as(B.token)
        .post('/cash-sessions', { counterId: B.counterId, openingFloat: '0' })
        .expect(201);
      const r = (
        await sell(B.token, {
          counterId: B.counterId,
          lines: [{ productId: p, qty: 1 }],
          payments: [cash('105')],
        }).expect(201)
      ).body;
      expect(r).toMatchObject({
        documentType: 'BILL_OF_SUPPLY',
        invoiceNo: `BBB1/${FY}/00001`,
        totals: { taxable: '105.00', cgst: '0.00' },
      });
      const doc = (await as(B.token).get(`/sales/${r.id}/receipt`)).body
        .invoice;
      expect(doc.title).toBe('BILL OF SUPPLY');
      await assertSalesConsistent(B.tenantId);
    });
  });

  describe('UPI and card payments', () => {
    it('stay pending until verified; a failed one leaves the bill due', async () => {
      const s = (
        await sell(cashier, {
          lines: [{ productId: atta, qty: 1 }],
          payments: [{ method: 'UPI', amount: '299', reference: 'UTR998877' }],
        }).expect(201)
      ).body;
      expect(s).toMatchObject({
        paymentStatus: 'PENDING',
        payments: [expect.objectContaining({ status: 'PENDING_VERIFICATION' })],
      });
      await as(cashier)
        .post(`/sale-payments/${s.payments[0].id}/confirm`)
        .expect(403);
      const pending = (
        await as(manager.token).get('/sales/pending-payments').expect(200)
      ).body.data;
      expect(pending.map((p: { id: string }) => p.id)).toContain(
        s.payments[0].id,
      );
      const ok = (
        await as(manager.token)
          .post(`/sale-payments/${s.payments[0].id}/confirm`, {})
          .expect(200)
      ).body;
      expect(ok.paymentStatus).toBe('PAID');
      await as(manager.token)
        .post(`/sale-payments/${s.payments[0].id}/confirm`, {})
        .expect(409);

      const split = (
        await sell(cashier, {
          lines: [{ productId: atta, qty: 1 }],
          payments: [
            cash('99'),
            { method: 'CARD', amount: '200', reference: 'APP123' },
          ],
        }).expect(201)
      ).body;
      const card = split.payments.find(
        (p: { method: string }) => p.method === 'CARD',
      );
      expect(
        (
          await as(manager.token)
            .post(`/sale-payments/${card.id}/fail`, {
              note: 'Declined on terminal',
            })
            .expect(200)
        ).body.paymentStatus,
      ).toBe('DUE');
      const events = await prisma.withTenant(A.tenantId, (tx) =>
        tx.paymentTransaction.findMany({
          where: { paymentId: card.id },
          orderBy: { createdAt: 'asc' },
        }),
      );
      expect(events.map((e) => e.event)).toEqual(['RECORDED', 'FAILED']);
      await expect(
        prisma.withTenant(
          A.tenantId,
          (tx) =>
            tx.$executeRaw`UPDATE payment_transactions SET amount = 0 WHERE payment_id = ${card.id}::uuid`,
        ),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('returns and voids', () => {
    let sale: {
      id: string;
      items: { id: string; productId: string; name: string }[];
    };
    const line = (pid: string) =>
      sale.items.find((i) => i.productId === pid)!.id;

    beforeAll(async () => {
      sale = (
        await sell(cashier, {
          lines: [
            { productId: milk, qty: 3 },
            { productId: cola, qty: 2 },
          ],
          payments: [cash('171')],
        }).expect(201)
      ).body;
    });

    it('a partial return: credit note, refund at the charged price, stock back', async () => {
      const before = await stockOf(A, milk);
      const r = (
        await as(cashier)
          .post(`/sales/${sale.id}/returns`, {
            reason: 'CHANGED_MIND',
            items: [{ saleItemId: line(milk), qty: 1 }],
          })
          .expect(201)
      ).body;
      expect(r).toMatchObject({
        creditNoteNo: `ANR1/${FY}/C0001`,
        refund: { method: 'CASH', amount: '27.00', status: 'COMPLETED' },
      });
      expect(Number(await stockOf(A, milk))).toBe(Number(before) + 1);
      await as(cashier)
        .post(`/sales/${sale.id}/returns`, {
          reason: 'CHANGED_MIND',
          items: [{ saleItemId: line(milk), qty: 3 }],
        })
        .expect(422);
    });

    it('damaged goods come back and are written off', async () => {
      const before = await stockOf(A, cola);
      await as(cashier)
        .post(`/sales/${sale.id}/returns`, {
          reason: 'DAMAGED',
          items: [{ saleItemId: line(cola), qty: 1 }],
        })
        .expect(201);
      expect(await stockOf(A, cola)).toBe(before);
      const moves = (
        await as(A.token)
          .get(`/stores/${A.storeId}/stock-movements?productId=${cola}&limit=2`)
          .expect(200)
      ).body.data;
      expect(moves.map((m: { type: string }) => m.type)).toEqual([
        'WRITE_OFF',
        'SALE_RETURN',
      ]);
    });

    it('the last return refunds exactly what is left and marks the bill refunded', async () => {
      const r = (
        await as(cashier)
          .post(`/sales/${sale.id}/returns`, {
            reason: 'QUALITY',
            items: [
              { saleItemId: line(milk), qty: 2 },
              { saleItemId: line(cola), qty: 1 },
            ],
          })
          .expect(201)
      ).body;
      expect(r.refund.amount).toBe('99.00'); // 171 − 27 − 45
      expect(r.sale).toMatchObject({
        refunded: '171.00',
        paymentStatus: 'REFUNDED',
      });
      expect(
        (await as(cashier).get(`/sales/${sale.id}/receipt`)).body.creditNotes,
      ).toHaveLength(3);
    });

    it('large refunds need a manager', async () => {
      const big = (
        await sell(cashier, {
          lines: [{ productId: atta, qty: 8 }],
          payments: [cash('2392')],
        }).expect(201)
      ).body;
      const body = {
        reason: 'WRONG_ITEM',
        items: [{ saleItemId: big.items[0].id, qty: 8 }],
      };
      expect(
        (await as(cashier).post(`/sales/${big.id}/returns`, body).expect(403))
          .body.error.code,
      ).toBe('APPROVAL_REQUIRED');
      const ok = (
        await as(cashier)
          .post(`/sales/${big.id}/returns`, {
            ...body,
            approval: { userId: manager.userId, pin: '5678' },
          })
          .expect(201)
      ).body;
      expect(ok).toMatchObject({
        approvedByUserId: manager.userId,
        refund: { amount: '2392.00' },
      });
    });

    it('a void cancels the sale, returns the stock and keeps the number', async () => {
      const s = (
        await sell(cashier, {
          lines: [{ productId: tomato, qty: '1.250' }],
          payments: [cash('50')],
        }).expect(201)
      ).body;
      const before = await stockOf(A, tomato);
      await as(cashier)
        .post(`/sales/${s.id}/void`, { reason: 'Wrong bill' })
        .expect(403);
      // The till's "ask a manager" list: who can approve here with a PIN — not the cashier.
      const approvers = (
        await as(cashier)
          .get('/sales/approvers')
          .query({ permission: 'sales:void' })
          .expect(200)
      ).body.data as { userId: string; name: string }[];
      expect(approvers).toEqual([{ userId: manager.userId, name: 'Ravi' }]);
      expect(
        (
          await as(A.token)
            .get('/sales/approvers')
            .query({ permission: 'sales:void', storeId: A.storeId })
            .expect(200)
        ).body.data,
      ).toEqual(approvers);
      await as(B.token)
        .get('/sales/approvers')
        .query({ permission: 'sales:void', storeId: A.storeId })
        .expect(404);
      await as(cashier)
        .get('/sales/approvers')
        .query({ permission: 'users:manage' })
        .expect(400);
      const v = (
        await as(cashier)
          .post(`/sales/${s.id}/void`, {
            reason: 'Wrong bill',
            approval: { userId: manager.userId, pin: '5678' },
          })
          .expect(200)
      ).body;
      expect(v).toMatchObject({
        status: 'VOIDED',
        paymentStatus: 'REFUNDED',
        voided: { byUserId: manager.userId },
      });
      expect(Number(await stockOf(A, tomato))).toBeCloseTo(
        Number(before) + 1.25,
        3,
      );
      expect(
        (await as(cashier).get(`/sales/${s.id}/receipt`)).body.status,
      ).toBe('CANCELLED');
      expect(
        (await as(cashier).get(`/sales/${s.id}/receipt.html`)).text,
      ).toContain('CANCELLED');
      await as(manager.token)
        .post(`/sales/${s.id}/void`, { reason: 'again' })
        .expect(409);
      await as(manager.token)
        .post(`/sales/${sale.id}/void`, { reason: 'has returns' })
        .expect(409);
    });
  });

  describe('closing the drawer', () => {
    it('expected cash = float + cash taken − change − cash refunds ± pay-ins/outs; a big variance waits for a manager', async () => {
      const cur = (await as(cashier).get('/cash-sessions/current').expect(200))
        .body;
      await as(cashier)
        .post(`/cash-sessions/${cur.id}/movements`, {
          type: 'PAY_OUT',
          amount: '999999',
          reason: 'too much',
        })
        .expect(409);
      await as(cashier)
        .post(`/cash-sessions/${cur.id}/movements`, {
          type: 'PAY_OUT',
          amount: '100',
          reason: 'Tea and snacks',
        })
        .expect(201);
      const live = (await as(cashier).get('/cash-sessions/current').expect(200))
        .body;
      const expected =
        Number(live.openingFloat) +
        Number(live.cashSales) -
        Number(live.cashRefunds) -
        100;
      expect(Number(live.expectedCash)).toBeCloseTo(expected, 2);
      expect(Number(live.upi.settled)).toBe(299);
      const counted = (expected - 500).toFixed(2);
      await as(cashier)
        .post(`/cash-sessions/${cur.id}/close`, {
          countedCash: counted,
          denominations: { '500': 1 },
        })
        .expect(409); // notes don't add up
      const closed = (
        await as(cashier)
          .post(`/cash-sessions/${cur.id}/close`, { countedCash: counted })
          .expect(200)
      ).body;
      expect(closed).toMatchObject({
        status: 'PENDING_REVIEW',
        variance: '-500.00',
        cashier: 'Kavitha',
        counter: { number: 1 },
      });
      await sell(cashier, {
        lines: [{ productId: milk, qty: 1 }],
        payments: [cash('27')],
      }).expect(409); // drawer closed
      await as(cashier)
        .post(`/cash-sessions/${cur.id}/review`, { note: 'ok' })
        .expect(403);
      expect(
        (
          await as(manager.token)
            .post(`/cash-sessions/${cur.id}/review`, {
              note: 'Short-changed customer refunded next day',
            })
            .expect(200)
        ).body,
      ).toMatchObject({ status: 'CLOSED', review: { by: 'Ravi' } });
    });

    it('cashier-wise report for the day', async () => {
      const rep = (await as(manager.token).get('/reports/cashiers').expect(200))
        .body.data;
      const k = rep.find(
        (r: { cashier: { name: string } }) => r.cashier.name === 'Kavitha',
      );
      expect(k).toMatchObject({ voided: 1, drawerVariance: '-500.00' });
      expect(k.bills).toBeGreaterThan(5);
    });
  });

  describe('isolation and consistency', () => {
    it('cashiers see their own bills; other businesses see nothing', async () => {
      const own = (
        await sell(A.token, {
          counterId: counter2,
          lines: [{ productId: milk, qty: 1 }],
          payments: [cash('27')],
        }).expect(201)
      ).body;
      await as(cashier).get(`/sales/${own.id}`).expect(404);
      await as(B.token).get(`/sales/${own.id}`).expect(404);
      await as(B.token)
        .post(`/sales/${own.id}/returns`, {
          reason: 'OTHER',
          items: [{ saleItemId: own.items[0].id, qty: 1 }],
        })
        .expect(404);
      const pay = own.payments[0].id;
      await as(B.token).post(`/sale-payments/${pay}/confirm`, {}).expect(404);
    });

    it('the sales summary adds up to the sales net of refunds', async () => {
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
      }).format(new Date());
      const r = (
        await as(A.token)
          .get(
            `/reports/sales-summary?from=${today}&to=${today}&storeId=${A.storeId}`,
          )
          .expect(200)
      ).body;
      const [row] = await prisma.withTenant(
        A.tenantId,
        (tx) =>
          tx.$queryRaw<{ net: string }[]>`
          SELECT ((SELECT COALESCE(SUM(payable), 0) FROM sales WHERE status = 'COMPLETED')
                - (SELECT COALESCE(SUM(refund_amount), 0) FROM sale_returns))::text AS net`,
      );
      expect(Number(r.totals.revenue)).toBeCloseTo(Number(row!.net), 2);
      expect(r.totals.bills).toBeGreaterThan(5);
      expect(r.daily).toHaveLength(1);
      expect(r.byProduct.length).toBeGreaterThan(3);
      expect(r.totals).toHaveProperty('profit');
      await as(cashier)
        .get(`/reports/sales-summary?from=${today}&to=${today}`)
        .expect(403);
    });

    it('every sale has matching lines, payments, invoice and stock movements', async () => {
      await assertSalesConsistent(A.tenantId);
      expect(
        (await as(A.token).get('/stock/reconciliation').expect(200)).body.ok,
      ).toBe(true);
    });
  });
});
