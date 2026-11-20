import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Decimal } from '../common/decimal.js';
import { assertPermission } from '../auth/auth-context.js';
import { storePrices } from '../catalogue/pricing.js';
import { inclusivePrice } from '../sales/bill-math.js';
import { unprocessable } from '../sales/sales.common.js';
import type { CatalogueQuery } from './sync.schemas.js';
import {
  offlinePolicy,
  requireDevice,
  type DeviceAuth,
} from './sync.common.js';
import type { AuthContext } from '../auth/auth-context.js';

type Cursor = {
  /** Lower bound (exclusive with `id`) of the change time. */
  t: string;
  /** Last product id of the previous page, while paging through one download. */
  id?: string;
  /** Start of this download: the next delta begins shortly before it. */
  s?: string;
  /** Start of the previous, completed download (branch changes after it force a reset). */
  b?: string;
};

/** Rows that changed while a download was running are fetched again by the next one. */
const OVERLAP_MS = 60_000;
const EPOCH = '1970-01-01T00:00:00.000Z';

const encode = (c: Cursor) =>
  Buffer.from(JSON.stringify(c)).toString('base64url');
function decode(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString()) as Cursor;
    if (typeof c.t !== 'string' || Number.isNaN(Date.parse(c.t)))
      throw new Error();
    return c;
  } catch {
    throw unprocessable(
      'INVALID_CURSOR',
      'Start the catalogue download again.',
      'cursor',
    );
  }
}

/**
 * The catalogue a POS device keeps offline (Phase 9): products with the price they bill at in the
 * device's branch, tax, barcodes and units; and the branch's stock. A delta (with `cursor`)
 * returns only products whose own row, branch price or tax rate changed since — their `version`
 * and change time tell the device which copy is newer. A changed price-list assignment of the
 * branch makes the server answer with `reset: true` (drop the cache and take the full list).
 */
@Injectable()
export class CatalogueFeedService {
  constructor(private readonly prisma: PrismaService) {}

