import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Decimal } from '../common/decimal.js';
import { page, skipTake } from '../common/schemas.js';
import {
  assertPermission,
  can,
  canAccessStore,
  type AuthContext,
} from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Prisma } from '../generated/prisma/client.js';
import { assertActive, visibleStore } from '../inventory/inventory.common.js';
import {
  docTotals,
  lineAmounts,
  netRate,
  totalsView,
} from './purchase-math.js';
import {
  conflict,
  dateOnly,
  dateStr,
  nextNumber,
  notFound,
  purchaseOrderLimit,
  todayIn,
  unprocessable,
} from './purchasing.common.js';
import {
  assertQty,
  gstContext,
  loadProducts,
  priceLine,
  supplierCosts,
} from './lines.js';
import type {
  CreatePoInput,
  ListPoQuery,
  PoItemInput,
  UpdatePoInput,
} from './purchasing.schemas.js';

const include = {
  supplier: { select: { name: true, gstin: true } },
  store: { select: { code: true, name: true } },
  items: {
    include: {
      product: {
        select: { sku: true, name: true, unit: { select: { code: true } } },
      },
    },
    orderBy: [{ product: { name: 'asc' as const } }, { id: 'asc' as const }],
  },
} satisfies Prisma.PurchaseOrderInclude;

type PoRow = Prisma.PurchaseOrderGetPayload<{ include: typeof include }>;

