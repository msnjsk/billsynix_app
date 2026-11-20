import { describe, expect, it } from 'vitest';
import { GRACE_DAYS, standing } from './subscription-policy.js';

const DAY = 86_400_000;
const now = new Date('2026-11-18T06:00:00Z');
const at = (days: number) => new Date(now.getTime() + days * DAY);
const sub = (over: Partial<Parameters<typeof standing>[0]>) => ({
  status: 'ACTIVE' as const,
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  ...over,
});

describe('subscription standing', () => {
  it('a trial works until it ends, then 7 days of grace, then read-only', () => {
    expect(
      standing(sub({ status: 'TRIALING', trialEndsAt: at(1) }), now),
    ).toMatchObject({ status: 'TRIALING', writable: true });
    expect(
      standing(sub({ status: 'TRIALING', trialEndsAt: at(-1) }), now),
    ).toMatchObject({
      status: 'PAST_DUE',
      writable: true,
      graceEndsAt: at(GRACE_DAYS - 1),
    });
    expect(
      standing(
        sub({ status: 'TRIALING', trialEndsAt: at(-GRACE_DAYS - 1) }),
        now,
      ),
    ).toMatchObject({ status: 'EXPIRED', writable: false });
  });

  it('a paid period, its grace, and the lapse after it', () => {
    expect(standing(sub({ currentPeriodEnd: at(10) }), now)).toMatchObject({
      status: 'ACTIVE',
      writable: true,
      endsAt: at(10),
    });
    expect(
      standing(sub({ currentPeriodEnd: at(-GRACE_DAYS) }), now),
    ).toMatchObject({ status: 'PAST_DUE', writable: true });
    expect(
      standing(sub({ currentPeriodEnd: at(-GRACE_DAYS - 0.01) }), now).status,
    ).toBe('EXPIRED');
  });

  it('not renewing: works to the end of the period, then cancelled with no grace', () => {
    expect(
      standing(sub({ currentPeriodEnd: at(2), cancelAtPeriodEnd: true }), now),
    ).toMatchObject({ status: 'ACTIVE', writable: true });
    expect(
      standing(
        sub({ currentPeriodEnd: at(-0.5), cancelAtPeriodEnd: true }),
        now,
      ),
    ).toMatchObject({ status: 'CANCELLED', writable: false });
    expect(
      standing(
        sub({
          status: 'TRIALING',
          trialEndsAt: at(-1),
          cancelAtPeriodEnd: true,
        }),
        now,
      ).status,
    ).toBe('CANCELLED');
  });

  it('stopped by the platform: read-only whatever the dates', () => {
    expect(
      standing(sub({ status: 'SUSPENDED', currentPeriodEnd: at(30) }), now),
    ).toMatchObject({ status: 'SUSPENDED', writable: false });
    expect(
      standing(sub({ status: 'CANCELLED', currentPeriodEnd: at(30) }), now)
        .writable,
    ).toBe(false);
  });
});
