import { HttpStatus } from '@nestjs/common';
import type { PrismaService, Tx } from '../database/prisma.service.js';
import { Decimal } from '../common/decimal.js';
import { AppException } from '../common/errors/app-exception.js';
import { canAccessStore, type AuthContext } from '../auth/auth-context.js';
import { verifySecret } from '../auth/secrets.js';
import type { PermissionKey } from '../access/permissions.js';
import { notFound, unprocessable } from '../catalogue/catalogue.errors.js';
import {
  creditNoteNumber,
  fyOf,
  invoiceNumber,
  seriesOf,
} from './bill-math.js';

export { notFound, unprocessable };

export const conflict = (code: string, message: string) =>
  new AppException(code, message, HttpStatus.CONFLICT);
export const forbidden = (code: string, message: string) =>
  new AppException(code, message, HttpStatus.FORBIDDEN);

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

/**
 * The counter a request bills on: a PIN session is bound to its device's counter; a password
 * session (a manager at the back office) names one. The counter and branch must be active and
 * the caller must work at that branch.
 */
export async function resolveCounter(
  tx: Tx,
  auth: AuthContext,
  counterId: string | undefined,
) {
  const id = auth.device?.counterId ?? counterId;
  if (!id)
    throw unprocessable(
      'COUNTER_REQUIRED',
      'Say which counter this is for.',
      'counterId',
    );
  if (auth.device && counterId && counterId !== auth.device.counterId)
    throw forbidden(
      'DEVICE_COUNTER',
      'This device is registered to another counter.',
    );
  const counter = await tx.counter.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { store: true },
  });
  if (!counter || !canAccessStore(auth, counter.storeId))
    throw notFound('Counter');
  if (counter.status !== 'ACTIVE' || counter.store.status !== 'ACTIVE')
    throw unprocessable('COUNTER_INACTIVE', 'This counter is not active.');
  return counter;
}

/** The caller's open drawer on that counter. Sales and cash refunds need one. */
export async function openSessionFor(
  tx: Tx,
  auth: AuthContext,
  counterId: string,
) {
  const s = await tx.cashSession.findFirst({
    where: { tenantId: auth.tenantId, counterId, status: 'OPEN' },
  });
  if (!s)
    throw conflict(
      'NO_OPEN_SESSION',
      'Open the cash drawer on this counter first.',
    );
  if (s.userId !== auth.userId)
    throw conflict(
      'SESSION_NOT_YOURS',
      'Another cashier has the drawer open on this counter — they must close it first.',
    );
  return s;
}

/** Next number of a counter's series for the financial year; gap-free (rolls back with the sale). */
export async function nextDocumentNo(
  tx: Tx,
  tenantId: string,
  counter: { id: string; number: number; store: { code: string } },
  businessDate: string,
  kind: 'INV' | 'CN',
) {
  const fy = fyOf(businessDate);
  const [row] = await tx.$queryRaw<{ n: number }[]>`
    INSERT INTO invoice_sequences (tenant_id, counter_id, fy, kind, next)
    VALUES (${tenantId}::uuid, ${counter.id}::uuid, ${fy}, ${kind}, 2)
    ON CONFLICT (counter_id, fy, kind) DO UPDATE SET next = invoice_sequences.next + 1
    RETURNING next - 1 AS n`;
  const n = row!.n;
  if ((kind === 'INV' && n > 99_999) || (kind === 'CN' && n > 9_999))
    throw conflict(
      'SERIES_EXHAUSTED',
      'This counter has used up its number series for the year.',
    );
  const series = seriesOf(counter.store.code, counter.number);
  return kind === 'INV'
    ? invoiceNumber(series, fy, n)
    : creditNoteNumber(series, fy, n);
}

type Limits = {
  discountPct: Decimal;
  returnWithoutManager: Decimal;
  cashVariance: Decimal;
};

export async function salesLimits(tx: Tx, tenantId: string): Promise<Limits> {
  const t = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { settings: true },
  });
  const l = ((t.settings as { approvalLimits?: Record<string, unknown> } | null)
    ?.approvalLimits ?? {}) as Record<string, unknown>;
  const num = (k: string, d: number) =>
    new Decimal(
      typeof l[k] === 'number' && (l[k] as number) >= 0 ? (l[k] as number) : d,
    );
  return {
    discountPct: num('discountPct', 10),
    returnWithoutManager: num('returnWithoutManager', 2000),
    cashVariance: num('cashVariance', 200),
  };
}

