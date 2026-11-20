import { HttpStatus } from '@nestjs/common';
import type { Tx } from '../database/prisma.service.js';
import { AppException } from '../common/errors/app-exception.js';
import { Decimal } from '../common/decimal.js';
import { can, canAccessStore, type AuthContext } from '../auth/auth-context.js';
import type { PermissionKey } from '../access/permissions.js';
import type { StockMovement } from '../generated/prisma/client.js';
import { notFound, unprocessable } from '../catalogue/catalogue.errors.js';

export { notFound, unprocessable };

export const forbidden = (code: string, message: string) =>
  new AppException(code, message, HttpStatus.FORBIDDEN);

export const conflict = (code: string, message: string) =>
  new AppException(code, message, HttpStatus.CONFLICT);

/** Costs and stock values are for people who buy, price or adjust stock — not cashiers. */
const COST_VIEWERS: PermissionKey[] = [
  'inventory:adjust',
  'products:write',
  'prices:write',
  'purchases:write',
  'reports:finance',
];
export const showCost = (auth: AuthContext) =>
  COST_VIEWERS.some((k) => can(auth, k));

/** Owners and admins (tenant-wide approvers) may approve their own requests; branch staff may not. */
export const canSelfApprove = (auth: AuthContext) =>
  auth.storeIds === 'ALL' && can(auth, 'inventory:approve');

/** A branch of this business the caller may use, or 404. */
export async function visibleStore(tx: Tx, auth: AuthContext, storeId: string) {
  const store = await tx.store.findFirst({
    where: { id: storeId, tenantId: auth.tenantId },
  });
  if (!store || !canAccessStore(auth, store.id)) throw notFound('Branch');
  return store;
}

export const assertActive = (store: { status: string; name: string }) => {
  if (store.status !== 'ACTIVE')
    throw unprocessable('STORE_CLOSED', `${store.name} is closed.`);
};

/** Stock changes above this value (₹, Σ |qty| × cost) need approval. Tenant setting. */
export async function adjustmentLimit(
  tx: Tx,
  tenantId: string,
): Promise<Decimal> {
  const t = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { settings: true },
  });
  const v = (
    t.settings as { approvalLimits?: { adjustmentValue?: unknown } } | null
  )?.approvalLimits?.adjustmentValue;
  return new Decimal(typeof v === 'number' && v >= 0 ? v : 5000);
}

/** Finds the batch by id or number, creating a new batch number when stock comes in. */
export async function resolveBatch(
  tx: Tx,
  tenantId: string,
  productId: string,
  ref: {
    batchId?: string | undefined;
    batchNo?: string | undefined;
    expiryDate?: string | undefined;
  },
  field: string,
  allowCreate: boolean,
): Promise<string | undefined> {
  if (ref.batchId) {
    const b = await tx.productBatch.findFirst({
      where: { id: ref.batchId, tenantId, productId },
    });
    if (!b)
      throw unprocessable(
        'INVALID_REFERENCE',
        'Batch not found for this product.',
        field,
      );
    return b.id;
  }
  if (!ref.batchNo) return undefined;
  const found = await tx.productBatch.findFirst({
    where: { tenantId, productId, batchNo: ref.batchNo },
  });
  if (found) {
    if (
      ref.expiryDate &&
      found.expiryDate?.toISOString().slice(0, 10) !== ref.expiryDate
    )
      throw unprocessable(
        'BATCH_EXPIRY_MISMATCH',
        `Batch ${ref.batchNo} is recorded with a different expiry date.`,
        field,
      );
    return found.id;
  }
  if (!allowCreate)
    throw unprocessable(
      'INVALID_REFERENCE',
      `No batch ${ref.batchNo} of this product.`,
      field,
    );
  const created = await tx.productBatch.create({
    data: {
      tenantId,
      productId,
      batchNo: ref.batchNo,
      expiryDate: ref.expiryDate ? new Date(ref.expiryDate) : null,
    },
  });
  return created.id;
}

export const qtyStr = (d: Decimal | null | undefined) =>
  d == null ? null : d.toFixed(3);
export const costStr = (d: Decimal | null | undefined) =>
  d == null ? null : d.toFixed(4);
export const valueStr = (d: Decimal) =>
  d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
export const dateStr = (d: Date | null | undefined) =>
  d ? d.toISOString().slice(0, 10) : null;

export const movementView = (m: StockMovement, withCost: boolean) => ({
  id: m.id,
  seq: m.seq.toString(),
  storeId: m.storeId,
  productId: m.productId,
  batchId: m.batchId,
  type: m.type,
  qty: m.qty.toFixed(3),
  balanceAfter: m.balanceAfter.toFixed(3),
  ...(withCost
    ? {
        unitCost: m.unitCost.toFixed(4),
        value: valueStr(m.qty.times(m.unitCost)),
      }
    : {}),
  refType: m.refType,
  refId: m.refId,
  reason: m.reason,
  note: m.note,
  negative: m.negative,
  userId: m.userId,
  createdAt: m.createdAt,
});

/** Which stores a caller sees in cross-branch lists. */
export const storeFilter = (auth: AuthContext, storeId?: string) => {
  if (storeId) {
    if (!canAccessStore(auth, storeId)) return { in: [] as string[] };
    return { in: [storeId] };
  }
  return auth.storeIds === 'ALL' ? undefined : { in: [...auth.storeIds] };
};
