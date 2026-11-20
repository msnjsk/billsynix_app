import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp } from './utils.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { gstinCheckChar } from '../src/common/gst.js';
import { gtinCheckDigit } from '../src/catalogue/barcode.js';
import { parseCsv } from '../src/common/csv.js';

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
/** A fresh, valid EAN-13. */
const ean = () => {
  const body = `890${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
  return body + gtinCheckDigit(body);
};
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

type Biz = {
  tenantId: string;
  storeId: string;
  token: string;
  pan: string;
  pcs: string;
  kg: string;
  gst5: string;
  gst18: string;
  nil: string;
};

describe('Phase 4 — catalogue, pricing and tax (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const as = (t: string) => ({
    get: (url: string) => http().get(`/api/v1${url}`).set(bearer(t)),
    post: (url: string, body?: object) =>
      http()
        .post(`/api/v1${url}`)
        .set(bearer(t))
        .send(body ?? {}),
    patch: (url: string, body: object) =>
      http().patch(`/api/v1${url}`).set(bearer(t)).send(body),
    put: (url: string, body: object) =>
      http().put(`/api/v1${url}`).set(bearer(t)).send(body),
    del: (url: string) => http().delete(`/api/v1${url}`).set(bearer(t)),
    upload: (
      method: 'post' | 'put',
      url: string,
      field: string,
      buf: Buffer,
      name: string,
      type: string,
    ) =>
      http()
        [method](`/api/v1${url}`)
        .set(bearer(t))
        .attach(field, buf, { filename: name, contentType: type }),
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
    const units = (await as(token).get('/units').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    const taxes = (await as(token).get('/tax-rates').expect(200)).body.data as {
      id: string;
      name: string;
    }[];
    const unit = (c: string) => units.find((u) => u.code === c)!.id;
    const tax = (n: string) => taxes.find((t) => t.name === n)!.id;
    return {
      tenantId: res.body.tenant.id,
      storeId: res.body.store.id,
      token,
      pan,
      pcs: unit('PCS'),
      kg: unit('KG'),
      gst5: tax('GST 5%'),
      gst18: tax('GST 18%'),
      nil: tax('GST 0% (nil-rated)'),
    };
  }

  async function member(owner: Biz, roleKeys: string[], storeIds: string[]) {
    const email = `m-${randomUUID()}@example.test`;
    await as(owner.token)
      .post('/memberships', {
        name: `${roleKeys[0]} member`,
        email,
        password: PASSWORD,
        roleKeys,
        storeIds,
      })
      .expect(201);
    const res = await http()
      .post('/api/v1/auth/login')
      .set(native)
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  const product = (b: Biz, over: Record<string, unknown> = {}) => ({
    sku: `SKU-${randomUUID().slice(0, 8)}`,
    name: 'Test Product',
    unitId: b.pcs,
    taxRateId: b.gst5,
    sellingPrice: '45.00',
    mrp: '50.00',
    ...over,
  });

  let A: Biz;
  let B: Biz;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    [A, B] = await Promise.all([
      register('Catalogue A'),
      register('Catalogue B'),
    ]);
  });
  afterAll(async () => {
    await app.close();
  });

  describe('defaults and reference data', () => {
    it('a new business starts with GST rates and units', async () => {
      const taxes = (await as(A.token).get('/tax-rates').expect(200)).body.data;
      expect(taxes.map((t: { name: string }) => t.name)).toEqual(
        expect.arrayContaining([
          'GST 0% (nil-rated)',
          'Exempt',
          'GST 5%',
          'GST 18%',
          'GST 40%',
        ]),
      );
      expect(
        taxes.find((t: { name: string }) => t.name === 'GST 5%'),
      ).toMatchObject({ kind: 'TAXABLE', rate: 5, cessRate: 0 });
      const units = (await as(A.token).get('/units').expect(200)).body.data;
      expect(
        units.find((u: { code: string }) => u.code === 'KG'),
      ).toMatchObject({ decimals: 3, uqc: 'KGS' });
    });

    it('tax rates: classification rules', async () => {
      const t = as(A.token);
      const ok = await t
        .post('/tax-rates', {
          name: 'GST 28% + 12% cess',
          rate: 28,
          cessRate: 12,
        })
        .expect(201);
      expect(ok.body).toMatchObject({
        kind: 'TAXABLE',
        rate: 28,
        cessRate: 12,
      });
      await t
        .post('/tax-rates', { name: 'Odd nil', kind: 'NIL_RATED', rate: 5 })
        .expect(400);
      await t.post('/tax-rates', { name: 'Zero taxable', rate: 0 }).expect(400);
      const dup = await t
        .post('/tax-rates', { name: 'gst 5%', rate: 5 })
        .expect(409);
      expect(dup.body.error.code).toBe('ALREADY_EXISTS');
    });

    it('categories nest 3 levels, refuse cycles and duplicate sibling names', async () => {
      const t = as(A.token);
      const top = (await t.post('/categories', { name: 'Staples' }).expect(201))
        .body;
      const mid = (
        await t
          .post('/categories', { name: 'Rice', parentId: top.id })
          .expect(201)
      ).body;
      const leaf = (
        await t
          .post('/categories', { name: 'Ponni', parentId: mid.id })
          .expect(201)
      ).body;
      expect(leaf.path).toEqual(['Staples', 'Rice', 'Ponni']);
      expect(
        (
          await t
            .post('/categories', { name: 'Too deep', parentId: leaf.id })
            .expect(422)
        ).body.error.code,
      ).toBe('CATEGORY_TOO_DEEP');
      await t
        .post('/categories', { name: 'rice', parentId: top.id })
        .expect(409);
      await t.post('/categories', { name: 'Rice' }).expect(201); // different parent: fine
      expect(
        (
          await t
            .patch(`/categories/${top.id}`, { parentId: leaf.id })
            .expect(422)
        ).body.error.code,
      ).toBe('CATEGORY_CYCLE');
      const list = (await t.get('/categories').expect(200)).body.data;
      expect(list.map((c: { path: string[] }) => c.path.join(' > '))).toEqual(
        expect.arrayContaining([
          'Staples',
          'Staples > Rice',
          'Staples > Rice > Ponni',
        ]),
      );
    });

    it('brands are unique ignoring case; used ones cannot be deleted', async () => {
      const t = as(A.token);
      const brand = (await t.post('/brands', { name: 'Gehu Gold' }).expect(201))
        .body;
      await t.post('/brands', { name: 'GEHU gold' }).expect(409);
      await t.post('/products', product(A, { brandId: brand.id })).expect(201);
      expect(
        (await t.del(`/brands/${brand.id}`).expect(409)).body.error.code,
      ).toBe('IN_USE');
      const spare = (
        await t
          .post('/brands', { name: `Spare ${randomUUID().slice(0, 4)}` })
          .expect(201)
      ).body;
      await t.del(`/brands/${spare.id}`).expect(204);
    });
  });

  describe('products and barcodes', () => {
    let atta: { id: string; version: number; sku: string };
    const unitCode = ean();
    const caseCode = ean();

    it('creates a product with a unit barcode and a case barcode', async () => {
      const cat = (
        await as(A.token)
          .post('/categories', { name: `Flour ${randomUUID().slice(0, 4)}` })
          .expect(201)
      ).body;
      const res = await as(A.token)
        .post('/products', {
          ...product(A),
          sku: 'atta-5kg',
          name: 'Gehu Gold Atta 5kg',
          categoryId: cat.id,
          hsnCode: '1101',
          mrp: '320',
          sellingPrice: 299,
          purchaseCost: '255.5',
          barcodes: [
            { code: unitCode },
            { code: caseCode, packQty: 6, label: 'Bale of 6' },
          ],
        })
        .expect(201);
      expect(res.body).toMatchObject({
        sku: 'ATTA-5KG',
        mrp: '320.00',
        sellingPrice: '299.00',
        purchaseCost: '255.50',
        hsnCode: '1101',
        taxRate: { name: 'GST 5%', rate: 5 },
        unit: { code: 'PCS' },
        status: 'ACTIVE',
        version: 1,
      });
      expect(res.body.barcodes).toEqual([
        expect.objectContaining({
          code: unitCode,
          packQty: '1.000',
          isPrimary: true,
        }),
        expect.objectContaining({
          code: caseCode,
          packQty: '6.000',
          isPrimary: false,
          label: 'Bale of 6',
        }),
      ]);
      atta = res.body;
    });

    it('SKU and barcodes are unique within the business', async () => {
      const t = as(A.token);
      expect(
        (await t.post('/products', product(A, { sku: 'Atta-5KG' })).expect(409))
          .body.error.details[0].field,
      ).toBe('sku');
      const clash = await t
        .post('/products', product(A, { barcodes: [{ code: caseCode }] }))
        .expect(409);
      expect(clash.body.error.message).toContain('ATTA-5KG');
      await t
        .post('/products', product(A, { barcodes: [{ code: 'ATTA-5KG' }] }))
        .expect(409);
      await t.post('/products', product(A, { sku: unitCode })).expect(409);
    });

    it('rejects mistyped barcodes and prices above MRP', async () => {
      const t = as(A.token);
      const good = ean();
      const typo = good.slice(0, -1) + String((Number(good.at(-1)) + 1) % 10);
      expect(
        (
          await t
            .post('/products', product(A, { barcodes: [{ code: typo }] }))
            .expect(422)
        ).body.error.code,
      ).toBe('INVALID_BARCODE');
      expect(
        (
          await t
            .post('/products', product(A, { sellingPrice: '51', mrp: '50' }))
            .expect(422)
        ).body.error.code,
      ).toBe('PRICE_ABOVE_MRP');
      // ₹45 + 18% GST = ₹53.10 > MRP ₹50
      const excl = await t
        .post(
          '/products',
          product(A, {
            sellingPrice: '45',
            mrp: '50',
            priceIncludesTax: false,
            taxRateId: A.gst18,
          }),
        )
        .expect(422);
      expect(excl.body.error.message).toContain('53.10');
      await t
        .post('/products', product(A, { sellingPrice: '1.005' }))
        .expect(400);
    });

    it('looks up by barcode (with pack quantity) and by SKU', async () => {
      const t = as(A.token);
      const byUnit = (
        await t.get(`/products/lookup?code=${unitCode}`).expect(200)
      ).body;
      expect(byUnit).toMatchObject({
        matchedBy: 'BARCODE',
        packQty: '1.000',
        product: { id: atta.id },
      });
      const byCase = (
        await t.get(`/products/lookup?code=${caseCode}`).expect(200)
      ).body;
      expect(byCase).toMatchObject({
        matchedBy: 'BARCODE',
        packQty: '6.000',
        barcode: { label: 'Bale of 6' },
      });
      const bySku = (await t.get('/products/lookup?code=atta-5kg').expect(200))
        .body;
      expect(bySku).toMatchObject({
        matchedBy: 'SKU',
        barcode: null,
        product: { id: atta.id },
      });
      await t.get(`/products/lookup?code=${ean()}`).expect(404);
    });

    it('searches by words, barcode and category (with subcategories)', async () => {
      const t = as(A.token);
      const words = (await t.get('/products?q=gold%20atta').expect(200)).body;
      expect(words.data.map((p: { id: string }) => p.id)).toContain(atta.id);
      expect(
        (await t.get(`/products?q=${caseCode}`).expect(200)).body.data[0].id,
      ).toBe(atta.id);
      expect(
        (await t.get('/products?q=atta%20nonsense').expect(200)).body.meta
          .total,
      ).toBe(0);

      const top = (
        await t
          .post('/categories', { name: `Snacks ${randomUUID().slice(0, 4)}` })
          .expect(201)
      ).body;
      const sub = (
        await t
          .post('/categories', { name: 'Biscuits', parentId: top.id })
          .expect(201)
      ).body;
      const marie = (
        await t
          .post(
            '/products',
            product(A, { name: 'Crunchee Marie', categoryId: sub.id }),
          )
          .expect(201)
      ).body;
      const inTop = (await t.get(`/products?categoryId=${top.id}`).expect(200))
        .body;
      expect(inTop.data.map((p: { id: string }) => p.id)).toEqual([marie.id]);
    });

    it('updates with optimistic concurrency and audits price changes', async () => {
      const t = as(A.token);
      const stale = await t
        .patch(`/products/${atta.id}`, {
          sellingPrice: '289',
          version: atta.version + 5,
        })
        .expect(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
      const ok = await t
        .patch(`/products/${atta.id}`, {
          sellingPrice: '289',
          version: atta.version,
        })
        .expect(200);
      expect(ok.body).toMatchObject({
        sellingPrice: '289.00',
        version: atta.version + 1,
      });
      await t.patch(`/products/${atta.id}`, { mrp: '280' }).expect(422); // would put 289 above MRP
      const log = await prisma.withTenant(A.tenantId, (tx) =>
        tx.auditLog.findFirst({
          where: {
            tenantId: A.tenantId,
            entityId: atta.id,
            action: 'product.updated',
          },
        }),
      );
      expect(log?.data).toMatchObject({
        prices: { sellingPrice: { from: '299', to: '289.00' } },
      });
    });

    it('archived products drop out of billing lookups and default search', async () => {
      const t = as(A.token);
      const p = (
        await t
          .post('/products', product(A, { barcodes: [{ code: ean() }] }))
          .expect(201)
      ).body;
      await t.post(`/products/${p.id}/archive`).expect(200);
      await t.get(`/products/lookup?code=${p.barcodes[0].code}`).expect(404);
      await t
        .get(`/products/lookup?code=${p.barcodes[0].code}&includeInactive=true`)
        .expect(200);
      expect(
        (await t.get(`/products?ids=${p.id}`).expect(200)).body.meta.total,
      ).toBe(0);
      expect(
        (await t.get(`/products?ids=${p.id}&status=INACTIVE`).expect(200)).body
          .meta.total,
      ).toBe(1);
      await t.post(`/products/${p.id}/restore`).expect(200);
    });

    it('adds and removes barcodes; removing the primary promotes the next', async () => {
      const t = as(A.token);
      const p = (
        await t
          .post('/products', product(A, { barcodes: [{ code: ean() }] }))
          .expect(201)
      ).body;
      const second = ean();
      const added = (
        await t
          .post(`/products/${p.id}/barcodes`, {
            code: second,
            packQty: '12',
            isPrimary: false,
          })
          .expect(201)
      ).body;
      expect(added.barcodes).toHaveLength(2);
      const removed = (
        await t
          .del(`/products/${p.id}/barcodes/${added.barcodes[0].id}`)
          .expect(200)
      ).body;
      expect(removed.barcodes).toEqual([
        expect.objectContaining({ code: second, isPrimary: true }),
      ]);
      expect(removed.version).toBe(3);
    });

    it('variants are one level deep and need a label', async () => {
      const t = as(A.token);
      const parent = (
        await t.post('/products', product(A, { name: 'Toor Dal' })).expect(201)
      ).body;
      await t
        .post('/products', product(A, { parentId: parent.id }))
        .expect(422);
      const v = (
        await t
          .post(
            '/products',
            product(A, {
              name: 'Toor Dal 1kg',
              parentId: parent.id,
              variantLabel: '1 kg',
            }),
          )
          .expect(201)
      ).body;
      expect(
        (
          await t
            .post(
              '/products',
              product(A, { parentId: v.id, variantLabel: 'x' }),
            )
            .expect(422)
        ).body.error.code,
      ).toBe('INVALID_VARIANT');
      await t.patch(`/products/${parent.id}`, { parentId: v.id }).expect(422);
      const list = (await t.get(`/products?parentId=${parent.id}`).expect(200))
        .body;
      expect(list.data.map((p: { id: string }) => p.id)).toEqual([v.id]);
    });
  });

  describe('tenant isolation', () => {
    let aProduct: {
      id: string;
      sku: string;
      barcodes: { code: string }[];
      category: { id: string };
    };

    beforeAll(async () => {
      const cat = (
        await as(A.token)
          .post('/categories', { name: `Private ${randomUUID().slice(0, 4)}` })
          .expect(201)
      ).body;
      aProduct = (
        await as(A.token)
          .post(
            '/products',
            product(A, {
              sku: 'SHARED-SKU',
              categoryId: cat.id,
              barcodes: [{ code: ean() }],
            }),
          )
          .expect(201)
      ).body;
    });

    it("another business can't see, find or change it", async () => {
      const t = as(B.token);
      await t.get(`/products/${aProduct.id}`).expect(404);
      await t.patch(`/products/${aProduct.id}`, { name: 'hacked' }).expect(404);
      await t.post(`/products/${aProduct.id}/archive`).expect(404);
      await t
        .get(`/products/lookup?code=${aProduct.barcodes[0]!.code}`)
        .expect(404);
      await t.get('/products/lookup?code=SHARED-SKU').expect(404);
      expect(
        (await t.get(`/products?ids=${aProduct.id}&status=ALL`).expect(200))
          .body.meta.total,
      ).toBe(0);
      const exported = (await t.get('/products/export').expect(200)).text;
      expect(exported).not.toContain('SHARED-SKU');
    });

    it("can't point its products at the other business's categories, units or tax rates", async () => {
      const t = as(B.token);
      const r1 = await t
        .post('/products', product(B, { categoryId: aProduct.category.id }))
        .expect(422);
      expect(r1.body.error.details[0].field).toBe('categoryId');
      await t.post('/products', product(B, { unitId: A.pcs })).expect(422);
      await t.post('/products', product(B, { taxRateId: A.gst5 })).expect(422);
      await t
        .patch(`/categories/${aProduct.category.id}`, { name: 'x' })
        .expect(404);
    });

    it('SKUs and barcodes are per business', async () => {
      await as(B.token)
        .post(
          '/products',
          product(B, {
            sku: 'SHARED-SKU',
            barcodes: [{ code: aProduct.barcodes[0]!.code }],
          }),
        )
        .expect(201);
      const lookedUp = (
        await as(B.token).get('/products/lookup?code=SHARED-SKU').expect(200)
      ).body;
      expect(lookedUp.product.id).not.toBe(aProduct.id);
    });

    it('row-level security hides the rows even from a query that forgets the filter', async () => {
      const seen = await prisma.withTenant(B.tenantId, (tx) =>
        tx.product.count({ where: { id: aProduct.id } }),
      );
      expect(seen).toBe(0);
      const unscoped = await prisma.product.count({
        where: { id: aProduct.id },
      });
      expect(unscoped).toBe(0);
    });
  });

  describe('roles', () => {
    it('cashiers read the catalogue without purchase costs and cannot edit it', async () => {
      const cashier = await member(A, ['cashier'], [A.storeId]);
      const list = (await as(cashier).get('/products?q=atta').expect(200)).body;
      expect(list.data.length).toBeGreaterThan(0);
      expect(list.data[0]).not.toHaveProperty('purchaseCost');
      await as(cashier).post('/products', product(A)).expect(403);
      await as(cashier).post('/categories', { name: 'Nope' }).expect(403);
      await as(cashier).post('/price-lists', { name: 'Nope' }).expect(403);
      await as(cashier).get('/products/export').expect(403);
    });

    it('inventory managers edit products; branch managers only set prices', async () => {
      const inv = await member(A, ['inventory_manager'], [A.storeId]);
      const created = (await as(inv).post('/products', product(A)).expect(201))
        .body;
      expect(created).toHaveProperty('purchaseCost');
      const bm = await member(A, ['branch_manager'], [A.storeId]);
      await as(bm).post('/products', product(A)).expect(403);
      await as(bm).patch(`/products/${created.id}`, { name: 'x' }).expect(403);
      await as(bm)
        .post('/price-lists', { name: `BM list ${randomUUID().slice(0, 4)}` })
        .expect(201);
    });
  });

  describe('branch pricing', () => {
    let tnagar: string;
    let listId: string;
    let p: { id: string };

    beforeAll(async () => {
      tnagar = (
        await as(A.token)
          .post('/stores', {
            code: 'TNR',
            name: 'T. Nagar',
            address: {
              line1: '5 Usman Road',
              city: 'Chennai',
              pincode: '600017',
              stateCode: '33',
            },
            gstin: gstin('33', A.pan),
          })
          .expect(201)
      ).body.id;
      p = (
        await as(A.token)
          .post('/products', product(A, { sellingPrice: '45', mrp: '50' }))
          .expect(201)
      ).body;
      listId = (
        await as(A.token)
          .post('/price-lists', { name: 'T. Nagar prices' })
          .expect(201)
      ).body.id;
    });

    it('a branch on a price list bills at the list price; others at the default', async () => {
      const t = as(A.token);
      await t
        .put(`/price-lists/${listId}/prices`, {
          items: [{ productId: p.id, sellingPrice: '47.50' }],
        })
        .expect(200);
      await t
        .put(`/stores/${tnagar}/price-list`, { priceListId: listId })
        .expect(200);
      const there = (
        await t.get(`/products/${p.id}?storeId=${tnagar}`).expect(200)
      ).body;
      expect(there.storePrice).toEqual({
        sellingPrice: '47.50',
        source: 'PRICE_LIST',
      });
      const hq = (
        await t.get(`/products/${p.id}?storeId=${A.storeId}`).expect(200)
      ).body;
      expect(hq.storePrice).toEqual({
        sellingPrice: '45.00',
        source: 'PRODUCT',
      });
      const listed = (await t.get(`/price-lists/${listId}/prices`).expect(200))
        .body;
      expect(listed.data[0]).toMatchObject({
        productId: p.id,
        sellingPrice: '47.50',
        defaultPrice: '45.00',
        mrp: '50.00',
      });
      expect(
        (await t.get(`/price-lists/${listId}`).expect(200)).body.storeIds,
      ).toEqual([tnagar]);
    });

    it('list prices stay within MRP, both ways', async () => {
      const t = as(A.token);
      const over = await t
        .put(`/price-lists/${listId}/prices`, {
          items: [{ productId: p.id, sellingPrice: '50.01' }],
        })
        .expect(422);
      expect(over.body.error.code).toBe('PRICE_ABOVE_MRP');
      const lower = await t
        .patch(`/products/${p.id}`, { mrp: '46', sellingPrice: '45' })
        .expect(422);
      expect(lower.body.error.code).toBe('PRICE_LIST_ABOVE_MRP');
    });

    it("a branch manager can't change prices used at a branch they don't manage", async () => {
      const bm = await member(A, ['branch_manager'], [A.storeId]);
      const t = as(bm);
      await t
        .put(`/price-lists/${listId}/prices`, {
          items: [{ productId: p.id, sellingPrice: '44' }],
        })
        .expect(403);
      await t
        .put(`/stores/${tnagar}/price-list`, { priceListId: null })
        .expect(404);
      await t
        .put(`/stores/${A.storeId}/price-list`, { priceListId: listId })
        .expect(403);
      const own = (
        await t
          .post('/price-lists', {
            name: `HQ deals ${randomUUID().slice(0, 4)}`,
          })
          .expect(201)
      ).body;
      await t
        .put(`/stores/${A.storeId}/price-list`, { priceListId: own.id })
        .expect(200);
      await t
        .put(`/price-lists/${own.id}/prices`, {
          items: [{ productId: p.id, sellingPrice: '43' }],
        })
        .expect(200);
      const hq = (
        await t
          .get(
            `/products/lookup?code=${encodeURIComponent((await as(A.token).get(`/products/${p.id}`)).body.sku)}&storeId=${A.storeId}`,
          )
          .expect(200)
      ).body;
      expect(hq.product.storePrice).toEqual({
        sellingPrice: '43.00',
        source: 'PRICE_LIST',
      });
      await as(A.token)
        .put(`/stores/${A.storeId}/price-list`, { priceListId: null })
        .expect(200);
    });

    it("price lists of another business don't exist for you", async () => {
      await as(B.token).get(`/price-lists/${listId}`).expect(404);
      await as(B.token)
        .put(`/stores/${B.storeId}/price-list`, { priceListId: listId })
        .expect(404);
      await as(B.token)
        .put(`/stores/${tnagar}/price-list`, { priceListId: null })
        .expect(404);
    });
  });

  describe('CSV import / export', () => {
    const csv = (lines: string[]) => Buffer.from(lines.join('\n'), 'utf8');
    const importAs = (t: string, buf: Buffer, dryRun = false) =>
      as(t).upload(
        'post',
        `/products/import${dryRun ? '?dryRun=true' : ''}`,
        'file',
        buf,
        'products.csv',
        'text/csv',
      );
    const HEADER =
      'sku,name,category,brand,unit,tax,hsn,mrp,selling_price,purchase_cost,barcodes,parent_sku,variant_label';

    it('reports every problem by row and column, and writes nothing', async () => {
      const taken = (
        await as(A.token).get('/products/lookup?code=ATTA-5KG').expect(200)
      ).body.product.barcodes[0].code;
      const res = await importAs(
        A.token,
        csv([
          HEADER,
          'IMP-OK,Fine Product,,,PCS,5,,50,45,,,,',
          'IMP-BADTAX,Bad tax,,,PCS,13,,50,45,,,,',
          'IMP-OK,Duplicate,,,PCS,5,,50,45,,,,',
          `IMP-BC,Taken barcode,,,PCS,5,,50,45,,${taken},,`,
          'IMP-MRP,Over MRP,,,PCS,5,,50,55,,,,',
          'IMP-XL,Excel,,,PCS,5,,50,45,,8.90123E+12,,',
          'IMP-VAR,Orphan variant,,,PCS,5,,50,45,,,NO-SUCH-SKU,1 kg',
          ',No sku,,,PCS,5,,50,45,,,,',
        ]),
      ).expect(200);
      expect(res.body).toMatchObject({
        committed: false,
        created: 0,
        updated: 0,
        rows: 8,
      });
      const at = (row: number) =>
        res.body.errors.filter((e: { row: number }) => e.row === row);
      expect(at(3)[0]).toMatchObject({ column: 'tax' });
      expect(at(4)[0]).toMatchObject({
        column: 'sku',
        message: expect.stringContaining('row 2'),
      });
      expect(at(5)[0]).toMatchObject({
        column: 'barcodes',
        message: expect.stringContaining('ATTA-5KG'),
      });
      expect(at(6)[0]).toMatchObject({ column: 'selling_price' });
      expect(at(7)[0].message).toContain('Excel');
      expect(at(8)[0]).toMatchObject({ column: 'parent_sku' });
      expect(at(9)[0]).toMatchObject({ column: 'sku' });
      expect(at(2)).toEqual([]);
      await as(A.token).get('/products/lookup?code=IMP-OK').expect(404);
    });

    it('imports a valid file: creates categories, brands, variants; dry run first', async () => {
      const tag = randomUUID().slice(0, 4).toUpperCase();
      const bc = ean();
      const file = csv([
        HEADER,
        `RICE-${tag},Sagar Ponni Rice,Grains ${tag} > Rice,Sagar ${tag},PCS,GST 5%,1006,,,,,,`.replace(
          ',,,,,,',
          ',850,799,700,,,',
        ),
        `RICE-${tag}-10,Sagar Ponni Rice 10kg,Grains ${tag} > Rice,Sagar ${tag},PCS,5,1006,850,799,700,${bc}|${ean()}*4,RICE-${tag},10 kg`,
        `MILK-${tag},Fresh Milk 500ml,Dairy ${tag},,PCS,nil,401,30,29,26,,,`,
      ]);
      const dry = (await importAs(A.token, file, true).expect(200)).body;
      expect(dry).toMatchObject({
        dryRun: true,
        committed: false,
        created: 3,
        updated: 0,
        errorCount: 0,
      });
      expect(dry.categoriesCreated).toEqual(
        expect.arrayContaining([
          `Grains ${tag}`,
          `Grains ${tag} > Rice`,
          `Dairy ${tag}`,
        ]),
      );
      await as(A.token).get(`/products/lookup?code=RICE-${tag}`).expect(404);

      const real = (await importAs(A.token, file).expect(200)).body;
      expect(real).toMatchObject({
        committed: true,
        created: 3,
        errorCount: 0,
        brandsCreated: [`Sagar ${tag}`],
      });
      const variant = (
        await as(A.token).get(`/products/lookup?code=${bc}`).expect(200)
      ).body.product;
      expect(variant).toMatchObject({
        sku: `RICE-${tag}-10`,
        variantLabel: '10 kg',
        brand: { name: `Sagar ${tag}` },
        hsnCode: '1006',
      });
      expect(variant.barcodes[1].packQty).toBe('4.000');
      const milk = (
        await as(A.token).get(`/products/lookup?code=MILK-${tag}`).expect(200)
      ).body.product;
      expect(milk).toMatchObject({
        hsnCode: '0401',
        taxRate: { kind: 'NIL_RATED' },
        sellingPrice: '29.00',
      });

      // Re-import: updates only what the file gives.
      const again = (
        await importAs(
          A.token,
          csv(['sku,selling_price', `MILK-${tag},28`]),
        ).expect(200)
      ).body;
      expect(again).toMatchObject({ committed: true, created: 0, updated: 1 });
      const after = (
        await as(A.token).get(`/products/lookup?code=MILK-${tag}`).expect(200)
      ).body.product;
      expect(after).toMatchObject({
        sellingPrice: '28.00',
        mrp: '30.00',
        hsnCode: '0401',
        version: 2,
      });
    });

    it('export → import round-trips with no errors', async () => {
      const exported = await as(A.token).get('/products/export').expect(200);
      expect(exported.headers['content-type']).toContain('text/csv');
      const rows = parseCsv(exported.text);
      expect(rows[0]).toContain('selling_price');
      const back = (
        await importAs(
          A.token,
          Buffer.from(exported.text, 'utf8'),
          true,
        ).expect(200)
      ).body;
      expect(back).toMatchObject({
        errorCount: 0,
        created: 0,
        updated: rows.length - 1,
      });
    });

    it('rejects unreadable files up front', async () => {
      const t = A.token;
      expect(
        (await importAs(t, csv(['sku,colour', 'A,red'])).expect(400)).body.error
          .message,
      ).toContain('colour');
      await importAs(t, csv(['name', 'x'])).expect(400);
      await importAs(t, csv(['sku,name', 'A,"unclosed'])).expect(400);
      await importAs(
        t,
        Buffer.from([0x73, 0x6b, 0x75, 0x0a, 0xff, 0xfe]),
      ).expect(400);
      const tpl = await as(t).get('/products/import/template').expect(200);
      expect(tpl.text).toContain('sku,name');
    });
  });

  describe('product photos', () => {
    let pid: string;
    beforeAll(async () => {
      pid = (await as(A.token).post('/products', product(A)).expect(201)).body
        .id;
    });

    it('stores a photo and serves it to signed-in users of the business only', async () => {
      const put = await as(A.token)
        .upload(
          'put',
          `/products/${pid}/image`,
          'image',
          PNG,
          'photo.png',
          'image/png',
        )
        .expect(200);
      expect(put.body.imageUrl).toMatch(
        new RegExp(`/api/v1/products/${pid}/image\\?v=2$`),
      );
      const got = await as(A.token)
        .get(`/products/${pid}/image`)
        .buffer(true)
        .expect(200);
      expect(got.headers['content-type']).toBe('image/png');
      expect(Buffer.compare(got.body as Buffer, PNG)).toBe(0);
      await http().get(`/api/v1/products/${pid}/image`).expect(401);
      await as(B.token).get(`/products/${pid}/image`).expect(404);
      await as(B.token)
        .upload(
          'put',
          `/products/${pid}/image`,
          'image',
          PNG,
          'photo.png',
          'image/png',
        )
        .expect(404);
    });

    it('accepts only real images up to 2 MB', async () => {
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      );
      await as(A.token)
        .upload(
          'put',
          `/products/${pid}/image`,
          'image',
          svg,
          'x.png',
          'image/png',
        )
        .expect(415);
      const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
      await as(A.token)
        .upload(
          'put',
          `/products/${pid}/image`,
          'image',
          big,
          'big.png',
          'image/png',
        )
        .expect(413);
    });

    it('removes the photo', async () => {
      const del = await as(A.token).del(`/products/${pid}/image`).expect(200);
      expect(del.body.imageUrl).toBeNull();
      await as(A.token).get(`/products/${pid}/image`).expect(404);
    });
  });

  describe('shop logo', () => {
    it('stores the logo, shows it on the business, serves it to that business only, and removes it', async () => {
      expect((await as(A.token).get('/tenants/current').expect(200)).body.logo).toBeNull();
      const put = await as(A.token).upload('put', '/tenants/current/logo', 'logo', PNG, 'logo.png', 'image/png').expect(200);
      expect(put.body.logo).toEqual({ version: expect.any(String) });
      const got = await as(A.token).get('/tenants/current/logo').buffer(true).expect(200);
      expect(got.headers['content-type']).toBe('image/png');
      expect(Buffer.compare(got.body as Buffer, PNG)).toBe(0);
      await http().get('/api/v1/tenants/current/logo').expect(401);
      // Another business has its own (no) logo.
      await as(B.token).get('/tenants/current/logo').expect(404);
      // A new upload gets a new version, so apps refresh their copy.
      const again = await as(A.token).upload('put', '/tenants/current/logo', 'logo', PNG, 'logo.png', 'image/png').expect(200);
      expect(again.body.logo.version).not.toBe(put.body.logo.version);
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
      await as(A.token).upload('put', '/tenants/current/logo', 'logo', svg, 'x.png', 'image/png').expect(415);
      const del = await as(A.token).del('/tenants/current/logo').expect(200);
      expect(del.body.logo).toBeNull();
      await as(A.token).get('/tenants/current/logo').expect(404);
    });
  });
});