export type Approval = { userId: string; pin: string };
export type Approver = {
  userId: string;
  permissions: Set<string>;
  storeIds: 'ALL' | string[];
};

const MAX_PIN_FAILURES = 5;
const PIN_LOCK_MS = 15 * 60_000;

/**
 * A manager approves at the counter by entering their own PIN (discounts above the limit, large
 * refunds, voids). Checked in its own transaction so failed attempts count even when the request
 * is then refused; five wrong PINs lock that PIN for 15 minutes, as for PIN sign-in.
 */
export async function verifyApprover(
  prisma: PrismaService,
  tenantId: string,
  a: Approval,
): Promise<Approver> {
  const invalid = () =>
    forbidden('APPROVAL_INVALID', 'That manager PIN is not valid.');
  return prisma
    .withTenant(tenantId, async (tx) => {
      const m = await tx.membership.findFirst({
        where: {
          tenantId,
          userId: a.userId,
          status: 'ACTIVE',
          user: { status: 'ACTIVE' },
        },
        include: {
          roles: { include: { role: { include: { permissions: true } } } },
          stores: true,
        },
      });
      if (!m?.pinHash) throw invalid();
      if (m.pinLockedUntil && m.pinLockedUntil > new Date())
        throw forbidden(
          'PIN_LOCKED',
          'That PIN is locked after too many wrong attempts. Try again later.',
        );
      if (!(await verifySecret(m.pinHash, a.pin))) {
        const failures = m.pinFailures + 1;
        await tx.membership.update({
          where: { id: m.id },
          data:
            failures >= MAX_PIN_FAILURES
              ? {
                  pinFailures: 0,
                  pinLockedUntil: new Date(Date.now() + PIN_LOCK_MS),
                }
              : { pinFailures: failures },
        });
        return null;
      }
      if (m.pinFailures)
        await tx.membership.update({
          where: { id: m.id },
          data: { pinFailures: 0 },
        });
      return {
        userId: m.userId,
        permissions: new Set(
          m.roles.flatMap((r) =>
            r.role.permissions.map((p) => p.permissionKey),
          ),
        ),
        storeIds: m.roles.some((r) => r.role.tenantWide)
          ? 'ALL'
          : m.stores.map((s) => s.storeId),
      } satisfies Approver;
    })
    .then((r) => {
      if (!r) throw invalid();
      return r;
    });
}

/** The caller, or the approving manager, holds `permission` at `storeId`. Returns who allowed it. */
export function authorise(
  auth: AuthContext,
  approver: Approver | null,
  permission: PermissionKey,
  storeId: string,
  what: string,
): string {
  if (auth.permissions.has(permission)) return auth.userId;
  if (
    approver &&
    approver.permissions.has(permission) &&
    (approver.storeIds === 'ALL' || approver.storeIds.includes(storeId))
  )
    return approver.userId;
  throw forbidden(
    'APPROVAL_REQUIRED',
    `${what} needs a manager's approval (their PIN).`,
  );
}

/**
 * People who could approve `permission` at `storeId` with their counter PIN — for the "ask a
 * manager" picker on the till. Only names and ids: nothing that helps guess a PIN.
 */
export async function listApprovers(
  tx: Tx,
  tenantId: string,
  permission: 'sales:void' | 'discount:override',
  storeId: string,
) {
  const rows = await tx.membership.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      pinHash: { not: null },
      user: { status: 'ACTIVE' },
      roles: {
        some: { role: { permissions: { some: { permissionKey: permission } } } },
      },
    },
    include: {
      user: { select: { name: true } },
      roles: { include: { role: { select: { tenantWide: true } } } },
      stores: { select: { storeId: true } },
    },
  });
  return rows
    .filter(
      (m) =>
        m.roles.some((r) => r.role.tenantWide) ||
        m.stores.some((s) => s.storeId === storeId),
    )
    .map((m) => ({ userId: m.userId, name: m.user.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
