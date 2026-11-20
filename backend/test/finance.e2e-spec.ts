import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp } from './utils.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { gstinCheckChar } from '../src/common/gst.js';
import {
  PAYMENT_GATEWAY,
  RazorpayGateway,
} from '../src/subscriptions/payment-gateway.js';

const PASSWORD = 'correct-horse-battery';
const WEBHOOK_SECRET = 'whsec_test_0123456789';
const native = { 'X-Client': 'native' };
const gstin = (state: string) => {
  const L = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const first14 = `${state}${L()}${L()}${L()}P${L()}${String(Math.floor(Math.random() * 9000) + 1000)}${L()}1Z`;
  return first14 + gstinCheckChar(first14);
};
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
}).format(new Date());

/** Razorpay as far as checkout goes: orders are made up, webhook signatures are the real check. */
class TestGateway extends RazorpayGateway {
  override createOrder(o: { amount: number; currency: string }) {
    const orderId = `order_${randomUUID().slice(0, 14)}`;
    return Promise.resolve({
      orderId,
      checkout: {
        keyId: 'rzp_test',
        orderId,
        amount: o.amount,
        currency: o.currency,
      },
    });
  }
}

type Biz = {
  gstin: string;
  tenantId: string;
  storeId: string;
  counterId: string;
  token: string;
  units: Record<string, string>;
  taxes: Record<string, string>;
};

