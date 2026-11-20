import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { AppException } from '../common/errors/app-exception.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { AuthContext } from './auth-context.js';
import type { RequestMeta } from './decorators.js';
import { SessionService, type IssuedSession } from './session.service.js';
import {
  hashSecret,
  needsRehash,
  newSecret,
  parseDeviceKey,
  sameHash,
  sha256,
  verifyAgainstDummy,
  verifySecret,
} from './secrets.js';
import type {
  ChangePasswordInput,
  LoginInput,
  PinLoginInput,
  ResetPasswordInput,
} from './auth.schemas.js';

/** Account protection (docs/phase-3-auth.md). */
export const LOCKOUT = { maxFailures: 5, lockMs: 15 * 60_000 } as const;
const RESET_TOKEN_MS = 30 * 60_000;

const invalidCredentials = () =>
  new AppException(
    'INVALID_CREDENTIALS',
    'Email or password is incorrect.',
    HttpStatus.UNAUTHORIZED,
  );
const invalidPin = () =>
  new AppException('INVALID_PIN', 'PIN is incorrect.', HttpStatus.UNAUTHORIZED);
const invalidDevice = () =>
  new AppException(
    'INVALID_DEVICE',
    'This device is not registered or was revoked.',
    HttpStatus.UNAUTHORIZED,
  );
