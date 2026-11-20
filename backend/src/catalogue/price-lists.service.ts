import { Injectable } from '@nestjs/common';
import { PrismaService, inOrder, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { money } from '../common/decimal.js';
import { page, skipTake, type PaginationQuery } from '../common/schemas.js';
import {
  assertPermission,
  canAccessStore,
  type AuthContext,
} from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import { AppException } from '../common/errors/app-exception.js';
import { HttpStatus } from '@nestjs/common';
import { alreadyExists, notFound, unprocessable } from './catalogue.errors.js';
import { priceListView } from './catalogue.views.js';
import { priceAboveMrp } from './pricing.js';
import type {
  AssignPriceListInput,
  CreatePriceListInput,
  SetPricesInput,
  UpdatePriceListInput,
} from './catalogue.schemas.js';

/**
 * Branch pricing. A price list holds prices for some products; a branch assigned to it bills
 * those products at the list price and everything else at the product's own selling price.
 *
 * Who may edit a list: anyone with `prices:write` whose branches cover every branch using it —
 * so a branch manager can price their own branch but never change prices at another one.
 */
@Injectable()
export class PriceListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async load(tx: Tx, auth: AuthContext, id: string) {
    const list = await tx.priceList.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { stores: { select: { id: true } } },
    });
    if (!list) throw notFound('Price list');
    return list;
  }

  private assertCanEdit(auth: AuthContext, storeIds: string[]) {
    const outside = storeIds.filter((s) => !canAccessStore(auth, s));
    if (outside.length)
      throw new AppException(
        'FORBIDDEN',
        'This price list is used by branches you do not manage.',
        HttpStatus.FORBIDDEN,
      );
  }

  private async assertNameFree(
    tx: Tx,
    tenantId: string,
    name: string,
    exceptId?: string,
  ) {
    const clash = await tx.priceList.findFirst({
      where: {
        tenantId,
        name: { equals: name, mode: 'insensitive' },
        NOT: exceptId ? { id: exceptId } : undefined,
      },
      select: { id: true },
    });
    if (clash)
      throw alreadyExists(`A price list named "${name}" exists.`, 'name');
  }

  list(auth: AuthContext) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.priceList.findMany({
        where: { tenantId: auth.tenantId },
        include: { stores: { select: { id: true } } },
        orderBy: { name: 'asc' },
      });
      return {
        data: rows.map((l) =>
          priceListView(
            l,
            l.stores.map((s) => s.id),
          ),
        ),
      };
    });
  }

  get(auth: AuthContext, id: string) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const l = await this.load(tx, auth, id);
      return priceListView(
        l,
        l.stores.map((s) => s.id),
      );
    });
  }

  create(auth: AuthContext, input: CreatePriceListInput, meta: RequestMeta) {
    assertPermission(auth, 'prices:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      await this.assertNameFree(tx, auth.tenantId, input.name);
      const l = await tx.priceList.create({
        data: { tenantId: auth.tenantId, name: input.name },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'price_list.created',
          entity: 'price_list',
          entityId: l.id,
          data: { name: l.name },
          meta,
        },
        tx,
      );
      return priceListView(l, []);
    });
  }

  update(
    auth: AuthContext,
    id: string,
    patch: UpdatePriceListInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'prices:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.load(tx, auth, id);
      const storeIds = cur.stores.map((s) => s.id);
      this.assertCanEdit(auth, storeIds);
      if (patch.name)
        await this.assertNameFree(tx, auth.tenantId, patch.name, cur.id);
      const l = await tx.priceList.update({
        where: { id: cur.id },
        data: patch,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'price_list.updated',
          entity: 'price_list',
          entityId: l.id,
          data: patch,
          meta,
        },
        tx,
      );
      return priceListView(l, storeIds);
    });
  }

  prices(auth: AuthContext, id: string, q: PaginationQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const l = await this.load(tx, auth, id);
      const where = { tenantId: auth.tenantId, priceListId: l.id };
      const [rows, total] = await inOrder(
        () =>
          tx.productPrice.findMany({
            where,
            include: {
              product: {
                select: {
                  id: true,
                  sku: true,
                  name: true,
                  sellingPrice: true,
                  mrp: true,
                },
              },
            },
            orderBy: { product: { name: 'asc' } },
            ...skipTake(q),
          }),
        () => tx.productPrice.count({ where }),
      );
      return page(
        rows.map((r) => ({
          productId: r.productId,
          sku: r.product.sku,
          name: r.product.name,
          sellingPrice: money(r.sellingPrice),
          defaultPrice: money(r.product.sellingPrice),
          mrp: r.product.mrp ? money(r.product.mrp) : null,
          updatedAt: r.updatedAt,
        })),
        total,
        q,
      );
    });
  }

  /** Sets (creates or replaces) up to 500 prices at once; all or nothing. */
  setPrices(
    auth: AuthContext,
    id: string,
    input: SetPricesInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'prices:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const l = await this.load(tx, auth, id);
      this.assertCanEdit(
        auth,
        l.stores.map((s) => s.id),
      );
      const ids = input.items.map((i) => i.productId);
      const products = new Map(
        (
          await tx.product.findMany({
            where: { tenantId: auth.tenantId, id: { in: ids } },
            include: { taxRate: true },
          })
        ).map((p) => [p.id, p]),
      );
      input.items.forEach((item, i) => {
        const p = products.get(item.productId);
        if (!p)
          throw unprocessable(
            'INVALID_REFERENCE',
            'Product not found.',
            `items.${i}.productId`,
          );
        const problem = priceAboveMrp(
          {
            mrp: p.mrp,
            sellingPrice: item.sellingPrice,
            priceIncludesTax: p.priceIncludesTax,
          },
          p.taxRate,
        );
        if (problem)
          throw unprocessable(
            'PRICE_ABOVE_MRP',
            `${p.name}: ${problem}`,
            `items.${i}.sellingPrice`,
          );
      });
      for (const item of input.items) {
        await tx.productPrice.upsert({
          where: {
            priceListId_productId: {
              priceListId: l.id,
              productId: item.productId,
            },
          },
          create: {
            tenantId: auth.tenantId,
            priceListId: l.id,
            productId: item.productId,
            sellingPrice: item.sellingPrice,
          },
          update: { sellingPrice: item.sellingPrice },
        });
      }
      await tx.priceList.update({
        where: { id: l.id },
        data: { updatedAt: new Date() },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'price_list.prices_set',
          entity: 'price_list',
          entityId: l.id,
          data: { count: input.items.length, items: input.items.slice(0, 50) },
          meta,
        },
        tx,
      );
      return { updated: input.items.length };
    });
  }

  removePrice(
    auth: AuthContext,
    id: string,
    productId: string,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'prices:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const l = await this.load(tx, auth, id);
      this.assertCanEdit(
        auth,
        l.stores.map((s) => s.id),
      );
      const { count } = await tx.productPrice.deleteMany({
        where: { tenantId: auth.tenantId, priceListId: l.id, productId },
      });
      if (!count) throw notFound('Price');
      // The product now bills at its own price again: a new version, so POS catalogue caches
      // (GET /sync/catalogue) pick the change up.
      await tx.product.updateMany({
        where: { tenantId: auth.tenantId, id: productId },
        data: { version: { increment: 1 } },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'price_list.price_removed',
          entity: 'price_list',
          entityId: l.id,
          data: { productId },
          meta,
        },
        tx,
      );
    });
  }

  /**
   * Points a branch at a price list (or none). Taking a list into use adds a branch to the set
   * the list's editors must manage, so a branch manager can only attach a list nobody outside
   * their branches uses.
   */
  assign(
    auth: AuthContext,
    storeId: string,
    input: AssignPriceListInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'prices:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const store = await tx.store.findFirst({
        where: { id: storeId, tenantId: auth.tenantId },
      });
      if (!store || !canAccessStore(auth, store.id)) throw notFound('Branch');
      if (input.priceListId) {
        const l = await this.load(tx, auth, input.priceListId);
        this.assertCanEdit(
          auth,
          l.stores.map((s) => s.id),
        );
      }
      await tx.store.update({
        where: { id: store.id },
        data: { priceListId: input.priceListId },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'store.price_list_assigned',
          entity: 'store',
          entityId: store.id,
          data: { from: store.priceListId, to: input.priceListId },
          meta,
        },
        tx,
      );
      return { storeId: store.id, priceListId: input.priceListId };
    });
  }
}
