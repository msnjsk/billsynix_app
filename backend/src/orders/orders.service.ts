import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Decimal, moneyInput } from '../common/decimal.js';
import { AppException } from '../common/errors/app-exception.js';
import { optionalText, text } from '../common/schemas.js';
import {
  assertPermission,
  canAccessStore,
  storeScope,
  type AuthContext,
} from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type {
  CustomerOrder,
  CustomerOrderStatus,
  Prisma,
} from '../generated/prisma/client.js';
import { nextNumber } from '../purchasing/purchasing.common.js';
import { todayIn } from '../sales/sales.common.js';

/* ---------- input ---------- */

export const createOrderSchema = z.object({
  /** The branch fulfilling it; defaults to the caller's only branch. */
  storeId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  customerName: text(100),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{6,20}$/, 'must be a phone number'),
  address: text(300),
  channel: z.enum(['WhatsApp', 'Phone', 'In store']),
  fulfilment: z.enum(['DELIVERY', 'PICKUP']),
  slot: text(20),
  payment: z.enum(['CASH_ON_DELIVERY', 'PREPAID_UPI', 'KHATA']),
  items: z
    .array(
      z.object({
        productId: z.uuid(),
        qty: z.number().int().min(1).max(10_000),
        /** Price agreed with the customer (tax inclusive, per unit). */
        price: moneyInput,
      }),
    )
    .min(1)
    .max(100),
  deliveryFee: moneyInput.default('0.00'),
  notes: optionalText(500),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const advanceSchema = z.object({
  to: z.enum(['PACKING', 'READY', 'DISPATCHED', 'COMPLETED', 'CANCELLED']),
  /** Who takes it out (dispatch). */
  rider: optionalText(60),
  /** How cash on delivery was collected (completion). */
  collectedBy: z.enum(['Cash', 'UPI']).optional(),
  /** Why (cancellation), or any note for the timeline. */
  note: optionalText(300),
});
export type AdvanceInput = z.infer<typeof advanceSchema>;

export const listOrdersQuery = z.object({
  storeId: z.uuid().optional(),
  /** Closed orders of this day are included (default today); open ones always are. */
  date: z.iso.date().optional(),
  customerId: z.uuid().optional(),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuery>;

/* ---------- rules ---------- */

/** Where an order may go next from each stage. */
const NEXT: Record<CustomerOrderStatus, CustomerOrderStatus[]> = {
  NEW: ['PACKING', 'CANCELLED'],
  PACKING: ['READY', 'CANCELLED'],
  READY: ['DISPATCHED', 'COMPLETED', 'CANCELLED'],
  DISPATCHED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

type Item = {
  productId: string;
  sku: string;
  name: string;
  price: string;
  qty: number;
};
type Event = {
  status: CustomerOrderStatus;
  at: string;
  note?: string;
  userId: string;
};

const err = (
  code: string,
  message: string,
  status: HttpStatus,
  field?: string,
) =>
  new AppException(
    code,
    message,
    status,
    field ? [{ field, issue: message }] : undefined,
  );

type Row = CustomerOrder & {
  sale: { invoiceNo: string; status: string } | null;
};
const withSale = {
  sale: { select: { invoiceNo: true, status: true } },
} as const;

const view = (o: Row) => ({
  id: o.id,
  number: o.number,
  storeId: o.storeId,
  customerId: o.customerId,
  customerName: o.customerName,
  phone: o.phone,
  address: o.address,
  channel: o.channel,
  fulfilment: o.fulfilment,
  slot: o.slot,
  payment: o.payment,
  paid: o.paid,
  collectedBy: o.collectedBy,
  rider: o.rider,
  items: o.items as Item[],
  subtotal: o.subtotal.toFixed(2),
  deliveryFee: o.deliveryFee.toFixed(2),
  total: o.total.toFixed(2),
  notes: o.notes,
  status: o.status,
  history: o.history as Event[],
  /** The bill made for it at the POS. */
  sale:
    o.sale && o.saleId
      ? { id: o.saleId, invoiceNo: o.sale.invoiceNo, status: o.sale.status }
      : null,
  createdAt: o.createdAt,
});

/**
 * Customer orders (phone / WhatsApp, delivery or pickup): received → packing → ready →
 * dispatched (with a rider) → completed (cash on delivery collected), or cancelled with a reason.
 * Each step is checked against the current stage under a row lock, so two people can't move the
 * same order twice. The order is the agreement with the customer; billing it (stock, invoice,
 * payment) happens at the POS.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private storeFor(auth: AuthContext, storeId: string | undefined) {
    const id =
      storeId ??
      auth.device?.storeId ??
      (auth.storeIds !== 'ALL' && auth.storeIds.length === 1
        ? auth.storeIds[0]
        : undefined);
    if (!id)
      throw err(
        'STORE_REQUIRED',
        'Say which branch fulfils this order.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'storeId',
      );
    if (!canAccessStore(auth, id))
      throw err('NOT_FOUND', 'Branch not found.', HttpStatus.NOT_FOUND);
    return id;
  }

  list(auth: AuthContext, q: ListOrdersQuery) {
    assertPermission(auth, 'sales:read');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (q.storeId && !canAccessStore(auth, q.storeId))
        throw err('NOT_FOUND', 'Branch not found.', HttpStatus.NOT_FOUND);
      const store = q.storeId
        ? await tx.store.findFirst({
            where: { id: q.storeId, tenantId: auth.tenantId },
          })
        : null;
      const day = q.date ?? todayIn(store?.timezone ?? 'Asia/Kolkata');
      // The shop's day, in its time zone.
      const from = new Date(`${day}T00:00:00+05:30`);
      const to = new Date(from.getTime() + 86_400_000);
      const rows = await tx.customerOrder.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(q.storeId ? { storeId: q.storeId } : storeScope(auth)),
          ...(q.customerId && { customerId: q.customerId }),
          ...(q.customerId
            ? {}
            : {
                OR: [
                  { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
                  { createdAt: { gte: from, lt: to } },
                  { updatedAt: { gte: from, lt: to } },
                ],
              }),
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
        include: withSale,
      });
      return { date: day, data: rows.map(view) };
    });
  }

  /** One order (the POS loads it to bill it). */
  get(auth: AuthContext, id: string) {
    assertPermission(auth, 'sales:read');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const o = await tx.customerOrder.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: withSale,
      });
      if (!o || !canAccessStore(auth, o.storeId))
        throw err('NOT_FOUND', 'Order not found.', HttpStatus.NOT_FOUND);
      return view(o);
    });
  }

  create(auth: AuthContext, input: CreateOrderInput, meta: RequestMeta) {
    assertPermission(auth, 'sales:create');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const storeId = this.storeFor(auth, input.storeId);
      const store = await tx.store.findFirst({
        where: { id: storeId, tenantId: auth.tenantId },
      });
      if (!store)
        throw err('NOT_FOUND', 'Branch not found.', HttpStatus.NOT_FOUND);
      if (store.status !== 'ACTIVE')
        throw err(
          'STORE_CLOSED',
          'This branch is not open.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      if (input.customerId) {
        const c = await tx.customer.findFirst({
          where: { id: input.customerId, tenantId: auth.tenantId },
        });
        if (!c)
          throw err(
            'INVALID_REFERENCE',
            'Customer not found.',
            HttpStatus.UNPROCESSABLE_ENTITY,
            'customerId',
          );
      } else if (input.payment === 'KHATA')
        throw err(
          'CUSTOMER_REQUIRED',
          'Khata is only for saved customers.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          'customerId',
        );
      if (input.fulfilment === 'PICKUP' && Number(input.deliveryFee) > 0)
        throw err(
          'INVALID_FEE',
          'A pickup order has no delivery fee.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          'deliveryFee',
        );

      const products = new Map(
        (
          await tx.product.findMany({
            where: {
              tenantId: auth.tenantId,
              id: { in: input.items.map((i) => i.productId) },
            },
            select: { id: true, sku: true, name: true, status: true },
          })
        ).map((p) => [p.id, p]),
      );
      const items: Item[] = input.items.map((i, n) => {
        const p = products.get(i.productId);
        if (!p)
          throw err(
            'INVALID_REFERENCE',
            'Product not found.',
            HttpStatus.UNPROCESSABLE_ENTITY,
            `items.${n}.productId`,
          );
        if (p.status !== 'ACTIVE')
          throw err(
            'PRODUCT_INACTIVE',
            `${p.name} is no longer sold.`,
            HttpStatus.UNPROCESSABLE_ENTITY,
            `items.${n}.productId`,
          );
        return {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          price: i.price,
          qty: i.qty,
        };
      });
      const subtotal = items.reduce(
        (s, i) => s.plus(new Decimal(i.price).times(i.qty)),
        new Decimal(0),
      );
      const fee = new Decimal(input.deliveryFee);
      const number = await nextNumber(tx, auth.tenantId, 'ORD');
      const o = await tx.customerOrder.create({
        data: {
          tenantId: auth.tenantId,
          storeId,
          number,
          customerId: input.customerId ?? null,
          customerName: input.customerName,
          phone: input.phone,
          address:
            input.fulfilment === 'PICKUP' ? 'Store pickup' : input.address,
          channel: input.channel,
          fulfilment: input.fulfilment,
          slot: input.slot,
          payment: input.payment,
          // Prepaid and khata orders are settled when placed; cash on delivery when collected.
          paid: input.payment !== 'CASH_ON_DELIVERY',
          items: items as unknown as Prisma.InputJsonValue,
          subtotal,
          deliveryFee: fee,
          total: subtotal.plus(fee),
          notes: input.notes ?? null,
          history: [
            {
              status: 'NEW',
              at: new Date().toISOString(),
              userId: auth.userId,
            },
          ] as unknown as Prisma.InputJsonValue,
          createdByUserId: auth.userId,
        },
        include: withSale,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'customer_order.created',
          entity: 'customer_order',
          entityId: o.id,
          data: { number, total: o.total.toFixed(2), payment: input.payment },
          meta,
        },
        tx,
      );
      return view(o);
    });
  }

  /** Moves an order one step on (or cancels it). */
  advance(
    auth: AuthContext,
    id: string,
    input: AdvanceInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'sales:create');
    return this.prisma.withTenant(auth.tenantId, async (tx: Tx) => {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM customer_orders WHERE id = ${id}::uuid AND tenant_id = ${auth.tenantId}::uuid FOR UPDATE`;
      const o = locked
        ? await tx.customerOrder.findUnique({
            where: { id: locked.id },
            include: withSale,
          })
        : null;
      if (!o || !canAccessStore(auth, o.storeId))
        throw err('NOT_FOUND', 'Order not found.', HttpStatus.NOT_FOUND);
      if (!NEXT[o.status].includes(input.to))
        throw err(
          'INVALID_STATE',
          `${o.number} is ${o.status.toLowerCase()} — it can't be marked ${input.to.toLowerCase()}.`,
          HttpStatus.CONFLICT,
        );
      if (input.to === 'DISPATCHED' && o.fulfilment !== 'DELIVERY')
        throw err(
          'INVALID_STATE',
          'A pickup order is handed over, not dispatched.',
          HttpStatus.CONFLICT,
        );
      if (input.to === 'DISPATCHED' && !input.rider)
        throw err(
          'RIDER_REQUIRED',
          'Say who is delivering it.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          'rider',
        );
      if (
        input.to === 'COMPLETED' &&
        o.fulfilment === 'DELIVERY' &&
        o.status !== 'DISPATCHED'
      )
        throw err(
          'INVALID_STATE',
          'Dispatch a delivery order before marking it delivered.',
          HttpStatus.CONFLICT,
        );
      if (input.to === 'COMPLETED' && !o.paid && !input.collectedBy)
        throw err(
          'COLLECTION_REQUIRED',
          'Say how the cash on delivery was collected.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          'collectedBy',
        );
      if (input.to === 'CANCELLED' && o.sale?.status === 'COMPLETED')
        throw err(
          'ORDER_BILLED',
          `${o.number} has been billed (${o.sale.invoiceNo}) — void or return the bill first.`,
          HttpStatus.CONFLICT,
        );
      if (input.to === 'CANCELLED' && !input.note)
        throw err(
          'REASON_REQUIRED',
          'Say why the order is cancelled.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          'note',
        );

      const note =
        input.note ??
        (input.to === 'DISPATCHED'
          ? `Rider: ${input.rider}`
          : input.to === 'COMPLETED' && input.collectedBy && !o.paid
            ? `Collected ₹${o.total.toFixed(2)} by ${input.collectedBy}`
            : undefined);
      const history = [
        ...(o.history as Event[]),
        {
          status: input.to,
          at: new Date().toISOString(),
          ...(note ? { note } : {}),
          userId: auth.userId,
        },
      ];
      const done = await tx.customerOrder.update({
        where: { id: o.id },
        data: {
          status: input.to,
          history: history as unknown as Prisma.InputJsonValue,
          ...(input.to === 'DISPATCHED' && { rider: input.rider ?? null }),
          ...(input.to === 'COMPLETED' &&
            !o.paid && { paid: true, collectedBy: input.collectedBy ?? null }),
        },
        include: withSale,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: `customer_order.${input.to.toLowerCase()}`,
          entity: 'customer_order',
          entityId: o.id,
          data: { number: o.number, from: o.status, ...(note ? { note } : {}) },
          meta,
        },
        tx,
      );
      return view(done);
    });
  }
}
