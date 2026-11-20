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
import type { CashSession, Prisma } from '../generated/prisma/client.js';
import { isUniqueViolation } from '../catalogue/catalogue.errors.js';
import {
  conflict,
  dateOnly,
  forbidden,
  notFound,
  resolveCounter,
  salesLimits,
  todayIn,
} from './sales.common.js';
import type {
  CashierReportQuery,
  CashMovementInput,
  CloseSessionInput,
  ListSessionsQuery,
  OpenSessionInput,
} from './sales.schemas.js';

const ZERO = new Decimal(0);
const sum = (xs: { amount: Decimal }[]) =>
  xs.reduce((s, x) => s.plus(x.amount), ZERO);

/**
 * Cash drawers. A cashier opens one on a counter with a float; cash sales (net of change), cash
 * refunds and pay-ins/outs move the expected cash; closing records the counted cash and the
 * variance. A variance above the business's limit (settings.approvalLimits.cashVariance, ₹200 by
 * default) leaves the session PENDING_REVIEW until someone with `cash:reconcile` signs it off.
 */
@Injectable()
export class CashSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Live figures for a session (also used at close). */
  async figures(tx: Tx, s: CashSession) {
    const [payments, refunds, movements, sales] = [
      await tx.salePayment.findMany({
        where: { tenantId: s.tenantId, sale: { cashSessionId: s.id } },
        include: { sale: { select: { status: true } } },
      }),
      await tx.saleReturn.findMany({
        where: { tenantId: s.tenantId, cashSessionId: s.id },
      }),
      await tx.cashMovement.findMany({
        where: { tenantId: s.tenantId, sessionId: s.id },
      }),
      await tx.sale.findMany({
        where: { tenantId: s.tenantId, cashSessionId: s.id },
        select: { status: true, payable: true },
      }),
    ];
    const live = payments.filter((p) => p.sale.status === 'COMPLETED');
    const byMethod = (m: string, statuses: string[]) =>
      sum(live.filter((p) => p.method === m && statuses.includes(p.status)));
    const cashSales = byMethod('CASH', ['SUCCEEDED']);
    const cashRefunds = sum(
      refunds
        .filter((r) => r.refundMethod === 'CASH')
        .map((r) => ({ amount: r.refundAmount })),
    );
    const payIn = sum(movements.filter((m) => m.type === 'PAY_IN'));
    const payOut = sum(movements.filter((m) => m.type === 'PAY_OUT'));
    const expected = s.openingFloat
      .plus(cashSales)
      .minus(cashRefunds)
      .plus(payIn)
      .minus(payOut);
    const completed = sales.filter((x) => x.status === 'COMPLETED');
    return {
      openingFloat: s.openingFloat.toFixed(2),
      cashSales: cashSales.toFixed(2),
      cashRefunds: cashRefunds.toFixed(2),
      payIn: payIn.toFixed(2),
      payOut: payOut.toFixed(2),
      expectedCash: expected.toFixed(2),
      upi: {
        settled: byMethod('UPI', ['SUCCEEDED']).toFixed(2),
        pending: byMethod('UPI', ['PENDING_VERIFICATION']).toFixed(2),
      },
      card: {
        settled: byMethod('CARD', ['SUCCEEDED']).toFixed(2),
        pending: byMethod('CARD', ['PENDING_VERIFICATION']).toFixed(2),
      },
      failed: sum(live.filter((p) => p.status === 'FAILED')).toFixed(2),
      sales: {
        count: completed.length,
        total: sum(completed.map((x) => ({ amount: x.payable }))).toFixed(2),
        voided: sales.length - completed.length,
      },
      refunds: {
        count: refunds.length,
        total: sum(refunds.map((r) => ({ amount: r.refundAmount }))).toFixed(2),
      },
      expected,
    };
  }

  private async view(tx: Tx, s: CashSession) {
    const { expected: _e, ...f } = await this.figures(tx, s);
    const movements = await tx.cashMovement.findMany({
      where: { tenantId: s.tenantId, sessionId: s.id },
      orderBy: { createdAt: 'asc' },
    });
    const [counter, people] = await Promise.all([
      tx.counter.findUnique({
        where: { id: s.counterId },
        select: { name: true, number: true },
      }),
      tx.user.findMany({
        where: { id: { in: [s.userId, s.reviewedByUserId ?? s.userId] } },
        select: { id: true, name: true },
      }),
    ]);
    const nameOf = (id: string | null) =>
      people.find((p) => p.id === id)?.name ?? null;
    return {
      id: s.id,
      storeId: s.storeId,
      counterId: s.counterId,
      counter: counter ? { name: counter.name, number: counter.number } : null,
      userId: s.userId,
      cashier: nameOf(s.userId),
      status: s.status,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      ...f,
      ...(s.status !== 'OPEN' && {
        expectedCash: s.expectedCash?.toFixed(2) ?? null,
      }),
      countedCash: s.countedCash?.toFixed(2) ?? null,
      variance: s.variance?.toFixed(2) ?? null,
      denominations: s.denominations,
      closingNote: s.closingNote,
      review: s.reviewedAt
        ? {
            byUserId: s.reviewedByUserId,
            by: nameOf(s.reviewedByUserId),
            at: s.reviewedAt,
            note: s.reviewNote,
          }
        : null,
      movements: movements.map((m) => ({
        id: m.id,
        type: m.type,
        amount: m.amount.toFixed(2),
        reason: m.reason,
        userId: m.userId,
        createdAt: m.createdAt,
      })),
    };
  }

  private async load(tx: Tx, auth: AuthContext, id: string) {
    const s = await tx.cashSession.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!s || !canAccessStore(auth, s.storeId)) throw notFound('Cash session');
    if (s.userId !== auth.userId && !can(auth, 'cash:reconcile'))
      throw notFound('Cash session');
    return s;
  }

  open(auth: AuthContext, input: OpenSessionInput, meta: RequestMeta) {
    assertPermission(auth, 'cash:session');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const counter = await resolveCounter(tx, auth, input.counterId);
      const busy = await tx.cashSession.findFirst({
        where: {
          tenantId: auth.tenantId,
          status: 'OPEN',
          OR: [{ counterId: counter.id }, { userId: auth.userId }],
        },
      });
      if (busy)
        throw conflict(
          'SESSION_ALREADY_OPEN',
          busy.userId === auth.userId
            ? 'You already have a drawer open — close it first.'
            : 'A drawer is already open on this counter.',
        );
      try {
        const s = await tx.cashSession.create({
          data: {
            tenantId: auth.tenantId,
            storeId: counter.storeId,
            counterId: counter.id,
            userId: auth.userId,
            openingFloat: input.openingFloat,
          },
        });
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'cash_session.opened',
            entity: 'cash_session',
            entityId: s.id,
            data: { counterId: counter.id, float: input.openingFloat },
            meta,
          },
          tx,
        );
        return this.view(tx, s);
      } catch (e) {
        if (isUniqueViolation(e))
          throw conflict(
            'SESSION_ALREADY_OPEN',
            'A drawer was just opened on this counter.',
          );
        throw e;
      }
    });
  }

  current(auth: AuthContext) {
    assertPermission(auth, 'cash:session');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const s = await tx.cashSession.findFirst({
        where: { tenantId: auth.tenantId, userId: auth.userId, status: 'OPEN' },
      });
      if (!s) throw notFound('Open cash session');
      return this.view(tx, s);
    });
  }

  get(auth: AuthContext, id: string) {
    return this.prisma.withTenant(auth.tenantId, async (tx) =>
      this.view(tx, await this.load(tx, auth, id)),
    );
  }

  list(auth: AuthContext, q: ListSessionsQuery) {
    assertPermission(auth, 'cash:session');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (q.storeId && !canAccessStore(auth, q.storeId))
        throw notFound('Branch');
      const all = can(auth, 'cash:reconcile');
      const where: Prisma.CashSessionWhereInput = {
        tenantId: auth.tenantId,
        ...(q.storeId
          ? { storeId: q.storeId }
          : auth.storeIds === 'ALL'
            ? {}
            : { storeId: { in: [...auth.storeIds] } }),
        ...(all
          ? q.userId
            ? { userId: q.userId }
            : {}
          : { userId: auth.userId }),
        ...(q.status && { status: q.status }),
        ...(q.date && {
          openedAt: {
            gte: new Date(`${q.date}T00:00:00+05:30`),
            lt: new Date(
              new Date(`${q.date}T00:00:00+05:30`).getTime() + 86_400_000,
            ),
          },
        }),
      };
      const rows = await tx.cashSession.findMany({
        where,
        orderBy: { openedAt: 'desc' },
        ...skipTake(q),
      });
      const total = await tx.cashSession.count({ where });
      const data = [];
      for (const s of rows) data.push(await this.view(tx, s));
      return page(data, total, q);
    });
  }

  movement(
    auth: AuthContext,
    id: string,
    input: CashMovementInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'cash:session');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const s = await this.load(tx, auth, id);
      if (s.userId !== auth.userId)
        throw forbidden(
          'SESSION_NOT_YOURS',
          'Only the cashier of this drawer records cash in or out.',
        );
      if (s.status !== 'OPEN')
        throw conflict('SESSION_CLOSED', 'This drawer is closed.');
      if (input.type === 'PAY_OUT') {
        const { expected } = await this.figures(tx, s);
        if (expected.lt(input.amount))
          throw conflict(
            'NOT_ENOUGH_CASH',
            `Only ₹${expected.toFixed(2)} should be in the drawer.`,
          );
      }
      await tx.cashMovement.create({
        data: {
          tenantId: auth.tenantId,
          sessionId: s.id,
          type: input.type,
          amount: input.amount,
          reason: input.reason,
          userId: auth.userId,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: `cash_session.${input.type.toLowerCase()}`,
          entity: 'cash_session',
          entityId: s.id,
          data: { amount: input.amount, reason: input.reason },
          meta,
        },
        tx,
      );
      return this.view(tx, s);
    });
  }

  close(
    auth: AuthContext,
    id: string,
    input: CloseSessionInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'cash:session');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const s = await this.load(tx, auth, id);
      if (s.userId !== auth.userId && !can(auth, 'cash:reconcile'))
        throw forbidden(
          'SESSION_NOT_YOURS',
          'Only the cashier of this drawer (or a manager) can close it.',
        );
      if (s.status !== 'OPEN')
        throw conflict('SESSION_CLOSED', 'This drawer is already closed.');
      if (input.denominations) {
        const counted = Object.entries(input.denominations).reduce(
          (t, [note, n]) => t.plus(new Decimal(note).times(n)),
          ZERO,
        );
        if (!counted.eq(input.countedCash))
          throw conflict(
            'COUNT_MISMATCH',
            `The notes and coins add up to ₹${counted.toFixed(2)}, not ₹${new Decimal(input.countedCash).toFixed(2)}.`,
          );
      }
      const { expected } = await this.figures(tx, s);
      const variance = new Decimal(input.countedCash).minus(expected);
      const limit = (await salesLimits(tx, auth.tenantId)).cashVariance;
      const review = variance.abs().gt(limit) && !can(auth, 'cash:reconcile');
      const done = await tx.cashSession.updateMany({
        where: { id: s.id, tenantId: auth.tenantId, status: 'OPEN' },
        data: {
          status: review ? 'PENDING_REVIEW' : 'CLOSED',
          closedAt: new Date(),
          expectedCash: expected,
          countedCash: input.countedCash,
          variance,
          denominations: input.denominations ?? undefined,
          closingNote: input.note ?? null,
          ...(!review &&
            variance.abs().gt(limit) && {
              reviewedByUserId: auth.userId,
              reviewedAt: new Date(),
              reviewNote: 'Closed by a manager',
            }),
        },
      });
      if (!done.count)
        throw conflict('SESSION_CLOSED', 'This drawer was just closed.');
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'cash_session.closed',
          entity: 'cash_session',
          entityId: s.id,
          data: {
            expected: expected.toFixed(2),
            counted: input.countedCash,
            variance: variance.toFixed(2),
            review,
          },
          meta,
        },
        tx,
      );
      return this.view(
        tx,
        await tx.cashSession.findUniqueOrThrow({ where: { id: s.id } }),
      );
    });
  }

  review(auth: AuthContext, id: string, note: string, meta: RequestMeta) {
    assertPermission(auth, 'cash:reconcile');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const s = await this.load(tx, auth, id);
      const done = await tx.cashSession.updateMany({
        where: { id: s.id, tenantId: auth.tenantId, status: 'PENDING_REVIEW' },
        data: {
          status: 'CLOSED',
          reviewedByUserId: auth.userId,
          reviewedAt: new Date(),
          reviewNote: note,
        },
      });
      if (!done.count)
        throw conflict(
          'INVALID_STATE',
          'This drawer is not waiting for review.',
        );
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'cash_session.reviewed',
          entity: 'cash_session',
          entityId: s.id,
          data: { variance: s.variance?.toFixed(2), note },
          meta,
        },
        tx,
      );
      return this.view(
        tx,
        await tx.cashSession.findUniqueOrThrow({ where: { id: s.id } }),
      );
    });
  }

  /** Cashier-wise totals for a business day: sales, tenders, refunds, drawer variance. */
  cashierReport(auth: AuthContext, q: CashierReportQuery) {
    assertPermission(auth, 'cash:reconcile');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (q.storeId && !canAccessStore(auth, q.storeId))
        throw notFound('Branch');
      const date = q.date ?? todayIn('Asia/Kolkata');
      const storeWhere = q.storeId
        ? { storeId: q.storeId }
        : auth.storeIds === 'ALL'
          ? {}
          : { storeId: { in: [...auth.storeIds] } };
      const sales = await tx.sale.findMany({
        where: {
          tenantId: auth.tenantId,
          businessDate: dateOnly(date),
          ...storeWhere,
        },
        include: { payments: true },
      });
      const returns = await tx.saleReturn.findMany({
        where: {
          tenantId: auth.tenantId,
          businessDate: dateOnly(date),
          ...storeWhere,
        },
      });
      const sessions = await tx.cashSession.findMany({
        where: {
          tenantId: auth.tenantId,
          id: { in: [...new Set(sales.map((s) => s.cashSessionId))] },
        },
      });
      const users = await tx.user.findMany({
        where: {
          id: {
            in: [
              ...new Set([
                ...sales.map((s) => s.cashierUserId),
                ...returns.map((r) => r.createdByUserId),
              ]),
            ],
          },
        },
        select: { id: true, name: true },
      });
      const rows = users.map((u) => {
        const mine = sales.filter((s) => s.cashierUserId === u.id);
        const done = mine.filter((s) => s.status === 'COMPLETED');
        const pays = done.flatMap((s) => s.payments);
        const tender = (m: string) =>
          sum(
            pays.filter((p) => p.method === m && p.status !== 'FAILED'),
          ).toFixed(2);
        const variance = sessions
          .filter((x) => x.userId === u.id && x.variance)
          .reduce((t, x) => t.plus(x.variance!), ZERO);
        const myReturns = returns.filter((r) => r.createdByUserId === u.id);
        return {
          cashier: { id: u.id, name: u.name },
          bills: done.length,
          voided: mine.length - done.length,
          sales: sum(done.map((s) => ({ amount: s.payable }))).toFixed(2),
          discounts: done
            .reduce(
              (t, s) => t.plus(s.lineDiscounts).plus(s.billDiscount),
              ZERO,
            )
            .toFixed(2),
          tenders: {
            cash: tender('CASH'),
            upi: tender('UPI'),
            card: tender('CARD'),
          },
          pendingVerification: sum(
            pays.filter((p) => p.status === 'PENDING_VERIFICATION'),
          ).toFixed(2),
          refunds: sum(
            myReturns.map((r) => ({ amount: r.refundAmount })),
          ).toFixed(2),
          drawerVariance: variance.toFixed(2),
        };
      });
      return {
        date,
        data: rows.sort((a, b) => a.cashier.name.localeCompare(b.cashier.name)),
      };
    });
  }
}