  catalogue(authIn: AuthContext, q: CatalogueQuery) {
    const auth = requireDevice(authIn);
    assertPermission(auth, 'products:read');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      const now = clock!.now;
      let cursor: Cursor = q.cursor ? decode(q.cursor) : { t: EPOCH };
      const store = await tx.store.findUniqueOrThrow({
        where: { id: auth.device.storeId },
        include: { priceList: true },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
      });
      let reset = false;
      // The branch was pointed at another price list since: every price may differ.
      if (cursor.b && !cursor.id && store.updatedAt > new Date(cursor.b)) {
        reset = true;
        cursor = { t: EPOCH };
      }
      const since = new Date(cursor.t);
      const started = cursor.s ? new Date(cursor.s) : now;
      const list = store.priceList?.isActive ? store.priceList.id : null;

      const rows = await tx.$queryRaw<{ id: string; changed_at: Date }[]>`
        SELECT p.id::text AS id,
               GREATEST(p.updated_at, tr.updated_at, COALESCE(pp.updated_at, ${EPOCH}::timestamptz)) AS changed_at
        FROM products p
        JOIN tax_rates tr ON tr.id = p.tax_rate_id
        LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.price_list_id = ${list}::uuid
        WHERE p.tenant_id = ${auth.tenantId}::uuid
          AND (GREATEST(p.updated_at, tr.updated_at, COALESCE(pp.updated_at, ${EPOCH}::timestamptz)), p.id)
              > (${since}::timestamptz, ${cursor.id ?? '00000000-0000-0000-0000-000000000000'}::uuid)
        ORDER BY 2, 1
        LIMIT ${q.limit + 1}`;
      const more = rows.length > q.limit;
      const pageRows = more ? rows.slice(0, q.limit) : rows;

      const products = await tx.product.findMany({
        where: {
          tenantId: auth.tenantId,
          id: { in: pageRows.map((r) => r.id) },
        },
        include: {
          unit: true,
          taxRate: true,
          barcodes: { orderBy: { createdAt: 'asc' } },
        },
      });
      const byId = new Map(products.map((p) => [p.id, p]));
      const prices = await storePrices(tx, auth.tenantId, list, products);
      const chargeGst = tenant.registration === 'REGULAR';

      const last = pageRows.at(-1);
      const next: Cursor = more
        ? {
            t: last!.changed_at.toISOString(),
            id: last!.id,
            s: started.toISOString(),
          }
        : {
            t: new Date(started.getTime() - OVERLAP_MS).toISOString(),
            b: started.toISOString(),
          };

      return {
        reset,
        full: since.toISOString() === EPOCH,
        hasMore: more,
        cursor: encode(next),
        serverTime: now,
        priceList: list ? { id: list, name: store.priceList!.name } : null,
        // Small, so always sent whole.
        units: (
          await tx.unit.findMany({ where: { tenantId: auth.tenantId } })
        ).map((u) => ({
          id: u.id,
          code: u.code,
          name: u.name,
          decimals: u.decimals,
        })),
        taxRates: (
          await tx.taxRate.findMany({ where: { tenantId: auth.tenantId } })
        ).map((t) => ({
          id: t.id,
          name: t.name,
          kind: t.kind,
          rate: Number(t.rate),
          cessRate: Number(t.cessRate),
        })),
        categories: (
          await tx.category.findMany({ where: { tenantId: auth.tenantId } })
        ).map((c) => ({ id: c.id, name: c.name, parentId: c.parentId })),
        products: pageRows.flatMap((r) => {
          const p = byId.get(r.id);
          if (!p) return [];
          const sp = prices.get(p.id)!;
          const taxed = p.taxRate.kind === 'TAXABLE';
          const gstRate = taxed ? p.taxRate.rate : new Decimal(0);
          const cessRate = taxed ? p.taxRate.cessRate : new Decimal(0);
          const price = new Decimal(sp.sellingPrice);
          return [
            {
              id: p.id,
              sku: p.sku,
              name: p.name,
              receiptName: p.receiptName,
              categoryId: p.categoryId,
              hsnCode: p.hsnCode,
              unitId: p.unitId,
              taxRateId: p.taxRateId,
              gstRate: chargeGst ? Number(gstRate) : 0,
              cessRate: chargeGst ? Number(cessRate) : 0,
              mrp: p.mrp?.toFixed(2) ?? null,
              sellingPrice: sp.sellingPrice,
              priceIncludesTax: p.priceIncludesTax,
              /** What one unit is charged at the counter, tax inclusive. */
              billPrice: (p.priceIncludesTax || !chargeGst
                ? price
                : inclusivePrice(price, gstRate, cessRate)
              ).toFixed(2),
              priceSource: sp.source,
              allowOpenPrice: p.allowOpenPrice,
              trackInventory: p.trackInventory,
              tracksBatches: p.tracksBatches,
              status: p.status,
              version: p.version,
              changedAt: r.changed_at,
              barcodes: p.barcodes.map((b) => ({
                code: b.code,
                packQty: b.packQty.toFixed(3),
                isPrimary: b.isPrimary,
              })),
            },
          ];
        }),
      };
    });
  }

  /** The branch's stock now, for the device's local balance (it may sell below it offline). */
  stock(authIn: AuthContext) {
    const auth: DeviceAuth = requireDevice(authIn);
    assertPermission(auth, 'products:read');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.stockBalance.findMany({
        where: { tenantId: auth.tenantId, storeId: auth.device.storeId },
        select: { productId: true, qty: true },
      });
      const policy = await offlinePolicy(tx, auth.tenantId);
      return {
        asOf: new Date(),
        allowOversell: policy.allowOversell,
        data: rows.map((r) => ({
          productId: r.productId,
          qty: r.qty.toFixed(3),
        })),
      };
    });
  }
}
