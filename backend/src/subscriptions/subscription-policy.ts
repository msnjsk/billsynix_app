import { HttpStatus } from '@nestjs/common';
import type { Tx } from '../database/prisma.service.js';
import { AppException } from '../common/errors/app-exception.js';
import type { Plan, Subscription } from '../generated/prisma/client.js';

/** A new business tries the top plan for this long, without paying. */
export const TRIAL_DAYS = 14;
export const TRIAL_PLAN = 'business';
/** After a trial or paid period ends unpaid, everything keeps working for this long. */
export const GRACE_DAYS = 7;

const DAY = 86_400_000;

/**
 * What applies now:
 *  - TRIALING / ACTIVE: normal;
 *  - PAST_DUE: the trial or period ended unpaid — still fully usable until `graceEndsAt`;
 *  - EXPIRED: grace is over — read-only until a payment;
 *  - CANCELLED: the owner didn't renew and the paid period is over — read-only;
 *  - SUSPENDED: stopped by the platform — read-only.
 * Read-only means: everyone can still sign in, see and export their data, pay, and synchronise
 * bills a counter made offline; nothing new is recorded.
 */
export type EffectiveStatus =
  'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'EXPIRED' | 'CANCELLED' | 'SUSPENDED';

export type Standing = {
  status: EffectiveStatus;
  /** May the business record new things (sales, stock, purchases…)? */
  writable: boolean;
  /** End of the trial or the paid period. */
  endsAt: Date | null;
  /** While PAST_DUE: when writing stops. */
  graceEndsAt: Date | null;
};

export function standing(
  s: Pick<
    Subscription,
    'status' | 'trialEndsAt' | 'currentPeriodEnd' | 'cancelAtPeriodEnd'
  >,
  now = new Date(),
): Standing {
  const t = now.getTime();
  if (s.status === 'SUSPENDED')
    return {
      status: 'SUSPENDED',
      writable: false,
      endsAt: s.currentPeriodEnd,
      graceEndsAt: null,
    };
  if (s.status === 'CANCELLED')
    return {
      status: 'CANCELLED',
      writable: false,
      endsAt: s.currentPeriodEnd,
      graceEndsAt: null,
    };
  const endsAt = s.status === 'TRIALING' ? s.trialEndsAt : s.currentPeriodEnd;
  if (!endsAt || t <= endsAt.getTime())
    return { status: s.status, writable: true, endsAt, graceEndsAt: null };
  if (s.cancelAtPeriodEnd)
    return { status: 'CANCELLED', writable: false, endsAt, graceEndsAt: null };
  const graceEndsAt = new Date(endsAt.getTime() + GRACE_DAYS * DAY);
  return t <= graceEndsAt.getTime()
    ? { status: 'PAST_DUE', writable: true, endsAt, graceEndsAt }
    : { status: 'EXPIRED', writable: false, endsAt, graceEndsAt };
}

/** Every new business starts here (inside its creation transaction). */
export async function startTrial(tx: Tx, tenantId: string, now = new Date()) {
  const plan = await tx.plan.findUniqueOrThrow({ where: { code: TRIAL_PLAN } });
  return tx.subscription.create({
    data: {
      tenantId,
      planId: plan.id,
      status: 'TRIALING',
      trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * DAY),
    },
  });
}

export type Resource = 'branches' | 'counters' | 'users';

export async function usage(tx: Tx, tenantId: string) {
  const branches = await tx.store.count({
    where: { tenantId, status: 'ACTIVE' },
  });
  const counters = await tx.counter.count({
    where: { tenantId, status: 'ACTIVE' },
  });
  const users = await tx.membership.count({
    where: { tenantId, status: 'ACTIVE' },
  });
  return { branches, counters, users };
}

export const limitsOf = (p: Plan) => ({
  branches: p.maxBranches,
  counters: p.maxCounters,
  users: p.maxUsers,
});

const NOUN: Record<Resource, [string, string]> = {
  branches: ['branch', 'branches'],
  counters: ['billing counter', 'billing counters'],
  users: ['active staff member', 'active staff members'],
};

/**
 * Refuses to add one more `resource` beyond the plan's limit (call inside the transaction that adds
 * it, before adding). Locks the subscription row so two concurrent additions can't both slip in.
 */
export async function assertCanAdd(
  tx: Tx,
  tenantId: string,
  resource: Resource,
) {
  await tx.$queryRaw`SELECT id FROM subscriptions WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
  const sub = await tx.subscription.findUnique({
    where: { tenantId },
    include: { plan: true },
  });
  if (!sub) return; // created lazily for very old data; see AccessService
  const limit = limitsOf(sub.plan)[resource];
  const used = (await usage(tx, tenantId))[resource];
  if (used + 1 > limit) {
    const [one, many] = NOUN[resource];
    throw new AppException(
      'PLAN_LIMIT_REACHED',
      `The ${sub.plan.name} plan includes ${limit} ${limit === 1 ? one : many}. Upgrade the plan to add more.`,
      HttpStatus.FORBIDDEN,
      [{ field: resource, issue: `limit ${limit}` }],
    );
  }
}