describe('Phase 10 — reports, finance and subscriptions (e2e)', () => {
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
    patch: (url: string, body: object) =>
      http()
        .patch(`/api/v1${url}`)
        .set('Authorization', `Bearer ${t}`)
        .send(body),
  });

  async function register(name: string, code: string): Promise<Biz> {
    const own = gstin('33');
    const res = await http()
      .post('/api/v1/tenants')
      .set(native)
      .send({
        business: {
          displayName: name,
          businessType: 'supermarket',
          registration: 'REGULAR',
          gstin: own,
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
      gstin: own,
      tenantId: res.body.tenant.id,
      storeId: res.body.store.id,
      counterId: res.body.counter.id,
      token,
      units,
      taxes,
    };
  }

  const setSubscription = (tenantId: string, data: Record<string, unknown>) =>
    prisma.withTenant(tenantId, (tx) =>
      tx.subscription.update({ where: { tenantId }, data }),
    );

  const signed = (body: object, eventId = `evt_${randomUUID()}`) => {
    const raw = JSON.stringify(body);
    return http()
      .post('/api/v1/webhooks/payments/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Event-Id', eventId)
      .set(
        'X-Razorpay-Signature',
        createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
      )
      .send(raw);
  };
  const captured = (
    orderId: string,
    amount: number,
    notes: Record<string, string>,
  ) => ({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: `pay_${randomUUID().slice(0, 12)}`,
          order_id: orderId,
          amount,
          currency: 'INR',
          status: 'captured',
          notes,
        },
      },
    },
  });

  let A: Biz;
  let staples: string, dairy: string;
  let rice: string, dal: string, ghee: string, milk: string;

  beforeAll(async () => {
    app = await createTestApp([
      {
        provide: PAYMENT_GATEWAY,
        useValue: new TestGateway('rzp_test', 'key_secret', WEBHOOK_SECRET),
      },
    ]);
    prisma = app.get(PrismaService);
    A = await register('Ledger Mart', 'LDG');
    staples = (
      await as(A.token).post('/categories', { name: 'Staples' }).expect(201)
    ).body.id;
    dairy = (
      await as(A.token).post('/categories', { name: 'Dairy' }).expect(201)
    ).body.id;
    const rices = (
      await as(A.token)
        .post('/categories', { name: 'Rice', parentId: staples })
        .expect(201)
    ).body.id;
    const product = async (over: Record<string, unknown>) =>
      (
        await as(A.token)
          .post('/products', {
            sku: `P-${randomUUID().slice(0, 8)}`,
            unitId: A.units['PCS'],
            taxRateId: A.taxes['GST 5%'],
            ...over,
          })
          .expect(201)
      ).body.id as string;
    rice = await product({
      name: 'Ponni Rice 5kg',
      categoryId: rices,
      sellingPrice: '415',
      mrp: '450',
      hsnCode: '1006',
    });
    dal = await product({
      name: 'Toor Dal 1kg',
      categoryId: staples,
      sellingPrice: '159',
      mrp: '170',
      hsnCode: '0713',
    });
    ghee = await product({
      name: 'Ghee 500ml',
      categoryId: dairy,
      taxRateId: A.taxes['GST 18%'],
      sellingPrice: '349',
      mrp: '375',
      hsnCode: '0405',
    });
    milk = await product({
      name: 'Milk 500ml',
      categoryId: dairy,
      taxRateId: A.taxes['GST 0% (nil-rated)'],
      sellingPrice: '27',
      mrp: '27',
      hsnCode: '0401',
    });
    await as(A.token)
      .post(`/stores/${A.storeId}/stock-adjustments`, {
        reason: 'OPENING',
        items: [
          { productId: rice, qty: 40, unitCost: '360' },
          { productId: dal, qty: 50, unitCost: '130' },
          { productId: ghee, qty: 20, unitCost: '290' },
          { productId: milk, qty: 100, unitCost: '24' },
        ],
      })
      .expect(201);
    await as(A.token)
      .post('/cash-sessions', { counterId: A.counterId, openingFloat: '1000' })
      .expect(201);
  });
  afterAll(async () => {
    await app.close();
  });

  const sell = (lines: object[], payments: object[], extra: object = {}) =>
    as(A.token).post('/sales', {
      counterId: A.counterId,
      lines,
      payments,
      ...extra,
    });
  const cash = (amount: string) => ({ method: 'CASH', amount });

  describe('subscription and plans', () => {
    it('plans are public; a new business is on a 14-day trial of the Business plan', async () => {
      const plans = (await http().get('/api/v1/plans').expect(200)).body;
      expect(plans.data.map((p: { code: string }) => p.code)).toEqual([
        'starter',
        'growth',
        'business',
      ]);
      expect(plans.data[0]).toMatchObject({
        priceMonthly: '499.00',
        gstPct: 18,
        limits: { branches: 1, counters: 2, users: 5 },
      });
      const s = (await as(A.token).get('/subscription').expect(200)).body;
      expect(s).toMatchObject({
        status: 'TRIALING',
        writable: true,
        plan: { code: 'business' },
        usage: { branches: 1, counters: 1, users: 1 },
        limits: { branches: 10 },
      });
      const days = (Date.parse(s.trialEndsAt) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThanOrEqual(14);
    });
  });

  describe('credit (khata) sales', () => {
    let customer: string;
    let creditSale: { id: string; invoiceNo: string; items: { id: string }[] };

    it('a customer with a credit limit buys on account', async () => {
      customer = (
        await as(A.token)
          .post('/customers', {
            name: 'Hotel Saravana',
            phone: '9840012345',
            creditLimit: '2000',
            openingBalance: '300',
          })
          .expect(201)
      ).body.id;
      await as(A.token)
        .post('/customers', { name: 'Someone else', phone: '9840012345' })
        .expect(409);
      creditSale = (
        await sell(
          [{ productId: rice, qty: 2 }],
          [cash('230'), { method: 'CREDIT', amount: '600' }],
          { customerId: customer },
        ).expect(201)
      ).body;
      expect(creditSale).toMatchObject({
        paymentStatus: 'CREDIT',
        customerId: customer,
        buyer: { name: 'Hotel Saravana' },
      });
      expect(
        (await as(A.token).get(`/customers/${customer}`).expect(200)).body,
      ).toMatchObject({ balance: '900.00', creditAvailable: '1100.00' });
    });

    it('credit needs a customer and stays within the limit', async () => {
      expect(
        (
          await sell(
            [{ productId: dal, qty: 1 }],
            [{ method: 'CREDIT', amount: '159' }],
          ).expect(422)
        ).body.error.code,
      ).toBe('CUSTOMER_REQUIRED');
      const over = await sell(
        [{ productId: rice, qty: 3 }],
        [{ method: 'CREDIT', amount: '1245' }],
        { customerId: customer },
      ).expect(422);
      expect(over.body.error).toMatchObject({
        code: 'CREDIT_LIMIT',
        message: expect.stringContaining('900.00'),
      });
    });

    it('a return goes back onto the account; a receipt in cash goes into the drawer', async () => {
      const r = (
        await as(A.token)
          .post(`/sales/${creditSale.id}/returns`, {
            counterId: A.counterId,
            reason: 'CHANGED_MIND',
            refundMethod: 'CREDIT',
            items: [{ saleItemId: creditSale.items[0]!.id, qty: 1 }],
          })
          .expect(201)
      ).body;
      expect(r.refund).toMatchObject({
        method: 'CREDIT',
        amount: '415.00',
        status: 'COMPLETED',
      });
      const before = (
        await as(A.token).get('/cash-sessions/current').expect(200)
      ).body;
      const rc = (
        await as(A.token)
          .post(`/customers/${customer}/receipts`, {
            amount: '285',
            method: 'CASH',
          })
          .expect(201)
      ).body;
      expect(rc).toMatchObject({
        number: 'RCPT-00001',
        balanceAfter: '200.00',
        cashSessionId: before.id,
      });
      const after = (
        await as(A.token).get('/cash-sessions/current').expect(200)
      ).body;
      expect(Number(after.expectedCash) - Number(before.expectedCash)).toBe(
        285,
      );
      const ledger = (
        await as(A.token).get(`/customers/${customer}/ledger`).expect(200)
      ).body.data;
      expect(
        ledger.map((l: { type: string; amount: string }) => [l.type, l.amount]),
      ).toEqual([
        ['RECEIPT', '-285.00'],
        ['RETURN', '-415.00'],
        ['SALE', '600.00'],
        ['OPENING', '300.00'],
      ]);
      const recv = (await as(A.token).get('/reports/receivables').expect(200))
        .body;
      expect(recv).toMatchObject({
        total: '200.00',
        data: [expect.objectContaining({ balance: '200.00', ageing: '0-30' })],
      });
      await expect(
        prisma.withTenant(
          A.tenantId,
          (tx) =>
            tx.$executeRaw`UPDATE customer_transactions SET amount = 0 WHERE customer_id = ${customer}::uuid`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('voiding a credit sale takes it off the account', async () => {
      const s = (
        await sell(
          [{ productId: dal, qty: 1 }],
          [{ method: 'CREDIT', amount: '159' }],
          { customerId: customer },
        ).expect(201)
      ).body;
      expect(
        (await as(A.token).get(`/customers/${customer}`)).body.balance,
      ).toBe('359.00');
      await as(A.token)
        .post(`/sales/${s.id}/void`, { reason: 'Wrong customer' })
        .expect(200);
      expect(
        (await as(A.token).get(`/customers/${customer}`)).body.balance,
      ).toBe('200.00');
    });

    it('an offline bill can’t be on credit', async () => {
      const { offlineSaleTxn } = await import('../src/sync/sync.schemas.js');
      const parsed = offlineSaleTxn.safeParse({
        id: randomUUID(),
        type: 'SALE',
        occurredAt: new Date().toISOString(),
        cashierUserId: randomUUID(),
        invoiceNo: 'X/2627/00001',
        documentType: 'TAX_INVOICE',
        lines: [
          { productId: randomUUID(), qty: '1', unitPrice: '10.00', gstRate: 5 },
        ],
        payments: [{ method: 'CREDIT', amount: '10' }],
        payable: '10',
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('expenses', () => {
    let category: string;
    let expense: string;

    it('categories exist from the start; cash from the drawer is a pay-out of it', async () => {
      const cats = (await as(A.token).get('/expense-categories').expect(200))
        .body.data as { id: string; name: string }[];
      expect(cats.map((c) => c.name)).toContain('Electricity');
      category = cats.find((c) => c.name === 'Tea & refreshments')!.id;
      await as(A.token)
        .post('/expense-categories', { name: 'electricity' })
        .expect(409);
      const before = Number(
        (await as(A.token).get('/cash-sessions/current')).body.expectedCash,
      );
      const e = (
        await as(A.token)
          .post('/expenses', {
            storeId: A.storeId,
            categoryId: category,
            amount: '120',
            mode: 'CASH',
            payee: 'Tea stall',
            fromDrawer: true,
          })
          .expect(201)
      ).body;
      expense = e.id;
      expect(e).toMatchObject({
        number: 'EXP-00001',
        amount: '120.00',
        spentOn: TODAY,
        cashSessionId: expect.any(String),
      });
      expect(
        Number(
          (await as(A.token).get('/cash-sessions/current')).body.expectedCash,
        ),
      ).toBe(before - 120);
      expect(
        (
          await as(A.token)
            .post('/expenses', {
              storeId: A.storeId,
              categoryId: category,
              amount: '999999',
              mode: 'CASH',
              fromDrawer: true,
            })
            .expect(409)
        ).body.error.code,
      ).toBe('INSUFFICIENT_CASH');
      await as(A.token)
        .post('/expenses', {
          storeId: A.storeId,
          categoryId: cats.find((c) => c.name === 'Electricity')!.id,
          amount: '4720',
          gstAmount: '720',
          mode: 'BANK_TRANSFER',
          reference: 'TNEB-NOV',
        })
        .expect(201);
    });

    it('a void reverses its drawer pay-out', async () => {
      const before = Number(
        (await as(A.token).get('/cash-sessions/current')).body.expectedCash,
      );
      await as(A.token)
        .post(`/expenses/${expense}/void`, { reason: 'Entered twice' })
        .expect(200);
      expect(
        Number(
          (await as(A.token).get('/cash-sessions/current')).body.expectedCash,
        ),
      ).toBe(before + 120);
      await as(A.token)
        .post(`/expenses/${expense}/void`, { reason: 'again' })
        .expect(409);
      await as(A.token)
        .post('/expenses', {
          storeId: A.storeId,
          categoryId: category,
          amount: '80',
          mode: 'CASH',
          fromDrawer: true,
        })
        .expect(201);
    });
  });

  describe('reports reconcile with the transactions', () => {
    const range = `from=${TODAY}&to=${TODAY}`;

    beforeAll(async () => {
      // A mixed day: tax slabs, a discount, a B2B buyer, UPI waiting for verification, a partial return.
      await sell(
        [
          { productId: rice, qty: 1 },
          { productId: milk, qty: 4 },
        ],
        [cash('523')],
      ).expect(201);
      await sell(
        [{ productId: ghee, qty: 2, discount: { kind: 'PCT', value: '5' } }],
        [cash('663')],
      ).expect(201);
      await sell(
        [{ productId: dal, qty: 3 }],
        [{ method: 'UPI', amount: '477', reference: 'UTR1' }],
        { buyer: { name: 'Kalyan Caterers', gstin: gstin('29') } },
      ).expect(201);
      const s = (
        await sell(
          [
            { productId: rice, qty: 1 },
            { productId: dal, qty: 2 },
          ],
          [cash('733')],
        ).expect(201)
      ).body;
      await as(A.token)
        .post(`/sales/${s.id}/returns`, {
          counterId: A.counterId,
          reason: 'DAMAGED',
          items: [{ saleItemId: s.items[1].id, qty: 1 }],
        })
        .expect(201);
    });

    const truth = () =>
      prisma.withTenant(A.tenantId, async (tx) => {
        const [r] = await tx.$queryRaw<
          { net: string; taxable: string; bills: number; stock: string }[]
        >`
          SELECT ((SELECT COALESCE(SUM(payable), 0) FROM sales WHERE status = 'COMPLETED')
                - (SELECT COALESCE(SUM(refund_amount), 0) FROM sale_returns))::text AS net,
                 ((SELECT COALESCE(SUM(taxable), 0) FROM sales WHERE status = 'COMPLETED')
                - (SELECT COALESCE(SUM(taxable), 0) FROM sale_returns))::text AS taxable,
                 (SELECT COUNT(*) FROM sales WHERE status = 'COMPLETED')::int AS bills,
                 (SELECT COALESCE(SUM(qty * avg_cost), 0) FROM stock_balances WHERE qty > 0)::numeric(14,2)::text AS stock`;
        return r!;
      });

    it('sales, dashboard, branches/counters and products agree on net sales', async () => {
      const t = await truth();
      const sales = (
        await as(A.token).get(`/reports/sales?${range}`).expect(200)
      ).body;
      expect(sales.totals).toMatchObject({
        netSales: Number(t.net).toFixed(2),
        taxable: Number(t.taxable).toFixed(2),
        bills: t.bills,
      });
      expect(Number(sales.totals.grossProfit)).toBeCloseTo(
        Number(sales.totals.taxable) - Number(sales.totals.costOfGoods),
        2,
      );
      expect(
        sales.periods.reduce(
          (x: number, p: { netSales: string }) => x + Number(p.netSales),
          0,
        ),
      ).toBeCloseTo(Number(t.net), 2);
      const month = (
        await as(A.token)
          .get(`/reports/sales?${range}&groupBy=month`)
          .expect(200)
      ).body;
      expect(month.periods[0].netSales).toBe(sales.totals.netSales);

      const dash = (
        await as(A.token).get(`/reports/sales-summary?${range}`).expect(200)
      ).body;
      expect(dash.totals.revenue).toBe(sales.totals.netSales);
      expect(dash.totals.profit).toBe(sales.totals.grossProfit);

      const loc = (
        await as(A.token).get(`/reports/sales-by-location?${range}`).expect(200)
      ).body;
      expect(loc.totals.netSales).toBe(sales.totals.netSales);
      expect(loc.stores[0].counters[0].netSales).toBe(sales.totals.netSales);

      const products = (
        await as(A.token).get(`/reports/products?${range}`).expect(200)
      ).body;
      expect(products.reconciliation).toMatchObject({
        netSales: sales.totals.netSales,
        matches: true,
      });
      expect(products.totals.profit).toBe(sales.totals.grossProfit);
      const cats = (
        await as(A.token).get(`/reports/categories?${range}`).expect(200)
      ).body;
      expect(cats.totals.revenue).toBe(products.totals.revenue);
      expect(cats.data.map((c: { name: string }) => c.name).sort()).toEqual([
        'Dairy',
        'Staples',
      ]);
      const onlyStaples = (
        await as(A.token)
          .get(`/reports/products?${range}&categoryId=${staples}`)
          .expect(200)
      ).body;
      expect(onlyStaples.totals.revenue).toBe(
        cats.data.find((c: { name: string }) => c.name === 'Staples').revenue,
      );
    });

    it('GST summary: taxable value by rate adds up to the net taxable sales', async () => {
      const t = await truth();
      const g = (await as(A.token).get(`/reports/gst?${range}`).expect(200))
        .body;
      const net = g.outward.reduce(
        (x: number, s: { net: { taxable: string } }) =>
          x + Number(s.net.taxable),
        0,
      );
      expect(net).toBeCloseTo(Number(t.taxable), 2);
      expect(g.outward.map((s: { rate: number }) => s.rate)).toEqual([
        0, 5, 18,
      ]);
      expect(g.b2b).toMatchObject({
        invoices: 1,
        list: [expect.objectContaining({ placeOfSupply: '29' })],
      });
      expect(
        Number(g.outward.find((s: { rate: number }) => s.rate === 5).net.igst),
      ).toBeGreaterThan(0);
      expect(g.hsn.map((h: { hsn: string }) => h.hsn)).toEqual(
        expect.arrayContaining(['1006', '0713', '0405', '0401']),
      );
      const sales = (
        await as(A.token).get(`/reports/sales?${range}`).expect(200)
      ).body;
      expect(g.summary.outputTax).toBe(sales.totals.tax);
    });

    it('GSTR-1: the portal JSON adds up to the GST summary for the month', async () => {
      const month = TODAY.slice(0, 7);
      const g = (await as(A.token).get(`/reports/gst?from=${month}-01&to=${TODAY}`).expect(200)).body;
      const r = (await as(A.token).get(`/reports/gstr1?month=${month}`).expect(200)).body;
      const f = r.file;
      expect(f.fp).toBe(`${month.slice(5, 7)}${month.slice(0, 4)}`);
      expect(f.gstin).toMatch(/^33/);
      // The business buyer in Karnataka: one B2B invoice, IGST, place of supply 29.
      expect(f.b2b).toHaveLength(1);
      const inv = f.b2b[0].inv[0];
      expect(inv).toMatchObject({ pos: '29', rchrg: 'N', inv_typ: 'R' });
      expect(inv.idt).toMatch(/^\d{2}-\d{2}-\d{4}$/);
      expect(inv.itms.every((i: { itm_det: { iamt?: number; camt?: number } }) => i.itm_det.iamt !== undefined && i.itm_det.camt === undefined)).toBe(true);
      // Taxable value at GST rates > 0: invoices − credit notes = the GST summary's net.
      const tx = (rows: { itms: { itm_det: { txval: number } }[] }[] = []) => rows.flatMap((x) => x.itms).reduce((a, i) => a + i.itm_det.txval, 0);
      const b2cs = (f.b2cs ?? []).reduce((a: number, x: { txval: number }) => a + x.txval, 0);
      const cn = tx((f.cdnr ?? []).flatMap((c: { nt: unknown[] }) => c.nt)) + tx(f.cdnur);
      const rated = g.outward.filter((o: { rate: number }) => o.rate > 0).reduce((a: number, o: { net: { taxable: string } }) => a + Number(o.net.taxable), 0);
      expect(tx(f.b2b.flatMap((c: { inv: unknown[] }) => c.inv)) + tx((f.b2cl ?? []).flatMap((c: { inv: unknown[] }) => c.inv)) + b2cs - cn).toBeCloseTo(rated, 1);
      // 0% supplies go to Table 8, not to the invoice tables.
      const zero = g.outward.find((o: { rate: number }) => o.rate === 0);
      const nil = (f.nil?.inv ?? []).reduce((a: number, x: { nil_amt: number; expt_amt: number; ngsup_amt: number }) => a + x.nil_amt + x.expt_amt + x.ngsup_amt, 0);
      expect(nil).toBeCloseTo(Number(zero?.net.taxable ?? 0), 1);
      // HSN summary (B2B + B2C) covers every supply, all rates.
      const hsnTx = [...f.hsn.hsn_b2b, ...f.hsn.hsn_b2c].reduce((a: number, h: { txval: number }) => a + h.txval, 0);
      expect(hsnTx).toBeCloseTo(rated + Number(zero?.net.taxable ?? 0), 1);
      expect(f.hsn.hsn_b2b.every((h: { uqc: string }) => /^[A-Z]{3}$/.test(h.uqc))).toBe(true);
      // Documents issued: every invoice number of the month, in its series.
      const issued = f.doc_issue.doc_det.find((d: { doc_num: number }) => d.doc_num === 1).docs;
      expect(issued.reduce((a: number, d: { totnum: number }) => a + d.totnum, 0)).toBe(r.summary.documents.invoices);
      await as(A.token).get('/reports/gstr1?month=2026-13').expect(400);
      await as(A.token).get(`/reports/gstr1?month=${month}&gstin=29ABCDE1234F1Z5`).expect(404);
    });

    it('stock valuation, movements and money reports match the ledgers', async () => {
      const t = await truth();
      const v = (
        await as(A.token).get('/reports/inventory-valuation').expect(200)
      ).body;
      expect(v.totals.atCost).toBe(t.stock);
      expect(
        v.stores[0].categories.map((c: { name: string }) => c.name),
      ).toEqual(['Dairy', 'Staples']);
      const mv = (
        await as(A.token).get(`/reports/stock-movements?${range}`).expect(200)
      ).body;
      const opening = mv.data.find(
        (d: { type: string }) => d.type === 'OPENING',
      );
      expect(opening).toMatchObject({ qtyIn: '210.000' });
      expect(Number(mv.totals.shrinkageAtCost)).toBeCloseTo(130, 2); // the damaged dal, written off

      const pay = (
        await as(A.token)
          .get(`/reports/payment-reconciliation?${range}`)
          .expect(200)
      ).body;
      const upi = pay.tenders.find(
        (x: { method: string }) => x.method === 'UPI',
      );
      expect(upi).toMatchObject({
        pendingVerification: '477.00',
        settled: '0.00',
      });
      expect(
        pay.tenders.find((x: { method: string }) => x.method === 'CREDIT'),
      ).toMatchObject({
        recorded: '759.00',
        settled: '600.00',
        refunded: '159.00',
      });
      expect(pay.customerReceipts).toEqual([
        expect.objectContaining({ method: 'CASH', amount: '285.00' }),
      ]);

      const cs = (
        await as(A.token)
          .get(`/reports/cashier-performance?${range}`)
          .expect(200)
      ).body;
      expect(cs.data[0]).toMatchObject({ bills: t.bills, voids: 1 });

      const ex = (
        await as(A.token).get(`/reports/expenses?${range}`).expect(200)
      ).body;
      expect(ex.totals).toMatchObject({
        amount: '4800.00',
        gst: '720.00',
        count: 2,
      });

      const biz = (
        await as(A.token).get(`/reports/business-summary?${range}`).expect(200)
      ).body;
      const sales = (
        await as(A.token).get(`/reports/sales?${range}`).expect(200)
      ).body;
      expect(biz.sales).toMatchObject({
        netSales: sales.totals.netSales,
        grossProfit: sales.totals.grossProfit,
      });
      expect(biz.expenses).toMatchObject({
        total: '4800.00',
        counted: '4080.00',
      }); // GST on the power bill is claimable
      expect(Number(biz.operatingResult)).toBeCloseTo(
        Number(sales.totals.grossProfit) - 4080,
        2,
      );
      expect(biz.now).toMatchObject({
        receivable: '200.00',
        stockAtCost: t.stock,
      });
      expect(biz.credit).toMatchObject({
        givenOnAccount: '759.00',
        collected: '285.00',
      });
    });

    it('reports respect permissions and branches', async () => {
      const cashierEmail = `c-${randomUUID()}@example.test`;
      const m = await as(A.token)
        .post('/memberships', {
          name: 'Counter Cashier',
          email: cashierEmail,
          password: PASSWORD,
          roleKeys: ['cashier'],
          storeIds: [A.storeId],
        })
        .expect(201);
      expect(m.body.id).toBeDefined();
      const login = await http()
        .post('/api/v1/auth/login')
        .set(native)
        .send({ email: cashierEmail, password: PASSWORD })
        .expect(200);
      const c = login.body.accessToken as string;
      await as(c).get(`/reports/sales?${range}`).expect(403);
      await as(c).get(`/reports/gst?${range}`).expect(403);
      await as(c).get(`/reports/gstr1?month=${TODAY.slice(0, 7)}`).expect(403);
      await as(c).get(`/reports/expenses?${range}`).expect(403);
      await as(A.token)
        .get(`/reports/sales?from=${TODAY}&to=2020-01-01`)
        .expect(400);
    });
  });

  describe('subscription payments and entitlements', () => {
    let B: Biz;
    let invoice: { id: string; total: string; number: string };
    let orderId: string;

    beforeAll(async () => {
      B = await register('Tiny Shop', 'TNY');
    });

    it('checkout makes an invoice (plan + 18% GST) and a provider order; nothing changes until the webhook', async () => {
      const r = (
        await as(B.token)
          .post('/subscription/checkout', {
            plan: 'starter',
            interval: 'MONTHLY',
          })
          .expect(201)
      ).body;
      invoice = r.invoice;
      orderId = r.checkout.orderId;
      expect(r.invoice).toMatchObject({
        status: 'OPEN',
        amount: '499.00',
        gst: '89.82',
        total: '588.82',
        number: expect.stringMatching(/^SUB\/\d{4}\/\d{6}$/),
      });
      expect(r.checkout).toMatchObject({
        provider: 'razorpay',
        amount: 58882,
        currency: 'INR',
      });
      expect((await as(B.token).get('/subscription')).body).toMatchObject({
        status: 'TRIALING',
        plan: { code: 'business' },
      });
    });

    it('webhooks: a bad signature is refused, a wrong amount doesn’t pay, a verified capture activates once', async () => {
      const notes = { tenantId: B.tenantId, invoiceId: invoice.id };
      const body = captured(orderId, 58882, notes);
      await http()
        .post('/api/v1/webhooks/payments/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', 'f'.repeat(64))
        .send(JSON.stringify(body))
        .expect(401);
      const wrong = (await signed(captured(orderId, 100, notes)).expect(200))
        .body;
      expect(wrong.result).toMatch(/^refused/);
      expect((await as(B.token).get('/subscription')).body.status).toBe(
        'TRIALING',
      );

      const evt = `evt_${randomUUID()}`;
      const ok = (await signed(body, evt).expect(200)).body;
      expect(ok).toMatchObject({
        duplicate: false,
        result: expect.stringContaining('paid: starter'),
      });
      const again = (await signed(body, evt).expect(200)).body;
      expect(again).toMatchObject({ duplicate: true });
      const other = (await signed({ ...body, event: 'order.paid' }).expect(200))
        .body; // Razorpay sends both
      expect(other.result).toMatch(/already paid/);

      const s = (await as(B.token).get('/subscription').expect(200)).body;
      expect(s).toMatchObject({
        status: 'ACTIVE',
        plan: { code: 'starter' },
        interval: 'MONTHLY',
        limits: { branches: 1, counters: 2, users: 5 },
      });
      const days = (Date.parse(s.currentPeriodEnd) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(27);
      expect(days).toBeLessThan(32);
      const inv = (await as(B.token).get('/subscription/invoices').expect(200))
        .body.data;
      expect(inv[0]).toMatchObject({ number: invoice.number, status: 'PAID' });
    });

    it('the plan’s limits are enforced: branches, counters, users', async () => {
      const store = {
        code: 'TN2',
        name: 'Second',
        gstin: B.gstin,
        address: {
          line1: '2 Road',
          city: 'Chennai',
          pincode: '600002',
          stateCode: '33',
        },
      };
      expect(
        (await as(B.token).post('/stores', store).expect(403)).body.error.code,
      ).toBe('PLAN_LIMIT_REACHED');
      await as(B.token)
        .post(`/stores/${B.storeId}/counters`, { name: 'Counter 2' })
        .expect(201);
      expect(
        (
          await as(B.token)
            .post(`/stores/${B.storeId}/counters`, { name: 'Counter 3' })
            .expect(403)
        ).body.error.message,
      ).toMatch(/Starter plan includes 2/);
      for (let i = 0; i < 4; i++)
        await as(B.token)
          .post('/memberships', {
            name: `Staff ${i}`,
            email: `s${i}-${randomUUID()}@example.test`,
            password: PASSWORD,
            roleKeys: ['cashier'],
            storeIds: [B.storeId],
          })
          .expect(201);
      await as(B.token)
        .post('/memberships', {
          name: 'One too many',
          email: `x-${randomUUID()}@example.test`,
          password: PASSWORD,
          roleKeys: ['cashier'],
          storeIds: [B.storeId],
        })
        .expect(403);
    });

    it('renewing the same plan extends from the end of the paid period', async () => {
      const before = (await as(B.token).get('/subscription')).body
        .currentPeriodEnd;
      const r = (
        await as(B.token)
          .post('/subscription/checkout', { plan: 'starter' })
          .expect(201)
      ).body;
      await signed(
        captured(r.checkout.orderId, 58882, {
          tenantId: B.tenantId,
          invoiceId: r.invoice.id,
        }),
      ).expect(200);
      const after = (await as(B.token).get('/subscription')).body;
      const added =
        (Date.parse(after.currentPeriodEnd) - Date.parse(before)) / 86_400_000;
      expect(added).toBeGreaterThanOrEqual(28);
      expect(added).toBeLessThanOrEqual(31);
    });

    it('a smaller plan than what is in use is refused', async () => {
      const C = await register('Two Branch Mart', 'TWO');
      await as(C.token)
        .post('/stores', {
          code: 'TW2',
          name: 'Second',
          gstin: C.gstin,
          address: {
            line1: '2 Road',
            city: 'Chennai',
            pincode: '600002',
            stateCode: '33',
          },
        })
        .expect(201);
      const r = await as(C.token)
        .post('/subscription/checkout', { plan: 'starter' })
        .expect(409);
      expect(r.body.error).toMatchObject({
        code: 'PLAN_TOO_SMALL',
        details: [expect.objectContaining({ field: 'branches' })],
      });
    });
  });

  describe('grace and lapse', () => {
    let D: Biz;
    beforeAll(async () => {
      D = await register('Lapsing Mart', 'LPS');
    });
    const day = 86_400_000;

    it('after the trial, 7 days of grace with everything working, then read-only', async () => {
      await setSubscription(D.tenantId, {
        trialEndsAt: new Date(Date.now() - 3 * day),
      });
      expect(
        (await as(D.token).get('/subscription').expect(200)).body,
      ).toMatchObject({ status: 'PAST_DUE', writable: true });
      await as(D.token)
        .post('/customers', { name: 'Works in grace' })
        .expect(201);

      await setSubscription(D.tenantId, {
        trialEndsAt: new Date(Date.now() - 8 * day),
      });
      const s = (await as(D.token).get('/subscription').expect(200)).body;
      expect(s).toMatchObject({ status: 'EXPIRED', writable: false });
      const refused = await as(D.token)
        .post('/customers', { name: 'Refused' })
        .expect(402);
      expect(refused.body.error.code).toBe('SUBSCRIPTION_INACTIVE');
      // Still visible, still payable, still able to sign out.
      await as(D.token).get('/customers').expect(200);
      await as(D.token)
        .get(`/reports/sales?from=${TODAY}&to=${TODAY}`)
        .expect(200);
      await as(D.token)
        .post('/subscription/checkout', { plan: 'growth' })
        .expect(201);
    });

    it('paying a lapsed business starts a fresh period and writing works again', async () => {
      const r = (
        await as(D.token)
          .post('/subscription/checkout', {
            plan: 'growth',
            interval: 'YEARLY',
          })
          .expect(201)
      ).body;
      expect(r.invoice).toMatchObject({
        amount: '12990.00',
        total: '15328.20',
      });
      await signed(
        captured(r.checkout.orderId, 1532820, {
          tenantId: D.tenantId,
          invoiceId: r.invoice.id,
        }),
      ).expect(200);
      const s = (await as(D.token).get('/subscription').expect(200)).body;
      expect(s).toMatchObject({
        status: 'ACTIVE',
        plan: { code: 'growth' },
        interval: 'YEARLY',
      });
      expect(
        (Date.parse(s.currentPeriodEnd) - Date.now()) / day,
      ).toBeGreaterThan(364);
      await as(D.token)
        .post('/customers', { name: 'Writable again' })
        .expect(201);
      // The earlier unfinished checkout was replaced.
      const inv = (
        await as(D.token).get('/subscription/invoices')
      ).body.data.map((i: { status: string }) => i.status);
      expect(inv).toEqual(['PAID', 'VOID']);
    });

    it('cancelling keeps working until the period ends; resuming undoes it', async () => {
      const c = (await as(D.token).post('/subscription/cancel').expect(200))
        .body;
      expect(c).toMatchObject({
        status: 'ACTIVE',
        writable: true,
        cancelAtPeriodEnd: true,
      });
      await setSubscription(D.tenantId, {
        currentPeriodEnd: new Date(Date.now() - day),
      });
      expect((await as(D.token).get('/subscription')).body).toMatchObject({
        status: 'CANCELLED',
        writable: false,
      });
      await as(D.token).post('/customers', { name: 'Refused' }).expect(402);
      await as(D.token).post('/subscription/resume').expect(409);
      await setSubscription(D.tenantId, {
        currentPeriodEnd: new Date(Date.now() + 10 * day),
      });
      expect(
        (await as(D.token).post('/subscription/resume').expect(200)).body,
      ).toMatchObject({ cancelAtPeriodEnd: false, status: 'ACTIVE' });
    });

    it('other businesses’ data stays out of reach', async () => {
      await as(D.token).get(`/customers/${randomUUID()}`).expect(404);
      expect(
        (await as(D.token).get('/reports/receivables').expect(200)).body.total,
      ).toBe('0.00');
    });
  });
});
