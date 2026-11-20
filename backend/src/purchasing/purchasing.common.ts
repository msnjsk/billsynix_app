import { HttpStatus } from '@nestjs/common';
import type { Tx } from '../database/prisma.service.js';
import { Decimal } from '../common/decimal.js';
import { AppException } from '../common/errors/app-exception.js';
import { can, type AuthContext } from '../auth/auth-context.js';
import type { PermissionKey } from '../access/permissions.js';
import type { SupplierTxnType } from '../generated/prisma/client.js';
import { notFound, unprocessable } from '../catalogue/catalogue.errors.js';

export { notFound, unprocessable };

export const conflict = (code: string, message: string) =>
  new AppException(code, message, HttpStatus.CONFLICT);
export const forbidden = (code: string, message: string) =>
  new AppException(code, message, HttpStatus.FORBIDDEN);

/** Needs at least one of these permissions. */
export function assertAny(auth: AuthContext, keys: PermissionKey[]) {
  if (!keys.some((k) => can(auth, k)))
    throw forbidden('FORBIDDEN', 'You do not have permission to do this.');
}

/** Who sees suppliers at all: buyers, payers and finance. */
export const SUPPLIER_READERS: PermissionKey[] = [
  'suppliers:manage',
  'purchases:write',
  'supplier-payments:write',
  'reports:finance',
];
/** Balances, statements and ageing: the people who pay suppliers, and finance. */
export const canSeePayables = (auth: AuthContext) =>
  can(auth, 'supplier-payments:write') || can(auth, 'reports:finance');

/** Today's date (YYYY-MM-DD) in a time zone — business dates are local, not UTC. */
export const todayIn = (timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

export const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const dateStr = (d: Date | null | undefined) =>
  d ? d.toISOString().slice(0, 10) : null;
export const addDays = (s: string, days: number) =>
  new Date(dateOnly(s).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** Next document number of a kind (PO-00001…), gap-free per business; locks the counter row. */
export async function nextNumber(
  tx: Tx,
  tenantId: string,
  kind: 'PO' | 'GRN' | 'DN' | 'PAY' | 'RCPT' | 'EXP' | 'ORD',
) {
  const [row] = await tx.$queryRaw<{ n: number }[]>`
    INSERT INTO document_sequences (tenant_id, kind, next) VALUES (${tenantId}::uuid, ${kind}, 2)
    ON CONFLICT (tenant_id, kind) DO UPDATE SET next = document_sequences.next + 1
    RETURNING next - 1 AS n`;
  return `${kind}-${String(row!.n).padStart(5, '0')}`;
}

/** Approval limit for purchase orders (₹, total incl. GST). Tenant setting. */
export async function purchaseOrderLimit(
  tx: Tx,
  tenantId: string,
): Promise<Decimal> {
  const t = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { settings: true },
  });
  const v = (
    t.settings as { approvalLimits?: { purchaseOrderValue?: unknown } } | null
  )?.approvalLimits?.purchaseOrderValue;
  return new Decimal(typeof v === 'number' && v >= 0 ? v : 50_000);
}

export type SupplierEntry = {
  tenantId: string;
  supplierId: string;
  type: SupplierTxnType;
  /** + we owe more, − we owe less. */
  amount: Decimal;
  date: Date;
  refType: string;
  refId: string;
  refNo: string;
  note?: string | null;
  userId?: string | null;
};

/**
 * Appends to the payables ledger and moves the supplier's balance, under a row lock on the
 * supplier — in the caller's transaction, so the balance always equals the sum of its entries.
 */
export async function postSupplierEntry(tx: Tx, e: SupplierEntry) {
  if (e.amount.isZero()) return null;
  const [row] = await tx.$queryRaw<{ balance: Decimal }[]>`
    SELECT balance FROM suppliers WHERE id = ${e.supplierId}::uuid AND tenant_id = ${e.tenantId}::uuid FOR UPDATE`;
  if (!row)
    throw unprocessable(
      'INVALID_REFERENCE',
      'Supplier not found.',
      'supplierId',
    );
  const after = new Decimal(row.balance).plus(e.amount);
  const txn = await tx.supplierTransaction.create({
    data: {
      tenantId: e.tenantId,
      supplierId: e.supplierId,
      type: e.type,
      amount: e.amount,
      balanceAfter: after,
      date: e.date,
      refType: e.refType,
      refId: e.refId,
      refNo: e.refNo,
      note: e.note ?? null,
      userId: e.userId ?? null,
    },
  });
  await tx.supplier.update({
    where: { id: e.supplierId },
    data: { balance: after },
  });
  return txn;
}

/** What is still owed on each receipt: total − payments allocated − returns against it. */
export async function receiptOutstanding(
  tx: Tx,
  tenantId: string,
  grnIds: string[],
) {
  if (!grnIds.length) return new Map<string, Decimal>();
  const [grns, allocs, returns] = [
    await tx.goodsReceipt.findMany({
      where: { tenantId, id: { in: grnIds } },
      select: { id: true, total: true },
    }),
    await tx.paymentAllocation.groupBy({
      by: ['grnId'],
      where: { tenantId, grnId: { in: grnIds } },
      _sum: { amount: true },
    }),
    await tx.purchaseReturn.groupBy({
      by: ['grnId'],
      where: { tenantId, grnId: { in: grnIds } },
      _sum: { total: true },
    }),
  ];
  const paid = new Map(
    allocs.map((a) => [a.grnId, a._sum.amount ?? new Decimal(0)]),
  );
  const returned = new Map(
    returns.map((r) => [r.grnId ?? '', r._sum.total ?? new Decimal(0)]),
  );
  return new Map(
    grns.map((g) => [
      g.id,
      Decimal.max(
        0,
        g.total.minus(paid.get(g.id) ?? 0).minus(returned.get(g.id) ?? 0),
      ),
    ]),
  );
}
