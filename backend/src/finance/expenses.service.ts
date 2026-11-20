import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppException } from '../common/errors/app-exception.js';
import { idempotent } from '../common/idempotency.js';
import { page, skipTake } from '../common/schemas.js';
import {
  assertPermission,
  canAccessStore,
  storeScope,
  type AuthContext,
} from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Prisma } from '../generated/prisma/client.js';
import { nextNumber } from '../purchasing/purchasing.common.js';
import { CashSessionsService } from '../sales/cash-sessions.service.js';
import { dateOnly, dateStr, todayIn } from '../sales/sales.common.js';
import type {
  CreateExpenseInput,
  ListExpensesQuery,
} from './finance.schemas.js';

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

/** Every business starts with these (it can add, rename and hide categories). */
export const DEFAULT_EXPENSE_CATEGORIES = [
  'Rent',
  'Electricity',
  'Salaries & wages',
  'Transport & delivery',
  'Packaging',
  'Repairs & maintenance',
  'Telephone & internet',
  'Bank & payment charges',
  'Tea & refreshments',
  'Other',
];

const include = {
  category: { select: { id: true, name: true } },
} satisfies Prisma.ExpenseInclude;
type Row = Prisma.ExpenseGetPayload<{ include: typeof include }>;

const view = (e: Row) => ({
  id: e.id,
  number: e.number,
  storeId: e.storeId,
  category: e.category,
  spentOn: dateStr(e.spentOn),
  amount: e.amount.toFixed(2),
  gstAmount: e.gstAmount.toFixed(2),
  mode: e.mode,
  payee: e.payee,
  reference: e.reference,
  note: e.note,
  cashSessionId: e.cashSessionId,
  status: e.status,
  voided: e.voidedAt
    ? { at: e.voidedAt, byUserId: e.voidedByUserId, reason: e.voidReason }
    : null,
  createdByUserId: e.createdByUserId,
  createdAt: e.createdAt,
});

