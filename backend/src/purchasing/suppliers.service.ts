import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Decimal } from '../common/decimal.js';
import { gstinProblem } from '../common/gst.js';
import { page, skipTake } from '../common/schemas.js';
import { assertPermission, type AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Prisma, Supplier } from '../generated/prisma/client.js';
import {
  alreadyExists,
  isUniqueViolation,
} from '../catalogue/catalogue.errors.js';
import {
  SUPPLIER_READERS,
  assertAny,
  canSeePayables,
  dateOnly,
  dateStr,
  forbidden,
  notFound,
  postSupplierEntry,
  receiptOutstanding,
  todayIn,
  unprocessable,
} from './purchasing.common.js';
import type {
  CreateSupplierInput,
  ListSuppliersQuery,
  StatementQuery,
  SupplierPricesInput,
  UpdateSupplierInput,
} from './purchasing.schemas.js';

const AGE_BUCKETS = ['current', 'd1_30', 'd31_60', 'd60'] as const;
const bucketOf = (daysLate: number): (typeof AGE_BUCKETS)[number] =>
  daysLate <= 0
    ? 'current'
    : daysLate <= 30
      ? 'd1_30'
      : daysLate <= 60
        ? 'd31_60'
        : 'd60';

/** Suppliers, their prices, statements and what we owe them. */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  view(auth: AuthContext, s: Supplier) {
    return {
      id: s.id,
      name: s.name,
      contactName: s.contactName,
      phone: s.phone,
      email: s.email,
      gstin: s.gstin,
      registered: !!s.gstin,
      stateCode: s.stateCode,
      addressLine1: s.addressLine1,
      city: s.city,
      pincode: s.pincode,
      supplies: s.supplies,
      creditDays: s.creditDays,
      ...(canSeePayables(auth) ? { balance: s.balance.toFixed(2) } : {}),
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  async load(tx: Tx, auth: AuthContext, id: string) {
    const s = await tx.supplier.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!s) throw notFound('Supplier');
    return s;
  }

  /** GSTIN format and check digit; the state follows it. Unregistered suppliers name their state. */
  private gst(gstin: string | null | undefined, stateCode: string | undefined) {
    if (gstin) {
      const problem = gstinProblem(gstin);
      if (problem) throw unprocessable('INVALID_GSTIN', problem, 'gstin');
      if (stateCode && stateCode !== gstin.slice(0, 2))
        throw unprocessable(
          'INVALID_GSTIN',
          'GSTIN state code does not match the state.',
          'gstin',
        );
      return { gstin, stateCode: gstin.slice(0, 2) };
    }
    if (!stateCode)
      throw unprocessable(
        'STATE_REQUIRED',
        'Give the state of an unregistered supplier.',
        'stateCode',
      );
    return { gstin: null, stateCode };
  }

  private async assertUnique(
    tx: Tx,
    tenantId: string,
    name: string,
    gstin: string | null,
    exceptId?: string,
  ) {
    const clash = await tx.supplier.findFirst({
      where: {
        tenantId,
        ...(exceptId && { NOT: { id: exceptId } }),
        OR: [
          { name: { equals: name, mode: 'insensitive' } },
          ...(gstin ? [{ gstin }] : []),
        ],
      },
      select: { name: true, gstin: true },
    });
    if (clash)
      throw clash.gstin && clash.gstin === gstin
        ? alreadyExists(`${clash.name} already has GSTIN ${gstin}.`, 'gstin')
        : alreadyExists(`A supplier named "${name}" exists.`, 'name');
  }

  list(auth: AuthContext, q: ListSuppliersQuery) {
    assertAny(auth, SUPPLIER_READERS);
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const words = (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 6);
      const where: Prisma.SupplierWhereInput = {
        tenantId: auth.tenantId,
        ...(q.status !== 'ALL' && { status: q.status }),
        ...(words.length && {
          AND: words.map((w) => ({
            OR: [
              { name: { contains: w, mode: 'insensitive' as const } },
              { supplies: { contains: w, mode: 'insensitive' as const } },
              { gstin: { startsWith: w.toUpperCase() } },
              { phone: { contains: w } },
            ],
          })),
        }),
      };
      const rows = await tx.supplier.findMany({
        where,
        orderBy: { name: 'asc' },
        ...skipTake(q),
      });
      const total = await tx.supplier.count({ where });
      return page(
        rows.map((s) => this.view(auth, s)),
        total,
        q,
      );
    });
  }

  get(auth: AuthContext, id: string) {
    assertAny(auth, SUPPLIER_READERS);
    return this.prisma.withTenant(auth.tenantId, async (tx) =>
      this.view(auth, await this.load(tx, auth, id)),
    );
  }

  create(auth: AuthContext, input: CreateSupplierInput, meta: RequestMeta) {
    assertPermission(auth, 'suppliers:manage');
    if (
      input.openingBalance &&
      Number(input.openingBalance) > 0 &&
      !canSeePayables(auth)
    )
      throw forbidden(
        'FORBIDDEN',
        'Only people who pay suppliers can set an opening balance.',
      );
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const { gstin, stateCode } = this.gst(input.gstin, input.stateCode);
      await this.assertUnique(tx, auth.tenantId, input.name, gstin);
      const { openingBalance, openingDate, ...fields } = input;
      try {
        const s = await tx.supplier.create({
          data: { tenantId: auth.tenantId, ...fields, gstin, stateCode },
        });
        if (openingBalance && Number(openingBalance) > 0)
          await postSupplierEntry(tx, {
            tenantId: auth.tenantId,
            supplierId: s.id,
            type: 'OPENING',
            amount: new Decimal(openingBalance),
            date: dateOnly(openingDate ?? todayIn('Asia/Kolkata')),
            refType: 'SUPPLIER',
            refId: s.id,
            refNo: 'Opening balance',
            userId: auth.userId,
          });
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'supplier.created',
            entity: 'supplier',
            entityId: s.id,
            data: { name: s.name, openingBalance: openingBalance ?? null },
            meta,
          },
          tx,
        );
        return this.view(auth, await this.load(tx, auth, s.id));
      } catch (e) {
        if (isUniqueViolation(e))
          throw alreadyExists(
            `A supplier named "${input.name}" exists.`,
            'name',
          );
        throw e;
      }
    });
  }

  update(
    auth: AuthContext,
    id: string,
    patch: UpdateSupplierInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'suppliers:manage');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.load(tx, auth, id);
      const gstinIn =
        patch.gstin !== undefined ? patch.gstin || null : cur.gstin;
      const { gstin, stateCode } = this.gst(
        gstinIn,
        patch.stateCode ?? (gstinIn ? undefined : cur.stateCode),
      );
      await this.assertUnique(
        tx,
        auth.tenantId,
        patch.name ?? cur.name,
        gstin,
        cur.id,
      );
      const s = await tx.supplier.update({
        where: { id: cur.id },
        data: { ...patch, gstin, stateCode },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'supplier.updated',
          entity: 'supplier',
          entityId: s.id,
          data: { fields: Object.keys(patch) },
          meta,
        },
        tx,
      );
      return this.view(auth, s);
    });
  }

  /* ---------- supplier prices ---------- */

  prices(auth: AuthContext, id: string) {
    assertAny(auth, SUPPLIER_READERS);
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const s = await this.load(tx, auth, id);
      const rows = await tx.supplierProduct.findMany({
        where: { tenantId: auth.tenantId, supplierId: s.id },
        include: { product: { select: { sku: true, name: true } } },
        orderBy: { product: { name: 'asc' } },
      });
      return {
        data: rows.map((r) => ({
          product: {
            id: r.productId,
            sku: r.product.sku,
            name: r.product.name,
          },
          supplierSku: r.supplierSku,
          cost: r.cost.toFixed(2),
          lastPurchasedAt: r.lastPurchasedAt,
        })),
      };
    });
  }

  setPrices(
    auth: AuthContext,
    id: string,
    input: SupplierPricesInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'suppliers:manage');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const s = await this.load(tx, auth, id);
      const found = await tx.product.count({
        where: {
          tenantId: auth.tenantId,
          id: { in: input.items.map((i) => i.productId) },
        },
      });
      if (found !== input.items.length)
        throw unprocessable(
          'INVALID_REFERENCE',
          'Some products were not found.',
          'items',
        );
      for (const i of input.items)
        await tx.supplierProduct.upsert({
          where: {
            supplierId_productId: { supplierId: s.id, productId: i.productId },
          },
          create: {
            tenantId: auth.tenantId,
            supplierId: s.id,
            productId: i.productId,
            cost: i.cost,
            supplierSku: i.supplierSku ?? null,
          },
          update: {
            cost: i.cost,
            ...(i.supplierSku !== undefined && { supplierSku: i.supplierSku }),
          },
        });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'supplier.prices_set',
          entity: 'supplier',
          entityId: s.id,
          data: { count: input.items.length },
          meta,
        },
        tx,
      );
      return { updated: input.items.length };
    });
  }

  /* ---------- payables ---------- */

  private assertPayables(auth: AuthContext) {
    if (!canSeePayables(auth))
      throw forbidden(
        'FORBIDDEN',
        'Supplier balances are for people who pay suppliers and finance.',
      );
  }

  /** Ledger with running balance; opening = balance before `from`. */
  statement(auth: AuthContext, id: string, q: StatementQuery) {
    this.assertPayables(auth);
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const s = await this.load(tx, auth, id);
      const before = q.from
        ? await tx.supplierTransaction.aggregate({
            where: {
              tenantId: auth.tenantId,
              supplierId: s.id,
              date: { lt: dateOnly(q.from) },
            },
            _sum: { amount: true },
          })
        : null;
      const rows = await tx.supplierTransaction.findMany({
        where: {
          tenantId: auth.tenantId,
          supplierId: s.id,
          ...((q.from || q.to) && {
            date: {
              ...(q.from && { gte: dateOnly(q.from) }),
              ...(q.to && { lte: dateOnly(q.to) }),
            },
          }),
        },
        orderBy: [{ date: 'asc' }, { seq: 'asc' }],
        take: 5000,
      });
      let running = before?._sum.amount ?? new Decimal(0);
      const opening = running;
      return {
        supplier: { id: s.id, name: s.name, gstin: s.gstin },
        from: q.from ?? null,
        to: q.to ?? null,
        openingBalance: opening.toFixed(2),
        entries: rows.map((t) => {
          running = running.plus(t.amount);
          return {
            date: dateStr(t.date),
            type: t.type,
            refType: t.refType,
            refId: t.refId,
            refNo: t.refNo,
            debit: t.amount.lt(0) ? t.amount.negated().toFixed(2) : null,
            credit: t.amount.gt(0) ? t.amount.toFixed(2) : null,
            balance: running.toFixed(2),
            note: t.note,
          };
        }),
        closingBalance: running.toFixed(2),
        currentBalance: s.balance.toFixed(2),
      };
    });
  }

  /** Receipts with money still owed, oldest due first, with days overdue. */
  openBills(auth: AuthContext, id: string) {
    this.assertPayables(auth);
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const s = await this.load(tx, auth, id);
      return {
        supplierId: s.id,
        data: await this.openReceipts(tx, auth.tenantId, [s.id]),
      };
    });
  }

  async openReceipts(tx: Tx, tenantId: string, supplierIds: string[]) {
    const grns = await tx.goodsReceipt.findMany({
      where: { tenantId, supplierId: { in: supplierIds } },
      select: {
        id: true,
        number: true,
        supplierId: true,
        supplierInvoiceNo: true,
        receivedDate: true,
        dueDate: true,
        total: true,
      },
      orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
    });
    const outstanding = await receiptOutstanding(
      tx,
      tenantId,
      grns.map((g) => g.id),
    );
    const today = dateOnly(todayIn('Asia/Kolkata')).getTime();
    return grns
      .filter((g) => outstanding.get(g.id)?.gt(0))
      .map((g) => {
        const daysLate = Math.round((today - g.dueDate.getTime()) / 86_400_000);
        return {
          grnId: g.id,
          number: g.number,
          supplierId: g.supplierId,
          supplierInvoiceNo: g.supplierInvoiceNo,
          receivedDate: dateStr(g.receivedDate),
          dueDate: dateStr(g.dueDate),
          total: g.total.toFixed(2),
          outstanding: outstanding.get(g.id)!.toFixed(2),
          daysOverdue: Math.max(0, daysLate),
          bucket: bucketOf(daysLate),
        };
      });
  }

  /**
   * Outstanding per supplier with ageing of unpaid receipts. `other` is the part of the balance
   * not tied to a receipt: opening balances, advances (negative) and unallocated credit.
   */
  payables(auth: AuthContext, all: boolean) {
    this.assertPayables(auth);
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const suppliers = await tx.supplier.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(all ? {} : { balance: { not: 0 } }),
        },
        orderBy: { name: 'asc' },
      });
      const open = await this.openReceipts(
        tx,
        auth.tenantId,
        suppliers.map((s) => s.id),
      );
      const zero = () =>
        Object.fromEntries(
          AGE_BUCKETS.map((b) => [b, new Decimal(0)]),
        ) as Record<(typeof AGE_BUCKETS)[number], Decimal>;
      const totals = zero();
      const rows = suppliers.map((s) => {
        const b = zero();
        for (const r of open.filter((o) => o.supplierId === s.id))
          b[r.bucket] = b[r.bucket].plus(r.outstanding);
        const tied = AGE_BUCKETS.reduce(
          (sum, k) => sum.plus(b[k]),
          new Decimal(0),
        );
        for (const k of AGE_BUCKETS) totals[k] = totals[k].plus(b[k]);
        return {
          supplier: { id: s.id, name: s.name, creditDays: s.creditDays },
          balance: s.balance.toFixed(2),
          ageing: Object.fromEntries(
            AGE_BUCKETS.map((k) => [k, b[k].toFixed(2)]),
          ),
          other: s.balance.minus(tied).toFixed(2),
          overdue: b.d1_30.plus(b.d31_60).plus(b.d60).toFixed(2),
        };
      });
      return {
        asOf: todayIn('Asia/Kolkata'),
        data: rows,
        totals: {
          balance: suppliers
            .reduce((sum, s) => sum.plus(s.balance), new Decimal(0))
            .toFixed(2),
          ...Object.fromEntries(
            AGE_BUCKETS.map((k) => [k, totals[k].toFixed(2)]),
          ),
        },
      };
    });
  }

  /** Every receipt of a product: when, from whom, at what price. */
  purchaseHistory(auth: AuthContext, productId: string) {
    assertAny(auth, ['purchases:write', 'reports:finance', 'suppliers:manage']);
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const p = await tx.product.findFirst({
        where: { id: productId, tenantId: auth.tenantId },
      });
      if (!p) throw notFound('Product');
      const rows = await tx.goodsReceiptItem.findMany({
        where: { tenantId: auth.tenantId, productId },
        include: {
          grn: {
            include: {
              supplier: { select: { name: true } },
              store: { select: { code: true } },
            },
          },
        },
        orderBy: { grn: { receivedDate: 'desc' } },
        take: 200,
      });
      return {
        product: { id: p.id, sku: p.sku, name: p.name },
        data: rows.map((r) => ({
          grnId: r.grnId,
          number: r.grn.number,
          date: dateStr(r.grn.receivedDate),
          supplier: { id: r.grn.supplierId, name: r.grn.supplier.name },
          store: r.grn.store.code,
          receivedQty: r.receivedQty.toFixed(3),
          acceptedQty: r.acceptedQty.toFixed(3),
          rate: r.rate.toFixed(2),
          discountPct: Number(r.discountPct),
          netRate: r.rate
            .times(new Decimal(100).minus(r.discountPct))
            .dividedBy(100)
            .toFixed(2),
          unitCost: r.unitCost.toFixed(4),
        })),
      };
    });
  }
}