const locked = (until: Date, code = 'ACCOUNT_LOCKED') => {
  const minutes = Math.max(
    1,
    Math.ceil((until.getTime() - Date.now()) / 60_000),
  );
  return new AppException(
    code,
    `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    HttpStatus.TOO_MANY_REQUESTS,
  );
};

export type LoginResult =
  | ({ status: 'AUTHENTICATED' } & IssuedSession & {
        user: { id: string; name: string; email: string };
        tenant: { id: string; displayName: string };
      })
  | { status: 'SELECT_TENANT'; tenants: { id: string; displayName: string }[] };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /* ---------- password sign-in ---------- */

  async login(input: LoginInput, meta: RequestMeta): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
    });
    if (!user) {
      await verifyAgainstDummy(input.password);
      await this.audit.record({
        action: 'auth.login_failed',
        data: { email: input.email, reason: 'unknown_email' },
        meta,
      });
      throw invalidCredentials();
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.record({
        actorUserId: user.id,
        action: 'auth.login_blocked',
        data: { reason: 'locked' },
        meta,
      });
      throw locked(user.lockedUntil);
    }

    if (!(await verifySecret(user.passwordHash, input.password))) {
      const failures = user.failedLogins + 1;
      const lock = failures >= LOCKOUT.maxFailures;
      await this.prisma.user.update({
        where: { id: user.id },
        data: lock
          ? {
              failedLogins: 0,
              lockedUntil: new Date(Date.now() + LOCKOUT.lockMs),
            }
          : { failedLogins: failures },
      });
      await this.audit.record({
        actorUserId: user.id,
        action: lock ? 'auth.account_locked' : 'auth.login_failed',
        data: { reason: 'bad_password', failures },
        meta,
      });
      throw invalidCredentials();
    }
    if (user.status !== 'ACTIVE') throw invalidCredentials();

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLogins: 0,
        lockedUntil: null,
        // Upgrade hashes made with older cost settings, transparently.
        ...(needsRehash(user.passwordHash)
          ? { passwordHash: await hashSecret(input.password) }
          : {}),
      },
    });

    const memberships = await this.prisma.membership.findMany({
      where: {
        userId: user.id,
        status: 'ACTIVE',
        tenant: { status: 'ACTIVE' },
      },
      select: {
        id: true,
        tenantId: true,
        tenant: { select: { displayName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!memberships.length) {
      throw new AppException(
        'NO_ACTIVE_BUSINESS',
        "This account isn't part of an active business.",
        HttpStatus.FORBIDDEN,
      );
    }
    const chosen = input.tenantId
      ? memberships.find((m) => m.tenantId === input.tenantId)
      : memberships.length === 1
        ? memberships[0]
        : undefined;
    if (!chosen) {
      if (input.tenantId) throw invalidCredentials();
      return {
        status: 'SELECT_TENANT',
        tenants: memberships.map((m) => ({
          id: m.tenantId,
          displayName: m.tenant.displayName,
        })),
      };
    }

    const issued = await this.sessions.issue({
      userId: user.id,
      tenantId: chosen.tenantId,
      membershipId: chosen.id,
      kind: 'PASSWORD',
      meta,
    });
    await this.audit.record({
      tenantId: chosen.tenantId,
      actorUserId: user.id,
      action: 'auth.login_succeeded',
      entity: 'session',
      entityId: issued.familyId,
      meta,
    });
    return {
      status: 'AUTHENTICATED',
      ...issued,
      user: { id: user.id, name: user.name, email: user.email },
      tenant: { id: chosen.tenantId, displayName: chosen.tenant.displayName },
    };
  }

  /** Signs in to another business the same person belongs to. Not available to PIN (counter) sessions. */
  async switchTenant(auth: AuthContext, tenantId: string, meta: RequestMeta) {
    if (auth.sessionKind !== 'PASSWORD') {
      throw new AppException(
        'FORBIDDEN',
        'Counter sessions are bound to their branch.',
        HttpStatus.FORBIDDEN,
      );
    }
    const m = await this.prisma.membership.findFirst({
      where: {
        userId: auth.userId,
        tenantId,
        status: 'ACTIVE',
        tenant: { status: 'ACTIVE' },
      },
      select: { id: true, tenant: { select: { displayName: true } } },
    });
    if (!m)
      throw new AppException(
        'NOT_FOUND',
        'Business not found.',
        HttpStatus.NOT_FOUND,
      );
    const issued = await this.sessions.issue({
      userId: auth.userId,
      tenantId,
      membershipId: m.id,
      kind: 'PASSWORD',
      meta,
    });
    await this.audit.record({
      tenantId,
      actorUserId: auth.userId,
      action: 'auth.tenant_switched',
      entity: 'session',
      entityId: issued.familyId,
      meta,
    });
    return {
      ...issued,
      tenant: { id: tenantId, displayName: m.tenant.displayName },
    };
  }

  async me(auth: AuthContext) {
    const [user, tenant, others] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: auth.userId },
        select: { id: true, name: true, email: true },
      }),
      this.prisma.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
        select: { id: true, displayName: true, businessType: true },
      }),
      this.prisma.membership.findMany({
        where: {
          userId: auth.userId,
          status: 'ACTIVE',
          tenant: { status: 'ACTIVE' },
        },
        select: { tenant: { select: { id: true, displayName: true } } },
      }),
    ]);
    return {
      user,
      tenant,
      membership: {
        id: auth.membershipId,
        roles: auth.roles,
        permissions: [...auth.permissions].sort(),
        storeIds: auth.storeIds === 'ALL' ? null : auth.storeIds,
      },
      session: {
        id: auth.sessionId,
        kind: auth.sessionKind,
        device: auth.device ?? null,
      },
      businesses: others.map((o) => o.tenant),
    };
  }

  /* ---------- sessions ---------- */

  async listSessions(auth: AuthContext) {
    const rows = await this.prisma.session.findMany({
      where: {
        userId: auth.userId,
        revokedAt: null,
        rotatedAt: null,
        familyExpiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        familyId: true,
        kind: true,
        tenantId: true,
        userAgent: true,
        ip: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        deviceId: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      data: rows.map((r) => ({
        id: r.familyId,
        kind: r.kind,
        tenantId: r.tenantId,
        userAgent: r.userAgent,
        ip: r.ip,
        deviceId: r.deviceId,
        lastActiveAt: r.lastUsedAt ?? r.createdAt,
        expiresAt: r.expiresAt,
        current: r.familyId === auth.sessionFamilyId,
      })),
    };
  }

  async revokeSession(auth: AuthContext, familyId: string, meta: RequestMeta) {
    const owned = await this.prisma.session.findFirst({
      where: { familyId, userId: auth.userId },
      select: { id: true },
    });
    if (!owned)
      throw new AppException(
        'NOT_FOUND',
        'Session not found.',
        HttpStatus.NOT_FOUND,
      );
    await this.sessions.revokeFamily(familyId, 'USER_REVOKED');
    await this.audit.record({
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'auth.session_revoked',
      entity: 'session',
      entityId: familyId,
      meta,
    });
  }

  async recordLogout(
    s: { userId: string; tenantId: string; familyId: string },
    meta: RequestMeta,
  ) {
    await this.audit.record({
      tenantId: s.tenantId,
      actorUserId: s.userId,
      action: 'auth.logout',
      entity: 'session',
      entityId: s.familyId,
      meta,
    });
  }

  async logoutEverywhere(auth: AuthContext, meta: RequestMeta) {
    const n = await this.sessions.revokeAllForUser(auth.userId, 'LOGOUT_ALL');
    await this.audit.record({
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'auth.logout_all',
      data: { sessions: n },
      meta,
    });
  }

  /* ---------- passwords ---------- */

  private assertPasswordAllowed(password: string, email: string) {
    const local = email.split('@')[0] ?? '';
    if (
      local.length >= 4 &&
      password.toLowerCase().includes(local.toLowerCase())
    ) {
      throw new AppException(
        'WEAK_PASSWORD',
        "Don't use your email address in the password.",
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'newPassword', issue: 'contains_email' }],
      );
    }
  }

  /** Changing the password signs out every other session; the current one stays. */
  async changePassword(
    auth: AuthContext,
    input: ChangePasswordInput,
    meta: RequestMeta,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
    });
    if (!(await verifySecret(user.passwordHash, input.currentPassword))) {
      await this.audit.record({
        tenantId: auth.tenantId,
        actorUserId: user.id,
        action: 'auth.password_change_failed',
        meta,
      });
      throw invalidCredentials();
    }
    this.assertPasswordAllowed(input.newPassword, user.email);
    const passwordHash = await hashSecret(input.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, passwordChangedAt: new Date() },
      });
      await this.sessions.revokeAllForUser(
        user.id,
        'PASSWORD_CHANGED',
        auth.sessionFamilyId,
        tx,
      );
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: user.id,
          action: 'auth.password_changed',
          meta,
        },
        tx,
      );
    });
  }

  /** Always answers the same way, whether or not the email is registered. */
  async forgotPassword(email: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE') {
      await this.audit.record({
        action: 'auth.password_reset_requested',
        data: { email, matched: false },
        meta,
      });
      return;
    }
    const token = newSecret();
    await this.prisma.$transaction(async (tx) => {
      // Only the newest link works.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + RESET_TOKEN_MS),
          requestedIp: meta.ip ?? null,
        },
      });
      await this.audit.record(
        {
          actorUserId: user.id,
          action: 'auth.password_reset_requested',
          data: { matched: true },
          meta,
        },
        tx,
      );
    });
    const link = `${this.env.FRONTEND_URL.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
    await this.mailer.send({
      to: user.email,
      subject: 'Reset your password',
      text: `Hi ${user.name},\n\nUse this link within 30 minutes to choose a new password:\n${link}\n\nIf you didn't ask for this, ignore this email — your password stays the same.`,
    });
  }

  /** Sets a new password from an emailed token, unlocks the account and signs out every session. */
  async resetPassword(input: ResetPasswordInput, meta: RequestMeta) {
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(input.token) },
      include: { user: true },
    });
    if (
      !row ||
      row.usedAt ||
      row.expiresAt <= new Date() ||
      row.user.status !== 'ACTIVE'
    ) {
      throw new AppException(
        'INVALID_RESET_TOKEN',
        'This reset link is invalid or has expired. Request a new one.',
        HttpStatus.BAD_REQUEST,
      );
    }
    this.assertPasswordAllowed(input.newPassword, row.user.email);
    const passwordHash = await hashSecret(input.newPassword);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new AppException(
          'INVALID_RESET_TOKEN',
          'This reset link is invalid or has expired. Request a new one.',
          HttpStatus.BAD_REQUEST,
        );
      }
      await tx.user.update({
        where: { id: row.userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLogins: 0,
          lockedUntil: null,
        },
      });
      await this.sessions.revokeAllForUser(
        row.userId,
        'PASSWORD_RESET',
        undefined,
        tx,
      );
      await this.audit.record(
        { actorUserId: row.userId, action: 'auth.password_reset', meta },
        tx,
      );
    });
  }

  /* ---------- POS devices and counter PINs ---------- */

  /** Authenticates a device key; the device, its counter and branch must all be active. */
  private async device(deviceKey: string | undefined) {
    const parsed = deviceKey ? parseDeviceKey(deviceKey) : null;
    if (!parsed || !deviceKey) throw invalidDevice();
    const device = await this.prisma.withTenant(parsed.tenantId, (tx) =>
      tx.terminalDevice.findFirst({
        where: { id: parsed.deviceId, tenantId: parsed.tenantId },
        include: { counter: true, store: true },
      }),
    );
    if (
      !device ||
      !sameHash(device.keyHash, sha256(deviceKey)) ||
      device.revokedAt ||
      device.counter.status !== 'ACTIVE' ||
      device.store.status !== 'ACTIVE'
    ) {
      throw invalidDevice();
    }
    await this.prisma.withTenant(device.tenantId, (tx) =>
      tx.terminalDevice.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date() },
      }),
    );
    return device;
  }

  /** Members who may bill at this device's branch and have a PIN set (also used to check a PIN login). */
  private async eligibleMembers(tenantId: string, storeId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.membership.findMany({
        where: {
          tenantId,
          status: 'ACTIVE',
          pinHash: { not: null },
          user: { status: 'ACTIVE' },
          roles: {
            some: {
              role: {
                permissions: { some: { permissionKey: 'sales:create' } },
              },
            },
          },
          OR: [
            { roles: { some: { role: { tenantWide: true } } } },
            { stores: { some: { storeId } } },
          ],
        },
        select: {
          id: true,
          userId: true,
          pinHash: true,
          pinFailures: true,
          pinLockedUntil: true,
          user: { select: { name: true } },
        },
        orderBy: { user: { name: 'asc' } },
      }),
    );
  }

  /** The names a cashier picks from on the counter's sign-in screen. */
  async deviceCashiers(deviceKey: string | undefined) {
    const device = await this.device(deviceKey);
    const members = await this.eligibleMembers(device.tenantId, device.storeId);
    return {
      device: { id: device.id, name: device.name },
      counter: {
        id: device.counter.id,
        number: device.counter.number,
        name: device.counter.name,
      },
      store: {
        id: device.store.id,
        code: device.store.code,
        name: device.store.name,
      },
      cashiers: members.map((m) => ({ membershipId: m.id, name: m.user.name })),
    };
  }

  async pinLogin(
    deviceKey: string | undefined,
    input: PinLoginInput,
    meta: RequestMeta,
  ) {
    const device = await this.device(deviceKey);
    const member = (
      await this.eligibleMembers(device.tenantId, device.storeId)
    ).find((m) => m.id === input.membershipId);
    if (!member?.pinHash) {
      await verifyAgainstDummy(input.pin);
      throw invalidPin();
    }
    if (member.pinLockedUntil && member.pinLockedUntil > new Date())
      throw locked(member.pinLockedUntil, 'PIN_LOCKED');

    const ok = await verifySecret(member.pinHash, input.pin);
    const tenantId = device.tenantId;
    if (!ok) {
      const failures = member.pinFailures + 1;
      const lock = failures >= LOCKOUT.maxFailures;
      await this.prisma.membership.update({
        where: { id: member.id },
        data: lock
          ? {
              pinFailures: 0,
              pinLockedUntil: new Date(Date.now() + LOCKOUT.lockMs),
            }
          : { pinFailures: failures },
      });
      await this.audit.record({
        tenantId,
        actorUserId: member.userId,
        action: lock ? 'auth.pin_locked' : 'auth.pin_failed',
        entity: 'device',
        entityId: device.id,
        meta,
      });
      throw invalidPin();
    }
    await this.prisma.membership.update({
      where: { id: member.id },
      data: { pinFailures: 0, pinLockedUntil: null },
    });
    // One counter at a time: signing in here ends their PIN session on any other computer.
    const endedOn = await this.sessions.revokePinSessions(
      member.userId,
      tenantId,
    );
    const issued = await this.sessions.issue({
      userId: member.userId,
      tenantId,
      membershipId: member.id,
      kind: 'PIN',
      deviceId: device.id,
      meta,
    });
    await this.audit.record({
      tenantId,
      actorUserId: member.userId,
      action: 'auth.pin_login',
      entity: 'session',
      entityId: issued.familyId,
      data: {
        deviceId: device.id,
        counterId: device.counterId,
        ...(endedOn.length ? { endedSessionsOn: endedOn } : {}),
      },
      meta,
    });
    return {
      ...issued,
      user: { id: member.userId, name: member.user.name },
      counter: {
        id: device.counter.id,
        number: device.counter.number,
        name: device.counter.name,
      },
      store: {
        id: device.store.id,
        code: device.store.code,
        name: device.store.name,
      },
    };
  }
}
