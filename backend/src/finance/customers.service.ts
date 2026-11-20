import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Decimal } from '../common/decimal.js';
import { AppException } from '../common/errors/app-exception.js';
import { gstinProblem } from '../common/gst.js';
import { idempotent } from '../common/idempotency.js';
import { page, skipTake } from '../common/schemas.js';
import {
  assertPermission,
  canAccessStore,
  type AuthContext,
} from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Customer, Prisma } from '../generated/prisma/client.js';
import { nextNumber } from '../purchasing/purchasing.common.js';
import { dateOnly, todayIn } from '../sales/sales.common.js';
import { postCustomerTxn } from './customer-ledger.js';
import type {
  CreateCustomerInput,
  ListCustomersQuery,
  ReceiptInput,
  UpdateCustomerInput,
} from './finance.schemas.js';

const ZERO = new Decimal(0);
const unprocessable = (code: string, message: string, field?: string) =>
  new AppException(
    code,
    message,
    HttpStatus.UNPROCESSABLE_ENTITY,
    field ? [{ field, issue: message }] : undefined,
  );
const notFound = () =>
  new AppException('NOT_FOUND', 'Customer not found.', HttpStatus.NOT_FOUND);

const view = (c: Customer) => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  email: c.email,
  gstin: c.gstin,
  addressLine1: c.addressLine1,
  city: c.city,
  pincode: c.pincode,
  creditLimit: c.creditLimit.toFixed(2),
  balance: c.balance.toFixed(2),
  /** How much more they may buy on account. */
  creditAvailable: Decimal.max(ZERO, c.creditLimit.minus(c.balance)).toFixed(2),
  notes: c.notes,
  status: c.status,
  createdAt: c.createdAt,
});

