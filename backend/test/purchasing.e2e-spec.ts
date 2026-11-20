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
const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

type Biz = {
  tenantId: string;
  storeId: string;
  token: string;
  pcs: string;
  gst5: string;
  nil: string;
};

describe('Phase 6 — suppliers and purchasing (e2e)', () => {
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
    patch: (url: string, body: object) =>
      http()
        .patch(`/api/v1${url}`)
        .set('Authorization', `Bearer ${t}`)
        .send(body),
  });

  async function register(
    name: string,
    registration: 'REGULAR' | 'UNREGISTERED',
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
      pcs: units.find((u) => u.code === 'PCS')!.id,
      gst5: taxes.find((t) => t.name === 'GST 5%')!.id,
      nil: taxes.find((t) => t.name === 'GST 0% (nil-rated)')!.id,
    };
  }

  async function member(owner: Biz, roleKeys: string[]) {
    const email = `m-${randomUUID()}@example.test`;
    await as(owner.token)
      .post('/memberships', {
        name: `${roleKeys[0]} member`,
        email,
        password: PASSWORD,
        roleKeys,
        storeIds: [owner.storeId],
      })
      .expect(201);
    return (
      await http()
        .post('/api/v1/auth/login')
        .set(native)
        .send({ email, password: PASSWORD })
        .expect(200)
    ).body.accessToken as string;
  }

  const product = async (b: Biz, over: Record<string, unknown>) =>
    (
      await as(b.token)
        .post('/products', {
          sku: `P-${randomUUID().slice(0, 8)}`,
          unitId: b.pcs,
          taxRateId: b.gst5,
          ...over,
        })
        .expect(201)
    ).body.id as string;
  const supplier = async (t: string, body: Record<string, unknown>) =>
    (
      await as(t)
        .post('/suppliers', {
          name: `Supplier ${randomUUID().slice(0, 6)}`,
          ...body,
        })
        .expect(201)
    ).body;
  const stockOf = async (b: Biz, productId: string) =>
    (
      await as(b.token)
        .get(`/stores/${b.storeId}/stock/${productId}`)
        .expect(200)
    ).body;
  const balanceOf = async (b: Biz, id: string) =>
    (await as(b.token).get(`/suppliers/${id}`).expect(200)).body.balance;

  /** Every supplier's balance equals the sum of its ledger entries. */
  async function assertPayablesExplained(tenantId: string) {
    const bad = await prisma.withTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<unknown[]>`
        SELECT s.id FROM suppliers s
        LEFT JOIN (SELECT supplier_id, SUM(amount) t FROM supplier_transactions GROUP BY 1) x ON x.supplier_id = s.id
        WHERE s.balance <> COALESCE(x.t, 0)`,
    );
    expect(bad).toEqual([]);
  }

  let A: Biz;
  let B: Biz;
  let im: string; // inventory manager: suppliers + purchasing, no approval, no payments
  let bm: string; // branch manager: purchasing + approval
  let rice: string;
  let oil: string;
  let paneer: string;
  let s1: { id: string }; // Tamil Nadu, registered
  let s2: { id: string }; // Karnataka, registered
  let s3: { id: string }; // unregistered
  let po1: { id: string; items: { id: string; product: { id: string } }[] };
  let grn1: { id: string; items: { id: string; product: { id: string } }[] };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    [A, B] = await Promise.all([
      register('Buy A', 'REGULAR'),
      register('Buy B', 'UNREGISTERED'),
    ]);
    [im, bm] = await Promise.all([
      member(A, ['inventory_manager']),
      member(A, ['branch_manager']),
    ]);
    rice = await product(A, {
      name: 'Ponni Rice 1kg',
      sellingPrice: '60',
      mrp: '60',
    });
    oil = await product(A, {
      name: 'Sunflower Oil 1L',
      sellingPrice: '150',
      mrp: '160',
    });
    paneer = await product(A, {
      name: 'Paneer 200g',
      taxRateId: A.nil,
      tracksBatches: true,
      sellingPrice: '90',
      mrp: '95',
    });
  });
  afterAll(async () => {
    await app.close();
  });

  describe('suppliers', () => {
    it('registered suppliers take their state from the GSTIN; names and GSTINs are unique', async () => {
      const g = gstin('33', randomPan());
      const created = await as(im)
        .post('/suppliers', {
          name: 'Sri Balaji Traders',
          gstin: g,
          creditDays: 15,
          supplies: 'Rice, dal',
        })
        .expect(201);
      expect(created.body).toMatchObject({
        stateCode: '33',
        registered: true,
        creditDays: 15,
      });
      expect(created.body).not.toHaveProperty('balance'); // not a payer
      s1 = created.body;
      await as(im)
        .post('/suppliers', { name: 'sri balaji traders', stateCode: '33' })
        .expect(409);
      await as(im)
        .post('/suppliers', { name: 'Another', gstin: g })
        .expect(409);
      await as(im)
        .post('/suppliers', { name: 'Bad', gstin: '33ABCDE1234F1Z0' })
        .expect(422);
      expect(
        (await as(im).post('/suppliers', { name: 'No state' }).expect(422)).body
          .error.code,
      ).toBe('STATE_REQUIRED');
      s2 = await supplier(A.token, { gstin: gstin('29', randomPan()) });
      s3 = await supplier(A.token, { stateCode: '33' });
    });

    it('an opening balance is posted to the supplier ledger (payers only)', async () => {
      await as(im)
        .post('/suppliers', {
          name: 'Opening IM',
          stateCode: '33',
          openingBalance: '1000',
        })
        .expect(403);
      const s = await supplier(A.token, {
        stateCode: '33',
        openingBalance: '1000.50',
      });
      expect(s.balance).toBe('1000.50');
      const st = (
        await as(A.token).get(`/suppliers/${s.id}/statement`).expect(200)
      ).body;
      expect(st.entries).toEqual([
        expect.objectContaining({
          type: 'OPENING',
          credit: '1000.50',
          balance: '1000.50',
        }),
      ]);
      await as(im).get(`/suppliers/${s.id}/statement`).expect(403);
    });

    it('supplier prices become the default PO rate', async () => {
      await as(im)
        .put(`/suppliers/${s1.id}/products`, {
          items: [{ productId: rice, cost: '40', supplierSku: 'BAL-PONNI' }],
        })
        .expect(200);
      const prices = (
        await as(im).get(`/suppliers/${s1.id}/products`).expect(200)
      ).body.data;
      expect(prices[0]).toMatchObject({
        cost: '40.00',
        supplierSku: 'BAL-PONNI',
      });
    });
  });

  describe('purchase orders', () => {
    it('prices lines with discount and splits GST by state', async () => {
      const res = await as(im)
        .post('/purchase-orders', {
          supplierId: s1.id,
          storeId: A.storeId,
          items: [
            { productId: rice, qty: 100, discountPct: 2 },
            { productId: oil, qty: 50, rate: '120' },
          ],
        })
        .expect(201);
      expect(res.body).toMatchObject({
        number: expect.stringMatching(/^PO-\d{5}$/),
        status: 'DRAFT',
        interState: false,
        totals: {
          taxable: '9920.00',
          cgst: '248.00',
          sgst: '248.00',
          igst: '0.00',
          total: '10416.00',
        },
      });
      expect(
        res.body.items.find(
          (i: { product: { id: string } }) => i.product.id === rice,
        ),
      ).toMatchObject({ rate: '40.00', netRate: '39.20', gstRate: 5 });
      po1 = res.body;
      const inter = (
        await as(im)
          .post('/purchase-orders', {
            supplierId: s2.id,
            storeId: A.storeId,
            items: [{ productId: oil, qty: 10, rate: '100' }],
          })
          .expect(201)
      ).body;
      expect(inter.totals).toMatchObject({
        igst: '50.00',
        cgst: '0.00',
        total: '1050.00',
      });
      const unreg = (
        await as(im)
          .post('/purchase-orders', {
            supplierId: s3.id,
            storeId: A.storeId,
            items: [{ productId: oil, qty: 10, rate: '100' }],
          })
          .expect(201)
      ).body;
      expect(unreg.totals).toMatchObject({
        taxable: '1000.00',
        total: '1000.00',
      });
      expect(unreg.gstApplies).toBe(false);
      await as(im)
        .post('/purchase-orders', {
          supplierId: s3.id,
          storeId: A.storeId,
          items: [{ productId: oil, qty: 1.5, rate: '1' }],
        })
        .expect(422);
    });

    it('large orders wait for approval; drafts are editable, sent ones are not', async () => {
      const big = (
        await as(im)
          .post('/purchase-orders', {
            supplierId: s1.id,
            storeId: A.storeId,
            items: [{ productId: rice, qty: 2000 }],
          })
          .expect(201)
      ).body;
      await as(im)
        .patch(`/purchase-orders/${big.id}`, { notes: 'Festival stock' })
        .expect(200);
      expect(
        (await as(im).post(`/purchase-orders/${big.id}/submit`).expect(200))
          .body.status,
      ).toBe('PENDING_APPROVAL');
      await as(im).post(`/purchase-orders/${big.id}/approve`).expect(403);
      expect(
        (await as(bm).post(`/purchase-orders/${big.id}/approve`).expect(200))
          .body,
      ).toMatchObject({ status: 'SENT', approvedByUserId: expect.any(String) });
      await as(im)
        .patch(`/purchase-orders/${big.id}`, { notes: 'x' })
        .expect(409);
      await as(im).post(`/purchase-orders/${big.id}/cancel`).expect(200);
      expect(
        (await as(im).post(`/purchase-orders/${po1.id}/submit`).expect(200))
          .body.status,
      ).toBe('SENT');
    });
  });

  describe('goods receipts', () => {
    it('a partial delivery posts stock, the payable and PO progress together', async () => {
      const res = await as(im)
        .post('/goods-receipts', {
          supplierId: s1.id,
          storeId: A.storeId,
          poId: po1.id,
          supplierInvoiceNo: 'SBT/1001',
          items: [
            { productId: rice, receivedQty: 60, damagedQty: 5 },
            { productId: oil, receivedQty: 50, rate: '125' },
          ],
        })
        .expect(201);
      grn1 = res.body;
      expect(res.body).toMatchObject({
        number: expect.stringMatching(/^GRN-\d{5}$/),
        totals: {
          taxable: '8602.00',
          cgst: '215.05',
          sgst: '215.05',
          roundOff: '-0.10',
          total: '9032.00',
        },
        matchIssues: [
          expect.objectContaining({ kind: 'PRICE', productId: oil }),
        ],
      });
      expect(
        res.body.items.find(
          (i: { product: { id: string } }) => i.product.id === rice,
        ),
      ).toMatchObject({
        orderedQty: '100.000',
        receivedQty: '60.000',
        damagedQty: '5.000',
        acceptedQty: '55.000',
        unitCost: '39.2000',
      });
      expect(await stockOf(A, rice)).toMatchObject({
        qty: '55.000',
        avgCost: '39.2000',
      });
      expect(await stockOf(A, oil)).toMatchObject({
        qty: '50.000',
        avgCost: '125.0000',
      });
      expect(await balanceOf(A, s1.id)).toBe('9032.00');
      const po = (await as(im).get(`/purchase-orders/${po1.id}`).expect(200))
        .body;
      expect(po).toMatchObject({
        status: 'PARTIAL',
        progress: { ordered: '150.000', received: '105.000', pct: 70 },
      });
      expect(
        po.items.find(
          (i: { product: { id: string } }) => i.product.id === rice,
        ),
      ).toMatchObject({ receivedQty: '55.000', pendingQty: '45.000' });
      const moves = (
        await as(A.token)
          .get(`/stores/${A.storeId}/stock-movements?productId=${rice}`)
          .expect(200)
      ).body.data;
      expect(moves[0]).toMatchObject({
        type: 'PURCHASE_RECEIPT',
        qty: '55.000',
        refType: 'GRN',
        refId: grn1.id,
      });
      // The receipt price becomes the supplier price and the product's last cost.
      expect(
        (await as(im).get(`/suppliers/${s1.id}/products`)).body.data.find(
          (p: { product: { id: string } }) => p.product.id === oil,
        ).cost,
      ).toBe('125.00');
    });

    it('the rest arrives: the PO is received and closed to further receipts', async () => {
      const second = (
        await as(im)
          .post('/goods-receipts', {
            supplierId: s1.id,
            storeId: A.storeId,
            poId: po1.id,
            supplierInvoiceNo: 'SBT/1002',
            items: [{ productId: rice, receivedQty: 45 }],
          })
          .expect(201)
      ).body;
      expect(second.totals.total).toBe('1852.00');
      expect((await as(im).get(`/purchase-orders/${po1.id}`)).body.status).toBe(
        'RECEIVED',
      );
      const again = await as(im)
        .post('/goods-receipts', {
          supplierId: s1.id,
          storeId: A.storeId,
          poId: po1.id,
          items: [{ productId: rice, receivedQty: 1 }],
        })
        .expect(409);
      expect(again.body.error.code).toBe('PO_NOT_OPEN');
      expect(await balanceOf(A, s1.id)).toBe('10884.00');
      expect((await stockOf(A, rice)).qty).toBe('100.000');
    });

    it('a receipt that fails changes nothing', async () => {
      const before = {
        rice: (await stockOf(A, rice)).qty,
        bal: await balanceOf(A, s3.id),
      };
      const count = await prisma.withTenant(A.tenantId, (tx) =>
        tx.goodsReceipt.count({ where: { tenantId: A.tenantId } }),
      );
      const r = await as(im)
        .post('/goods-receipts', {
          supplierId: s3.id,
          storeId: A.storeId,
          items: [
            { productId: rice, receivedQty: 10, rate: '40' },
            { productId: paneer, receivedQty: 5, rate: '70' },
          ],
        })
        .expect(422);
      expect(r.body.error.code).toBe('BATCH_REQUIRED');
      expect((await stockOf(A, rice)).qty).toBe(before.rice);
      expect(await balanceOf(A, s3.id)).toBe(before.bal);
      expect(
        await prisma.withTenant(A.tenantId, (tx) =>
          tx.goodsReceipt.count({ where: { tenantId: A.tenantId } }),
        ),
      ).toBe(count);
    });

    it('captures batches and expiry', async () => {
      await as(im)
        .post('/goods-receipts', {
          supplierId: s3.id,
          storeId: A.storeId,
          items: [
            {
              productId: paneer,
              receivedQty: 12,
              rate: '70',
              batchNo: 'pn-0411',
              expiryDate: daysAgo(-6),
            },
          ],
        })
        .expect(201);
      const s = await stockOf(A, paneer);
      expect(s.batches).toEqual([
        expect.objectContaining({
          batchNo: 'PN-0411',
          qty: '12.000',
          expiryDate: daysAgo(-6),
        }),
      ]);
    });

    it('a supplier invoice is entered only once; a retry is replayed, not repeated', async () => {
      const body = {
        supplierId: s3.id,
        storeId: A.storeId,
        supplierInvoiceNo: 'INV-77',
        items: [{ productId: oil, receivedQty: 2, rate: '100' }],
      };
      const key = randomUUID();
      const first = await as(im).post('/goods-receipts', body, key).expect(201);
      const replay = await as(im)
        .post('/goods-receipts', body, key)
        .expect(200);
      expect(replay.body.id).toBe(first.body.id);
      const dup = await as(im)
        .post('/goods-receipts', { ...body, supplierInvoiceNo: 'inv-77' })
        .expect(409);
      expect(dup.body.error.code).toBe('DUPLICATE_INVOICE');
      expect((await stockOf(A, oil)).qty).toBe('52.000');
    });

    it('concurrent deliveries against one PO all count', async () => {
      const po = (
        await as(im)
          .post('/purchase-orders', {
            supplierId: s3.id,
            storeId: A.storeId,
            items: [{ productId: rice, qty: 10, rate: '40' }],
          })
          .expect(201)
      ).body;
      await as(im).post(`/purchase-orders/${po.id}/submit`).expect(200);
      const before = Number(await balanceOf(A, s3.id));
      const results = await Promise.all(
        [1, 2].map(() =>
          as(im).post('/goods-receipts', {
            supplierId: s3.id,
            storeId: A.storeId,
            poId: po.id,
            items: [{ productId: rice, receivedQty: 5 }],
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      const after = (await as(im).get(`/purchase-orders/${po.id}`)).body;
      expect(after).toMatchObject({
        status: 'RECEIVED',
        items: [expect.objectContaining({ receivedQty: '10.000' })],
      });
      expect(Number(await balanceOf(A, s3.id))).toBe(before + 400);
      await assertPayablesExplained(A.tenantId);
    });

    it('without input credit, GST becomes part of stock cost', async () => {
      const sup = await supplier(B.token, { gstin: gstin('33', randomPan()) });
      const item = await product(B, {
        name: 'Rice',
        sellingPrice: '60',
        mrp: '60',
      });
      const g = (
        await as(B.token)
          .post('/goods-receipts', {
            supplierId: sup.id,
            storeId: B.storeId,
            items: [{ productId: item, receivedQty: 10, rate: '40' }],
          })
          .expect(201)
      ).body;
      expect(g.totals.total).toBe('420.00');
      expect((await stockOf(B, item)).avgCost).toBe('42.0000');
    });
  });

  describe('purchase returns', () => {
    const riceLine = () => grn1.items.find((i) => i.product.id === rice)!.id;

    it('damaged-on-arrival goods get a debit note without touching stock', async () => {
      const r = (
        await as(im)
          .post('/purchase-returns', {
            supplierId: s1.id,
            storeId: A.storeId,
            reason: 'DAMAGED',
            items: [
              {
                productId: rice,
                qty: 5,
                grnItemId: riceLine(),
                fromDamaged: true,
              },
            ],
          })
          .expect(201)
      ).body;
      expect(r).toMatchObject({
        number: expect.stringMatching(/^DN-\d{5}$/),
        grn: { id: grn1.id },
        totals: { taxable: '196.00', total: '206.00' },
      });
      expect((await stockOf(A, rice)).qty).toBe('110.000');
      expect(await balanceOf(A, s1.id)).toBe('10678.00');
    });

    it('goods returned from stock leave at the receipt cost', async () => {
      await as(im)
        .post('/purchase-returns', {
          supplierId: s1.id,
          storeId: A.storeId,
          reason: 'QUALITY',
          items: [{ productId: rice, qty: 10, grnItemId: riceLine() }],
        })
        .expect(201);
      expect((await stockOf(A, rice)).qty).toBe('100.000');
      const m = (
        await as(A.token).get(
          `/stores/${A.storeId}/stock-movements?productId=${rice}&type=PURCHASE_RETURN`,
        )
      ).body.data[0];
      expect(m).toMatchObject({ qty: '-10.000', unitCost: '39.2000' });
      expect(await balanceOf(A, s1.id)).toBe('10266.00');
    });

    it("can't return more than a receipt line brought", async () => {
      const dmg = await as(im)
        .post('/purchase-returns', {
          supplierId: s1.id,
          storeId: A.storeId,
          reason: 'DAMAGED',
          items: [
            {
              productId: rice,
              qty: 1,
              grnItemId: riceLine(),
              fromDamaged: true,
            },
          ],
        })
        .expect(422);
      expect(dmg.body.error.code).toBe('OVER_RETURN');
      await as(im)
        .post('/purchase-returns', {
          supplierId: s1.id,
          storeId: A.storeId,
          reason: 'EXCESS',
          items: [{ productId: rice, qty: 46, grnItemId: riceLine() }],
        })
        .expect(422);
      await as(im)
        .post('/purchase-returns', {
          supplierId: s1.id,
          storeId: A.storeId,
          reason: 'DAMAGED',
          items: [{ productId: rice, qty: 1, fromDamaged: true }],
        })
        .expect(422);
    });
  });

  describe('supplier payments and payables', () => {
    it('only payers record payments', async () => {
      await as(im)
        .post('/supplier-payments', {
          supplierId: s1.id,
          amount: '10',
          mode: 'CASH',
        })
        .expect(403);
      await as(bm)
        .post('/supplier-payments', {
          supplierId: s1.id,
          amount: '10',
          mode: 'CASH',
        })
        .expect(403);
    });

    it('a payment settles the oldest bills first; the rest stays open', async () => {
      const p = (
        await as(A.token)
          .post('/supplier-payments', {
            supplierId: s1.id,
            amount: '9000',
            mode: 'BANK_TRANSFER',
            reference: 'UTR123',
          })
          .expect(201)
      ).body;
      expect(p.number).toMatch(/^PAY-\d{5}$/);
      // GRN1: 9032 − 206 − 412 (debit notes) = 8414 owed; the remaining 586 goes to the next bill.
      expect(p.allocations.map((a: { amount: string }) => a.amount)).toEqual([
        '8414.00',
        '586.00',
      ]);
      expect(p.unallocated).toBe('0.00');
      expect(await balanceOf(A, s1.id)).toBe('1266.00');
      const open = (
        await as(A.token).get(`/suppliers/${s1.id}/open-bills`).expect(200)
      ).body.data;
      expect(open).toEqual([
        expect.objectContaining({ outstanding: '1266.00' }),
      ]);
    });

    it('allocations are checked; unallocated money is an advance; refunds come back in', async () => {
      const grn = (await as(A.token).get(`/suppliers/${s1.id}/open-bills`)).body
        .data[0];
      const over = await as(A.token)
        .post('/supplier-payments', {
          supplierId: s1.id,
          amount: '2000',
          mode: 'UPI',
          allocations: [{ grnId: grn.grnId, amount: '1300' }],
        })
        .expect(422);
      expect(over.body.error.code).toBe('OVER_ALLOCATION');
      await as(A.token)
        .post('/supplier-payments', {
          supplierId: s1.id,
          amount: '1500',
          mode: 'CHEQUE',
          allocations: [],
        })
        .expect(201);
      expect(await balanceOf(A, s1.id)).toBe('-234.00');
      const rep = (
        await as(A.token).get('/reports/payables').expect(200)
      ).body.data.find(
        (r: { supplier: { id: string } }) => r.supplier.id === s1.id,
      );
      expect(rep).toMatchObject({ balance: '-234.00', other: '-1500.00' });
      await as(A.token)
        .post('/supplier-payments', {
          supplierId: s1.id,
          direction: 'IN',
          amount: '234',
          mode: 'BANK_TRANSFER',
          allocations: [{ grnId: grn.grnId, amount: '1' }],
        })
        .expect(422);
      await as(A.token)
        .post('/supplier-payments', {
          supplierId: s1.id,
          direction: 'IN',
          amount: '234',
          mode: 'BANK_TRANSFER',
        })
        .expect(201);
      expect(await balanceOf(A, s1.id)).toBe('0.00');
    });

    it('the statement explains the balance line by line', async () => {
      const st = (
        await as(A.token).get(`/suppliers/${s1.id}/statement`).expect(200)
      ).body;
      expect(
        st.entries.map(
          (e: { type: string; credit: string | null; debit: string | null }) =>
            `${e.type} ${e.credit ?? '-' + e.debit}`,
        ),
      ).toEqual([
        'PURCHASE 9032.00',
        'PURCHASE 1852.00',
        'RETURN -206.00',
        'RETURN -412.00',
        'PAYMENT -9000.00',
        'PAYMENT -1500.00',
        'REFUND 234.00',
      ]);
      expect(st).toMatchObject({
        openingBalance: '0.00',
        closingBalance: '0.00',
        currentBalance: '0.00',
      });
    });

    it('ageing puts overdue bills in their bucket', async () => {
      await as(im)
        .post('/goods-receipts', {
          supplierId: s2.id,
          storeId: A.storeId,
          receivedDate: daysAgo(45),
          items: [{ productId: oil, receivedQty: 1, rate: '100' }],
        })
        .expect(201);
      const rep = (await as(A.token).get('/reports/payables').expect(200)).body;
      const row = rep.data.find(
        (r: { supplier: { id: string } }) => r.supplier.id === s2.id,
      );
      expect(row).toMatchObject({
        balance: '105.00',
        overdue: '105.00',
        ageing: { d31_60: '105.00', current: '0.00' },
      });
      await as(im).get('/reports/payables').expect(403);
      await assertPayablesExplained(A.tenantId);
    });

    it('purchase history lists every receipt of a product', async () => {
      const h = (
        await as(im).get(`/products/${rice}/purchase-history`).expect(200)
      ).body.data;
      expect(h.length).toBeGreaterThanOrEqual(4);
      expect(h.map((x: { supplier: { id: string } }) => x.supplier.id)).toEqual(
        expect.arrayContaining([s1.id, s3.id]),
      );
    });
  });

  describe('integrity and isolation', () => {
    it('the payables ledger cannot be edited', async () => {
      await expect(
        prisma.withTenant(
          A.tenantId,
          (tx) =>
            tx.$executeRaw`UPDATE supplier_transactions SET amount = 1 WHERE tenant_id = ${A.tenantId}::uuid`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it("another business can't see or use these suppliers and orders", async () => {
      await as(B.token).get(`/suppliers/${s1.id}`).expect(404);
      await as(B.token).get(`/purchase-orders/${po1.id}`).expect(404);
      await as(B.token).get(`/goods-receipts/${grn1.id}`).expect(404);
      await as(B.token)
        .post('/goods-receipts', {
          supplierId: s1.id,
          storeId: B.storeId,
          items: [{ productId: rice, receivedQty: 1, rate: '1' }],
        })
        .expect(422);
      await as(B.token)
        .post('/supplier-payments', {
          supplierId: s1.id,
          amount: '1',
          mode: 'CASH',
        })
        .expect(422);
      expect(
        (
          await as(B.token).get('/suppliers?status=ALL').expect(200)
        ).body.data.map((s: { id: string }) => s.id),
      ).not.toContain(s1.id);
    });

    it('stock and payables both still reconcile', async () => {
      expect(
        (await as(A.token).get('/stock/reconciliation').expect(200)).body.ok,
      ).toBe(true);
      await assertPayablesExplained(A.tenantId);
      await assertPayablesExplained(B.tenantId);
    });
  });
});