/**
 * Purchase orders: DRAFT → (submit) SENT, or PENDING_APPROVAL → (approve) SENT when the total is
 * above the business's limit (settings.approvalLimits.purchaseOrderValue, ₹50,000 by default) and
 * the author can't approve. Receipts then move it to PARTIAL / RECEIVED; CLOSED stops it short.
 * A PO has no stock or payable effect of its own.
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  view(po: PoRow) {
    let ordered = new Decimal(0);
    let received = new Decimal(0);
    const items = po.items.map((i) => {
      ordered = ordered.plus(i.qty);
      received = received.plus(Decimal.min(i.qty, i.receivedQty));
      return {
        id: i.id,
        product: {
          id: i.productId,
          sku: i.product.sku,
          name: i.product.name,
          unit: i.product.unit.code,
        },
        qty: i.qty.toFixed(3),
        rate: i.rate.toFixed(2),
        discountPct: Number(i.discountPct),
        netRate: netRate(i).toFixed(2),
        gstRate: Number(i.gstRate),
        cessRate: Number(i.cessRate),
        hsnCode: i.hsnCode,
        taxable: i.taxable.toFixed(2),
        tax: i.tax.toFixed(2),
        receivedQty: i.receivedQty.toFixed(3),
        pendingQty: Decimal.max(0, i.qty.minus(i.receivedQty)).toFixed(3),
      };
    });
    return {
      id: po.id,
      number: po.number,
      supplier: {
        id: po.supplierId,
        name: po.supplier.name,
        gstin: po.supplier.gstin,
      },
      store: { id: po.storeId, code: po.store.code, name: po.store.name },
      status: po.status,
      orderDate: dateStr(po.orderDate),
      expectedDate: dateStr(po.expectedDate),
      notes: po.notes,
      gstApplies: po.gstApplies,
      interState: po.interState,
      totals: totalsView(po),
      progress: {
        ordered: ordered.toFixed(3),
        received: received.toFixed(3),
        pct: ordered.isZero()
          ? 0
          : Math.round(received.dividedBy(ordered).times(100).toNumber()),
      },
      items,
      createdByUserId: po.createdByUserId,
      approvedByUserId: po.approvedByUserId,
      sentAt: po.sentAt,
      createdAt: po.createdAt,
      updatedAt: po.updatedAt,
    };
  }

  async load(tx: Tx, auth: AuthContext, id: string) {
    const po = await tx.purchaseOrder.findFirst({
      where: { id, tenantId: auth.tenantId },
      include,
    });
    if (!po || !canAccessStore(auth, po.storeId))
      throw notFound('Purchase order');
    return po;
  }

  /** Prices the lines and returns rows + totals for the given supplier and branch. */
  private async build(
    tx: Tx,
    auth: AuthContext,
    supplierId: string,
    storeId: string,
    items: PoItemInput[],
  ) {
    const [supplier, store, tenant] = [
      await tx.supplier.findFirst({
        where: { id: supplierId, tenantId: auth.tenantId },
      }),
      await visibleStore(tx, auth, storeId),
      await tx.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
        select: { registration: true, timezone: true },
      }),
    ];
    if (!supplier)
      throw unprocessable(
        'INVALID_REFERENCE',
        'Supplier not found.',
        'supplierId',
      );
    if (supplier.status !== 'ACTIVE')
      throw unprocessable(
        'SUPPLIER_INACTIVE',
        `${supplier.name} is inactive.`,
        'supplierId',
      );
    assertActive(store);
    const ctx = gstContext(supplier, store, tenant.registration);
    const products = await loadProducts(
      tx,
      auth.tenantId,
      items.map((i) => i.productId),
    );
    const costs = await supplierCosts(
      tx,
      auth.tenantId,
      supplierId,
      items.map((i) => i.productId),
    );
    const rows = items.map((it, n) => {
      const p = products.get(it.productId);
      if (!p)
        throw unprocessable(
          'INVALID_REFERENCE',
          'Product not found.',
          `items.${n}.productId`,
        );
      const qty = new Decimal(it.qty);
      assertQty(p, qty, `items.${n}.qty`);
      const priced = priceLine(p, it, `items.${n}`, costs.get(p.id));
      const a = lineAmounts({ qty, ...priced }, ctx.gstApplies);
      return {
        productId: p.id,
        qty,
        ...priced,
        taxable: a.taxable,
        tax: a.gst.plus(a.cess),
      };
    });
    const totals = docTotals(rows, ctx.gstApplies, ctx.interState);
    return { ctx, rows, totals, tenant };
  }

  list(auth: AuthContext, q: ListPoQuery) {
    assertPermission(auth, 'purchases:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (q.storeId && !canAccessStore(auth, q.storeId))
        throw notFound('Branch');
      const where: Prisma.PurchaseOrderWhereInput = {
        tenantId: auth.tenantId,
        ...(q.supplierId && { supplierId: q.supplierId }),
        ...(q.storeId
          ? { storeId: q.storeId }
          : auth.storeIds === 'ALL'
            ? {}
            : { storeId: { in: [...auth.storeIds] } }),
        ...(q.status === 'OPEN'
          ? { status: { in: ['SENT', 'PARTIAL'] } }
          : q.status
            ? { status: q.status }
            : {}),
      };
      const rows = await tx.purchaseOrder.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      });
      const total = await tx.purchaseOrder.count({ where });
      return page(
        rows.map((r) => this.view(r)),
        total,
        q,
      );
    });
  }

  get(auth: AuthContext, id: string) {
    assertPermission(auth, 'purchases:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) =>
      this.view(await this.load(tx, auth, id)),
    );
  }

  create(auth: AuthContext, input: CreatePoInput, meta: RequestMeta) {
    assertPermission(auth, 'purchases:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const { ctx, rows, totals, tenant } = await this.build(
        tx,
        auth,
        input.supplierId,
        input.storeId,
        input.items,
      );
      const po = await tx.purchaseOrder.create({
        data: {
          tenantId: auth.tenantId,
          number: await nextNumber(tx, auth.tenantId, 'PO'),
          supplierId: input.supplierId,
          storeId: input.storeId,
          orderDate: dateOnly(input.orderDate ?? todayIn(tenant.timezone)),
          expectedDate: input.expectedDate
            ? dateOnly(input.expectedDate)
            : null,
          notes: input.notes ?? null,
          gstApplies: ctx.gstApplies,
          interState: ctx.interState,
          ...totals,
          createdByUserId: auth.userId,
        },
      });
      await tx.purchaseOrderItem.createMany({
        data: rows.map((r) => ({ tenantId: auth.tenantId, poId: po.id, ...r })),
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'purchase_order.created',
          entity: 'purchase_order',
          entityId: po.id,
          data: { number: po.number, total: totals.total.toFixed(2) },
          meta,
        },
        tx,
      );
      return this.view(await this.load(tx, auth, po.id));
    });
  }

  update(
    auth: AuthContext,
    id: string,
    patch: UpdatePoInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'purchases:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.load(tx, auth, id);
      if (cur.status !== 'DRAFT')
        throw conflict(
          'INVALID_STATE',
          'Only a draft purchase order can be edited.',
        );
      let data: Prisma.PurchaseOrderUpdateInput = {
        ...(patch.expectedDate !== undefined && {
          expectedDate: patch.expectedDate
            ? dateOnly(patch.expectedDate)
            : null,
        }),
        ...(patch.notes !== undefined && { notes: patch.notes }),
      };
      if (patch.items) {
        const { ctx, rows, totals } = await this.build(
          tx,
          auth,
          cur.supplierId,
          cur.storeId,
          patch.items,
        );
        await tx.purchaseOrderItem.deleteMany({
          where: { tenantId: auth.tenantId, poId: cur.id },
        });
        await tx.purchaseOrderItem.createMany({
          data: rows.map((r) => ({
            tenantId: auth.tenantId,
            poId: cur.id,
            ...r,
          })),
        });
        data = {
          ...data,
          ...totals,
          gstApplies: ctx.gstApplies,
          interState: ctx.interState,
        };
      }
      await tx.purchaseOrder.update({ where: { id: cur.id }, data });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'purchase_order.updated',
          entity: 'purchase_order',
          entityId: cur.id,
          data: { fields: Object.keys(patch) },
          meta,
        },
        tx,
      );
      return this.view(await this.load(tx, auth, cur.id));
    });
  }

  submit(auth: AuthContext, id: string, meta: RequestMeta) {
    assertPermission(auth, 'purchases:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.load(tx, auth, id);
      if (cur.status !== 'DRAFT')
        throw conflict(
          'INVALID_STATE',
          `This purchase order is ${cur.status.toLowerCase()}.`,
        );
      const over = cur.total.gt(await purchaseOrderLimit(tx, auth.tenantId));
      const send = !over || can(auth, 'purchases:approve');
      await tx.purchaseOrder.update({
        where: { id: cur.id },
        data: send
          ? {
              status: 'SENT',
              sentAt: new Date(),
              ...(over && { approvedByUserId: auth.userId }),
            }
          : { status: 'PENDING_APPROVAL' },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: send
            ? 'purchase_order.sent'
            : 'purchase_order.approval_requested',
          entity: 'purchase_order',
          entityId: cur.id,
          data: { total: cur.total.toFixed(2) },
          meta,
        },
        tx,
      );
      return this.view(await this.load(tx, auth, cur.id));
    });
  }

  approve(auth: AuthContext, id: string, meta: RequestMeta) {
    assertPermission(auth, 'purchases:approve');
    return this.transition(
      auth,
      id,
      ['PENDING_APPROVAL'],
      { status: 'SENT', sentAt: new Date(), approvedByUserId: auth.userId },
      'purchase_order.approved',
      meta,
    );
  }

  /** Before anything was received. */
  async cancel(auth: AuthContext, id: string, meta: RequestMeta) {
    assertPermission(auth, 'purchases:write');
    return this.transition(
      auth,
      id,
      ['DRAFT', 'PENDING_APPROVAL', 'SENT'],
      { status: 'CANCELLED' },
      'purchase_order.cancelled',
      meta,
      true,
    );
  }

  /** The rest won't come: no more receipts against it. */
  close(auth: AuthContext, id: string, meta: RequestMeta) {
    assertPermission(auth, 'purchases:write');
    return this.transition(
      auth,
      id,
      ['SENT', 'PARTIAL'],
      { status: 'CLOSED' },
      'purchase_order.closed',
      meta,
    );
  }

  private transition(
    auth: AuthContext,
    id: string,
    from: PoRow['status'][],
    data: Prisma.PurchaseOrderUpdateManyMutationInput,
    action: string,
    meta: RequestMeta,
    nothingReceived = false,
  ) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.load(tx, auth, id);
      if (nothingReceived && cur.items.some((i) => i.receivedQty.gt(0)))
        throw conflict(
          'INVALID_STATE',
          'Goods were already received against this order — close it instead.',
        );
      const done = await tx.purchaseOrder.updateMany({
        where: { id: cur.id, tenantId: auth.tenantId, status: { in: from } },
        data,
      });
      if (!done.count)
        throw conflict(
          'INVALID_STATE',
          `This purchase order is ${cur.status.toLowerCase().replace('_', ' ')}.`,
        );
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action,
          entity: 'purchase_order',
          entityId: cur.id,
          meta,
        },
        tx,
      );
      return this.view(await this.load(tx, auth, cur.id));
    });
  }
}