/**
 * Customers and their account (khata): credit sales raise what they owe, credit refunds and
 * receipts lower it, every change is a row of the append-only `customer_transactions` ledger.
 * Basic by design (docs/phase-0 §3): no interest, no statements by post.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private checkGstin(gstin: string | null | undefined) {
    if (!gstin) return;
    const p = gstinProblem(gstin);
    if (p) throw unprocessable('INVALID_GSTIN', p, 'gstin');
  }

  private async phoneFree(
    tx: Tx,
    tenantId: string,
    phone: string | null | undefined,
    except?: string,
  ) {
    if (!phone) return;
    const clash = await tx.customer.findFirst({
      where: { tenantId, phone, ...(except ? { id: { not: except } } : {}) },
      select: { name: true },
    });
    if (clash)
      throw new AppException(
        'ALREADY_EXISTS',
        `${clash.name} already has this phone number.`,
        HttpStatus.CONFLICT,
        [{ field: 'phone', issue: 'taken' }],
      );
  }

  private async load(tx: Tx, tenantId: string, id: string) {
    const c = await tx.customer.findFirst({ where: { id, tenantId } });
    if (!c) throw notFound();
    return c;
  }

  list(auth: AuthContext, q: ListCustomersQuery) {
    assertPermission(auth, 'customers:read');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const where: Prisma.CustomerWhereInput = {
        tenantId: auth.tenantId,
        ...(q.status !== 'ALL' && { status: q.status }),
        ...(q.owing && { balance: { gt: 0 } }),
        ...(q.q && {
          OR: [
            { name: { contains: q.q, mode: 'insensitive' } },
            { phone: { contains: q.q } },
          ],
        }),
      };
      const rows = await tx.customer.findMany({
        where,
        orderBy: { name: 'asc' },
        ...skipTake(q),
      });
      const stats = await this.stats(
        tx,
        auth.tenantId,
        rows.map((r) => r.id),
      );
      return page(
        rows.map((c) => ({ ...view(c), ...stats(c.id) })),
        await tx.customer.count({ where }),
        q,
      );
    });
  }

  /**
   * Per customer, from their bills: visits and spend over the 90 days before today, last visit,
   * and since when they owe money (oldest credit not paid back since the account was last clear).
   */
  private async stats(tx: Tx, tenantId: string, ids: string[]) {
    if (!ids.length)
      return () => ({
        visits90: 0,
        spend90: '0.00',
        lastVisit: null,
        owingSince: null,
      });
    const today = todayIn('Asia/Kolkata');
    const rows = await tx.$queryRaw<
      {
        id: string;
        visits: bigint;
        spend: Decimal | null;
        last: Date | null;
        owing: Date | null;
      }[]
    >`
      SELECT c.id::text,
             (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status = 'COMPLETED'
                AND s.business_date >= ${today}::date - 90 AND s.business_date < ${today}::date) AS visits,
             (SELECT SUM(s.payable) FROM sales s WHERE s.customer_id = c.id AND s.status = 'COMPLETED'
                AND s.business_date >= ${today}::date - 90 AND s.business_date < ${today}::date) AS spend,
             (SELECT MAX(s.business_date) FROM sales s WHERE s.customer_id = c.id AND s.status = 'COMPLETED') AS last,
             CASE WHEN c.balance > 0 THEN
               (SELECT MIN(t.date) FROM customer_transactions t WHERE t.customer_id = c.id AND t.type IN ('SALE', 'OPENING')
                  AND t.seq > COALESCE((SELECT MAX(z.seq) FROM customer_transactions z WHERE z.customer_id = c.id AND z.balance_after <= 0), 0))
             END AS owing
      FROM customers c
      WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ANY(${ids}::uuid[])`;
    const by = new Map(rows.map((r) => [r.id, r]));
    return (id: string) => {
      const r = by.get(id);
      return {
        visits90: Number(r?.visits ?? 0),
        spend90: new Decimal(r?.spend ?? 0).toFixed(2),
        lastVisit: r?.last ? r.last.toISOString().slice(0, 10) : null,
        owingSince: r?.owing ? r.owing.toISOString().slice(0, 10) : null,
      };
    };
  }

  get(auth: AuthContext, id: string) {
    assertPermission(auth, 'customers:read');
    return this.prisma.withTenant(auth.tenantId, async (tx) =>
      view(await this.load(tx, auth.tenantId, id)),
    );
  }

  create(auth: AuthContext, input: CreateCustomerInput, meta: RequestMeta) {
    assertPermission(auth, 'customers:write');
    this.checkGstin(input.gstin);
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      await this.phoneFree(tx, auth.tenantId, input.phone);
      const c = await tx.customer.create({
        data: {
          tenantId: auth.tenantId,
          name: input.name,
          phone: input.phone ?? null,
          email: input.email ?? null,
          gstin: input.gstin ?? null,
          addressLine1: input.addressLine1 ?? null,
          city: input.city ?? null,
          pincode: input.pincode ?? null,
          creditLimit: input.creditLimit,
          notes: input.notes ?? null,
        },
      });
      if (input.openingBalance && new Decimal(input.openingBalance).gt(0)) {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: auth.tenantId },
        });
        await postCustomerTxn(tx, {
          tenantId: auth.tenantId,
          customerId: c.id,
          type: 'OPENING',
          amount: new Decimal(input.openingBalance),
          date: dateOnly(todayIn(tenant.timezone)),
          refType: 'OPENING',
          refId: c.id,
          refNo: 'Opening balance',
          userId: auth.userId,
        });
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'customer.created',
          entity: 'customer',
          entityId: c.id,
          data: {
            name: c.name,
            creditLimit: input.creditLimit,
            openingBalance: input.openingBalance ?? null,
          },
          meta,
        },
        tx,
      );
      return view(await this.load(tx, auth.tenantId, c.id));
    });
  }

  update(
    auth: AuthContext,
    id: string,
    patch: UpdateCustomerInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'customers:write');
    this.checkGstin(patch.gstin);
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.load(tx, auth.tenantId, id);
      await this.phoneFree(tx, auth.tenantId, patch.phone, cur.id);
      const c = await tx.customer.update({
        where: { id: cur.id },
        data: patch,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'customer.updated',
          entity: 'customer',
          entityId: c.id,
          data: {
            fields: Object.keys(patch),
            ...(patch.creditLimit !== undefined && {
              creditLimit: patch.creditLimit,
            }),
          },
          meta,
        },
        tx,
      );
      return view(c);
    });
  }

  /** The account statement: every credit sale, return, receipt with the balance after it. */
  ledger(auth: AuthContext, id: string) {
    assertPermission(auth, 'customers:read');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const c = await this.load(tx, auth.tenantId, id);
      const rows = await tx.customerTransaction.findMany({
        where: { tenantId: auth.tenantId, customerId: c.id },
        orderBy: { seq: 'desc' },
        take: 500,
      });
      return {
        customer: view(c),
        data: rows.map((r) => ({
          id: r.id,
          date: r.date.toISOString().slice(0, 10),
          type: r.type,
          amount: r.amount.toFixed(2),
          balanceAfter: r.balanceAfter.toFixed(2),
          refType: r.refType,
          refId: r.refId,
          refNo: r.refNo,
          note: r.note,
          createdAt: r.createdAt,
        })),
      };
    });
  }

  /**
   * The customer paid towards their account. Cash received by someone with an open drawer goes
   * into that drawer (a PAY_IN), so the drawer still adds up at closing.
   */
  receipt(
    auth: AuthContext,
    id: string,
    input: ReceiptInput,
    key: string,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'customers:write');
    return this.prisma.withTenant(auth.tenantId, (tx) =>
      idempotent(
        tx,
        auth.tenantId,
        key,
        { route: `POST customers/${id}/receipts`, body: input },
        201,
        async () => {
          const [locked] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM customers WHERE id = ${id}::uuid AND tenant_id = ${auth.tenantId}::uuid FOR UPDATE`;
          if (!locked) throw notFound();
          const c = await this.load(tx, auth.tenantId, id);
          const drawer =
            input.method === 'CASH'
              ? await tx.cashSession.findFirst({
                  where: {
                    tenantId: auth.tenantId,
                    userId: auth.userId,
                    status: 'OPEN',
                  },
                })
              : null;
          let storeId =
            drawer?.storeId ?? input.storeId ?? auth.device?.storeId;
          if (!storeId && auth.storeIds !== 'ALL' && auth.storeIds.length === 1)
            storeId = auth.storeIds[0];
          if (!storeId)
            throw unprocessable(
              'STORE_REQUIRED',
              'Say which branch received it.',
              'storeId',
            );
          if (!canAccessStore(auth, storeId))
            throw unprocessable(
              'INVALID_REFERENCE',
              'Branch not found.',
              'storeId',
            );
          const store = await tx.store.findFirstOrThrow({
            where: { id: storeId, tenantId: auth.tenantId },
          });
          const amount = new Decimal(input.amount);
          const number = await nextNumber(tx, auth.tenantId, 'RCPT');
          const today = todayIn(store.timezone);
          const r = await tx.customerReceipt.create({
            data: {
              tenantId: auth.tenantId,
              number,
              customerId: c.id,
              storeId,
              amount,
              method: input.method,
              reference: input.reference ?? null,
              receivedOn: dateOnly(today),
              cashSessionId: drawer?.id ?? null,
              note: input.note ?? null,
              createdByUserId: auth.userId,
            },
          });
          if (drawer)
            await tx.cashMovement.create({
              data: {
                tenantId: auth.tenantId,
                sessionId: drawer.id,
                type: 'PAY_IN',
                amount,
                reason: `Customer payment ${number} — ${c.name}`,
                userId: auth.userId,
              },
            });
          const t = await postCustomerTxn(tx, {
            tenantId: auth.tenantId,
            customerId: c.id,
            type: 'RECEIPT',
            amount: amount.negated(),
            date: dateOnly(today),
            refType: 'CUSTOMER_RECEIPT',
            refId: r.id,
            refNo: number,
            note: input.reference ?? null,
            userId: auth.userId,
          });
          await this.audit.record(
            {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: 'customer.receipt',
              entity: 'customer',
              entityId: c.id,
              data: {
                number,
                amount: amount.toFixed(2),
                method: input.method,
                drawer: drawer?.id ?? null,
              },
              meta,
            },
            tx,
          );
          return {
            id: r.id,
            number,
            customerId: c.id,
            amount: amount.toFixed(2),
            method: r.method,
            reference: r.reference,
            receivedOn: today,
            cashSessionId: r.cashSessionId,
            balanceAfter: t.balanceAfter.toFixed(2),
          };
        },
      ),
    );
  }

  /** Who owes what, oldest unpaid first, with ageing from the last receipt. */
  receivables(auth: AuthContext) {
    assertPermission(auth, 'customers:read');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          name: string;
          phone: string | null;
          balance: Decimal;
          credit_limit: Decimal;
          last_sale: Date | null;
          last_receipt: Date | null;
          first_open: Date | null;
        }[]
      >`
        SELECT c.id::text, c.name, c.phone, c.balance, c.credit_limit,
               (SELECT MAX(date) FROM customer_transactions t WHERE t.customer_id = c.id AND t.type = 'SALE') AS last_sale,
               (SELECT MAX(date) FROM customer_transactions t WHERE t.customer_id = c.id AND t.type = 'RECEIPT') AS last_receipt,
               (SELECT MIN(date) FROM customer_transactions t WHERE t.customer_id = c.id AND t.type IN ('SALE', 'OPENING')
                  AND t.seq > COALESCE((SELECT MAX(seq) FROM customer_transactions z WHERE z.customer_id = c.id AND z.balance_after <= 0), 0)) AS first_open
        FROM customers c
        WHERE c.tenant_id = ${auth.tenantId}::uuid AND c.balance > 0
        ORDER BY c.balance DESC`;
      const today = Date.parse(todayIn('Asia/Kolkata'));
      const bucket = (d: Date | null) => {
        if (!d) return 'current';
        const days = Math.floor((today - d.getTime()) / 86_400_000);
        return days <= 30
          ? '0-30'
          : days <= 60
            ? '31-60'
            : days <= 90
              ? '61-90'
              : '90+';
      };
      const data = rows.map((r) => ({
        customer: { id: r.id, name: r.name, phone: r.phone },
        balance: new Decimal(r.balance).toFixed(2),
        creditLimit: new Decimal(r.credit_limit).toFixed(2),
        overLimit: new Decimal(r.balance).gt(r.credit_limit),
        lastSale: r.last_sale?.toISOString().slice(0, 10) ?? null,
        lastReceipt: r.last_receipt?.toISOString().slice(0, 10) ?? null,
        /** Oldest credit not yet paid back (since the account last reached zero). */
        owingSince: r.first_open?.toISOString().slice(0, 10) ?? null,
        ageing: bucket(r.first_open),
      }));
      const totals: Record<string, Decimal> = {
        '0-30': ZERO,
        '31-60': ZERO,
        '61-90': ZERO,
        '90+': ZERO,
        current: ZERO,
      };
      for (const d of data)
        totals[d.ageing] = totals[d.ageing]!.plus(d.balance);
      return {
        total: data.reduce((s, d) => s.plus(d.balance), ZERO).toFixed(2),
        ageing: Object.fromEntries(
          Object.entries(totals).map(([k, v]) => [k, v.toFixed(2)]),
        ),
        data,
      };
    });
  }
}
