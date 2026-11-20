import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Decimal } from '../common/decimal.js';
import { idempotent } from '../common/idempotency.js';
import { page, skipTake } from '../common/schemas.js';
import { assertPermission, type AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  dateOnly,
  dateStr,
  nextNumber,
  notFound,
  postSupplierEntry,
  receiptOutstanding,
  todayIn,
  unprocessable,
} from './purchasing.common.js';
import type {
  CreatePaymentInput,
  ListPaymentsQuery,
} from './purchasing.schemas.js';

const include = {
  supplier: { select: { name: true } },
  allocations: {
    include: { grn: { select: { number: true, supplierInvoiceNo: true } } },
  },
} satisfies Prisma.SupplierPaymentInclude;
type PaymentRow = Prisma.SupplierPaymentGetPayload<{ include: typeof include }>;

/**
 * Supplier payments. A payment OUT reduces what we owe and is allocated to receipts (bills):
 * explicitly, or oldest due first; anything left over is an advance. A payment IN records the
 * supplier paying us back (when debit notes exceeded what we owed). No stock effect.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  view(p: PaymentRow) {
    const allocated = p.allocations.reduce(
      (s, a) => s.plus(a.amount),
      new Decimal(0),
    );
    return {
      id: p.id,
      number: p.number,
      supplier: { id: p.supplierId, name: p.supplier.name },
      direction: p.direction,
      amount: p.amount.toFixed(2),
      mode: p.mode,
      reference: p.reference,
      paidOn: dateStr(p.paidOn),
      notes: p.notes,
      allocations: p.allocations.map((a) => ({
        grnId: a.grnId,
        number: a.grn.number,
        supplierInvoiceNo: a.grn.supplierInvoiceNo,
        amount: a.amount.toFixed(2),
      })),
      unallocated:
        p.direction === 'OUT' ? p.amount.minus(allocated).toFixed(2) : '0.00',
      createdByUserId: p.createdByUserId,
      createdAt: p.createdAt,
    };
  }

  private async load(tx: Tx, auth: AuthContext, id: string) {
    const p = await tx.supplierPayment.findFirst({
      where: { id, tenantId: auth.tenantId },
      include,
    });
    if (!p) throw notFound('Payment');
    return p;
  }

  list(auth: AuthContext, q: ListPaymentsQuery) {
    assertPermission(auth, 'supplier-payments:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const where = {
        tenantId: auth.tenantId,
        ...(q.supplierId && { supplierId: q.supplierId }),
      };
      const rows = await tx.supplierPayment.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      });
      const total = await tx.supplierPayment.count({ where });
      return page(
        rows.map((r) => this.view(r)),
        total,
        q,
      );
    });
  }

  get(auth: AuthContext, id: string) {
    assertPermission(auth, 'supplier-payments:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) =>
      this.view(await this.load(tx, auth, id)),
    );
  }

  create(
    auth: AuthContext,
    input: CreatePaymentInput,
    key: string,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'supplier-payments:write');
    return this.prisma.withTenant(auth.tenantId, (tx) =>
      idempotent(
        tx,
        auth.tenantId,
        key,
        { route: 'POST supplier-payments', body: input },
        201,
        async () => {
          // Lock the supplier first: concurrent payments must not allocate the same bill twice.
          const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM suppliers WHERE id = ${input.supplierId}::uuid AND tenant_id = ${auth.tenantId}::uuid FOR UPDATE`;
          if (!locked.length)
            throw unprocessable(
              'INVALID_REFERENCE',
              'Supplier not found.',
              'supplierId',
            );
          const supplier = await tx.supplier.findUniqueOrThrow({
            where: { id: input.supplierId },
          });
          const tenant = await tx.tenant.findUniqueOrThrow({
            where: { id: auth.tenantId },
            select: { timezone: true },
          });
          const amount = new Decimal(input.amount);

          let allocations: { grnId: string; amount: Decimal }[] = [];
          if (input.direction === 'IN') {
            if (input.allocations?.length)
              throw unprocessable(
                'INVALID_ALLOCATION',
                'Money received back is not allocated to bills.',
                'allocations',
              );
          } else {
            const open = await tx.goodsReceipt.findMany({
              where: { tenantId: auth.tenantId, supplierId: supplier.id },
              select: { id: true, number: true },
              orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
            });
            const outstanding = await receiptOutstanding(
              tx,
              auth.tenantId,
              open.map((g) => g.id),
            );
            if (input.allocations) {
              input.allocations.forEach((a, n) => {
                const left = outstanding.get(a.grnId);
                if (left === undefined)
                  throw unprocessable(
                    'INVALID_REFERENCE',
                    'Not a receipt of this supplier.',
                    `allocations.${n}.grnId`,
                  );
                if (new Decimal(a.amount).gt(left))
                  throw unprocessable(
                    'OVER_ALLOCATION',
                    `Only ₹${left.toFixed(2)} is still owed on that receipt.`,
                    `allocations.${n}.amount`,
                  );
              });
              allocations = input.allocations.map((a) => ({
                grnId: a.grnId,
                amount: new Decimal(a.amount),
              }));
              const sum = allocations.reduce(
                (s, a) => s.plus(a.amount),
                new Decimal(0),
              );
              if (sum.gt(amount))
                throw unprocessable(
                  'OVER_ALLOCATION',
                  'Allocations add up to more than the payment.',
                  'allocations',
                );
            } else {
              let left = amount;
              for (const g of open) {
                const owed = outstanding.get(g.id) ?? new Decimal(0);
                if (left.lte(0)) break;
                if (owed.lte(0)) continue;
                const take = Decimal.min(left, owed);
                allocations.push({ grnId: g.id, amount: take });
                left = left.minus(take);
              }
            }
          }

          const paidOn = input.paidOn ?? todayIn(tenant.timezone);
          const number = await nextNumber(tx, auth.tenantId, 'PAY');
          const payment = await tx.supplierPayment.create({
            data: {
              tenantId: auth.tenantId,
              number,
              supplierId: supplier.id,
              direction: input.direction,
              amount,
              mode: input.mode,
              reference: input.reference ?? null,
              paidOn: dateOnly(paidOn),
              notes: input.notes ?? null,
              createdByUserId: auth.userId,
            },
          });
          if (allocations.length)
            await tx.paymentAllocation.createMany({
              data: allocations.map((a) => ({
                tenantId: auth.tenantId,
                paymentId: payment.id,
                ...a,
              })),
            });
          await postSupplierEntry(tx, {
            tenantId: auth.tenantId,
            supplierId: supplier.id,
            type: input.direction === 'OUT' ? 'PAYMENT' : 'REFUND',
            amount: input.direction === 'OUT' ? amount.negated() : amount,
            date: dateOnly(paidOn),
            refType: 'PAYMENT',
            refId: payment.id,
            refNo: number,
            note: [input.mode.replace('_', ' ').toLowerCase(), input.reference]
              .filter(Boolean)
              .join(' · '),
            userId: auth.userId,
          });
          await this.audit.record(
            {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: 'supplier_payment.recorded',
              entity: 'supplier_payment',
              entityId: payment.id,
              data: {
                number,
                direction: input.direction,
                amount: amount.toFixed(2),
                allocations: allocations.length,
              },
              meta,
            },
            tx,
          );
          return this.view(await this.load(tx, auth, payment.id));
        },
      ),
    );
  }
}