/**
 * Expenses other than stock (rent, salaries, power…). Cash paid from a counter's drawer is also a
 * PAY_OUT of that drawer, refused if the drawer hasn't that much — so the drawer still adds up.
 * A mistake is voided (and its drawer pay-out reversed while the drawer is open), never deleted.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly drawers: CashSessionsService,
  ) {}

  private async ensureCategories(tx: Tx, tenantId: string) {
    if (await tx.expenseCategory.count({ where: { tenantId } })) return;
    await tx.expenseCategory.createMany({
      data: DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ tenantId, name })),
    });
  }

  categories(auth: AuthContext) {
    assertPermission(auth, 'expenses:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      await this.ensureCategories(tx, auth.tenantId);
      const rows = await tx.expenseCategory.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { name: 'asc' },
      });
      return {
        data: rows.map((c) => ({
          id: c.id,
          name: c.name,
          isActive: c.isActive,
        })),
      };
    });
  }

  private async nameFree(
    tx: Tx,
    tenantId: string,
    name: string,
    except?: string,
  ) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM expense_categories WHERE tenant_id = ${tenantId}::uuid AND lower(name) = lower(${name})`;
    if (rows.some((r) => r.id !== except))
      throw err(
        'ALREADY_EXISTS',
        `There is already a category called ${name}.`,
        HttpStatus.CONFLICT,
        'name',
      );
  }

  createCategory(auth: AuthContext, name: string, meta: RequestMeta) {
    assertPermission(auth, 'expenses:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      await this.ensureCategories(tx, auth.tenantId);
      await this.nameFree(tx, auth.tenantId, name);
      const c = await tx.expenseCategory.create({
        data: { tenantId: auth.tenantId, name },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'expense_category.created',
          entity: 'expense_category',
          entityId: c.id,
          data: { name },
          meta,
        },
        tx,
      );
      return { id: c.id, name: c.name, isActive: c.isActive };
    });
  }

  updateCategory(
    auth: AuthContext,
    id: string,
    patch: { name?: string; isActive?: boolean },
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'expenses:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await tx.expenseCategory.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!cur)
        throw err('NOT_FOUND', 'Category not found.', HttpStatus.NOT_FOUND);
      if (patch.name)
        await this.nameFree(tx, auth.tenantId, patch.name, cur.id);
      const c = await tx.expenseCategory.update({
        where: { id: cur.id },
        data: patch,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'expense_category.updated',
          entity: 'expense_category',
          entityId: c.id,
          data: patch,
          meta,
        },
        tx,
      );
      return { id: c.id, name: c.name, isActive: c.isActive };
    });
  }

  create(
    auth: AuthContext,
    input: CreateExpenseInput,
    key: string,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'expenses:write');
    return this.prisma.withTenant(auth.tenantId, (tx) =>
      idempotent(
        tx,
        auth.tenantId,
        key,
        { route: 'POST expenses', body: input },
        201,
        async () => {
          if (!canAccessStore(auth, input.storeId))
            throw err('NOT_FOUND', 'Branch not found.', HttpStatus.NOT_FOUND);
          const store = await tx.store.findFirst({
            where: { id: input.storeId, tenantId: auth.tenantId },
          });
          if (!store)
            throw err('NOT_FOUND', 'Branch not found.', HttpStatus.NOT_FOUND);
          const category = await tx.expenseCategory.findFirst({
            where: { id: input.categoryId, tenantId: auth.tenantId },
          });
          if (!category?.isActive)
            throw err(
              'INVALID_REFERENCE',
              'Expense category not found.',
              HttpStatus.UNPROCESSABLE_ENTITY,
              'categoryId',
            );
          const today = todayIn(store.timezone);
          const spentOn = input.spentOn ?? today;
          if (spentOn > today)
            throw err(
              'FUTURE_DATED',
              'An expense can’t be dated in the future.',
              HttpStatus.UNPROCESSABLE_ENTITY,
              'spentOn',
            );

          const number = await nextNumber(tx, auth.tenantId, 'EXP');
          let sessionId: string | null = null;
          let movementId: string | null = null;
          if (input.fromDrawer) {
            const s = await tx.cashSession.findFirst({
              where: {
                tenantId: auth.tenantId,
                userId: auth.userId,
                status: 'OPEN',
                storeId: store.id,
              },
            });
            if (!s)
              throw err(
                'NO_OPEN_SESSION',
                'Open your cash drawer at this branch first.',
                HttpStatus.CONFLICT,
              );
            const { expected } = await this.drawers.figures(tx, s);
            if (expected.lt(input.amount))
              throw err(
                'INSUFFICIENT_CASH',
                `Only ₹${expected.toFixed(2)} should be in the drawer.`,
                HttpStatus.CONFLICT,
                'amount',
              );
            const m = await tx.cashMovement.create({
              data: {
                tenantId: auth.tenantId,
                sessionId: s.id,
                type: 'PAY_OUT',
                amount: input.amount,
                reason: `Expense ${number} — ${category.name}${input.payee ? `, ${input.payee}` : ''}`,
                userId: auth.userId,
              },
            });
            sessionId = s.id;
            movementId = m.id;
          }
          const e = await tx.expense.create({
            data: {
              tenantId: auth.tenantId,
              number,
              storeId: store.id,
              categoryId: category.id,
              spentOn: dateOnly(spentOn),
              amount: input.amount,
              gstAmount: input.gstAmount,
              mode: input.mode,
              payee: input.payee ?? null,
              reference: input.reference ?? null,
              note: input.note ?? null,
              cashSessionId: sessionId,
              cashMovementId: movementId,
              createdByUserId: auth.userId,
            },
            include,
          });
          await this.audit.record(
            {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: 'expense.recorded',
              entity: 'expense',
              entityId: e.id,
              data: {
                number,
                amount: input.amount,
                category: category.name,
                fromDrawer: input.fromDrawer,
              },
              meta,
            },
            tx,
          );
          return view(e);
        },
      ),
    );
  }

  list(auth: AuthContext, q: ListExpensesQuery) {
    assertPermission(auth, 'expenses:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (q.storeId && !canAccessStore(auth, q.storeId))
        throw err('NOT_FOUND', 'Branch not found.', HttpStatus.NOT_FOUND);
      const where: Prisma.ExpenseWhereInput = {
        tenantId: auth.tenantId,
        ...(q.storeId ? { storeId: q.storeId } : storeScope(auth)),
        ...(q.categoryId && { categoryId: q.categoryId }),
        ...(q.status && { status: q.status }),
        ...((q.from || q.to) && {
          spentOn: {
            ...(q.from && { gte: dateOnly(q.from) }),
            ...(q.to && { lte: dateOnly(q.to) }),
          },
        }),
      };
      const rows = await tx.expense.findMany({
        where,
        include,
        orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }],
        ...skipTake(q),
      });
      return page(rows.map(view), await tx.expense.count({ where }), q);
    });
  }

  void(auth: AuthContext, id: string, reason: string, meta: RequestMeta) {
    assertPermission(auth, 'expenses:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const e = await tx.expense.findFirst({
        where: { id, tenantId: auth.tenantId },
        include,
      });
      if (!e || !canAccessStore(auth, e.storeId))
        throw err('NOT_FOUND', 'Expense not found.', HttpStatus.NOT_FOUND);
      if (e.status === 'VOIDED')
        throw err(
          'INVALID_STATE',
          'This expense is already voided.',
          HttpStatus.CONFLICT,
        );
      if (e.cashSessionId) {
        const s = await tx.cashSession.findUniqueOrThrow({
          where: { id: e.cashSessionId },
        });
        if (s.status !== 'OPEN')
          throw err(
            'SESSION_CLOSED',
            'The drawer it was paid from is closed — record the correction as a pay-in.',
            HttpStatus.CONFLICT,
          );
        await tx.cashMovement.create({
          data: {
            tenantId: auth.tenantId,
            sessionId: s.id,
            type: 'PAY_IN',
            amount: e.amount,
            reason: `Expense ${e.number} voided`,
            userId: auth.userId,
          },
        });
      }
      const done = await tx.expense.update({
        where: { id: e.id },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          voidedByUserId: auth.userId,
          voidReason: reason,
        },
        include,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'expense.voided',
          entity: 'expense',
          entityId: e.id,
          data: { number: e.number, reason },
          meta,
        },
        tx,
      );
      return view(done);
    });
  }
}
