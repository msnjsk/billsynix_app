import { HttpStatus, Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AppException } from '../common/errors/app-exception.js';
import {
  PERMISSIONS,
  SYSTEM_ROLES,
  type PermissionKey,
  type SystemRoleKey,
} from './permissions.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { AccessClaims } from '../auth/token.service.js';
import { standing } from '../subscriptions/subscription-policy.js';

const unauthenticated = () =>
  new AppException(
    'UNAUTHENTICATED',
    'Sign in to continue.',
    HttpStatus.UNAUTHORIZED,
  );

@Injectable()
export class AccessService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  /** Keeps the permissions table in step with the code catalogue (idempotent). */
  async onModuleInit() {
    await this.prisma.permission.createMany({
      data: Object.entries(PERMISSIONS).map(([key, description]) => ({
        key,
        description,
      })),
      skipDuplicates: true,
    });
  }

  /** Creates the system roles for a new business; returns role ids by key. */
  async createSystemRoles(
    tx: Tx,
    tenantId: string,
  ): Promise<Record<SystemRoleKey, string>> {
    const ids = {} as Record<SystemRoleKey, string>;
    for (const r of SYSTEM_ROLES) {
      const role = await tx.role.create({
        data: {
          tenantId,
          key: r.key,
          name: r.name,
          tenantWide: r.tenantWide,
          isSystem: true,
          permissions: {
            createMany: {
              data: r.permissions.map((permissionKey) => ({ permissionKey })),
            },
          },
        },
      });
      ids[r.key] = role.id;
    }
    return ids;
  }

  /**
   * Builds the caller's context from token claims + current database state. Rejected when the
   * session was signed out or expired, the user/membership is disabled, the business suspended,
   * the token's ids don't belong together, or (PIN sessions) the device/counter/branch was
   * switched off — so revoking access takes effect on the next request, not at token expiry.
   */
  async resolve(claims: AccessClaims): Promise<AuthContext> {
    const [m, session] = await Promise.all([
      this.prisma.membership.findFirst({
        where: { id: claims.mid, tenantId: claims.tid, userId: claims.sub },
        select: {
          id: true,
          status: true,
          user: { select: { status: true } },
          tenant: { select: { status: true } },
        },
      }),
      this.prisma.session.findFirst({
        where: {
          id: claims.sid,
          userId: claims.sub,
          tenantId: claims.tid,
          membershipId: claims.mid,
        },
        select: {
          familyId: true,
          kind: true,
          deviceId: true,
          revokedAt: true,
          familyExpiresAt: true,
        },
      }),
    ]);
    if (!m || m.status !== 'ACTIVE' || m.user.status !== 'ACTIVE')
      throw unauthenticated();
    if (!session || session.revokedAt || session.familyExpiresAt <= new Date())
      throw unauthenticated();
    if (m.tenant.status !== 'ACTIVE') {
      throw new AppException(
        'TENANT_SUSPENDED',
        'This business account is not active.',
        HttpStatus.FORBIDDEN,
      );
    }

    const { roles, stores, device, subscription } =
      await this.prisma.withTenant(claims.tid, async (tx) => ({
        roles: await tx.membershipRole.findMany({
          where: { tenantId: claims.tid, membershipId: m.id },
          select: {
            role: {
              select: {
                key: true,
                tenantWide: true,
                permissions: { select: { permissionKey: true } },
              },
            },
          },
        }),
        stores: await tx.storeMembership.findMany({
          where: { tenantId: claims.tid, membershipId: m.id },
          select: { storeId: true },
        }),
        device: session.deviceId
          ? await tx.terminalDevice.findFirst({
              where: { id: session.deviceId, tenantId: claims.tid },
              select: {
                id: true,
                storeId: true,
                counterId: true,
                revokedAt: true,
                counter: { select: { status: true } },
                store: { select: { status: true } },
              },
            })
          : null,
        subscription: await tx.subscription.findUnique({
          where: { tenantId: claims.tid },
          include: { plan: { select: { code: true } } },
        }),
      }));
    // Every business has one (created with it, backfilled by the Phase 10 migration).
    const now = standing(
      subscription ?? {
        status: 'TRIALING',
        trialEndsAt: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      },
    );

    const permissions = new Set<PermissionKey>();
    for (const { role } of roles)
      for (const p of role.permissions)
        permissions.add(p.permissionKey as PermissionKey);

    let storeIds: 'ALL' | string[] = roles.some((r) => r.role.tenantWide)
      ? 'ALL'
      : stores.map((s) => s.storeId);

    if (session.kind === 'PIN') {
      const usable =
        device &&
        !device.revokedAt &&
        device.counter.status === 'ACTIVE' &&
        device.store.status === 'ACTIVE' &&
        (storeIds === 'ALL' || storeIds.includes(device.storeId));
      if (!usable) throw unauthenticated();
      storeIds = [device.storeId];
    }

    return {
      userId: claims.sub,
      tenantId: claims.tid,
      membershipId: m.id,
      roles: roles.map((r) => r.role.key),
      permissions,
      storeIds,
      sessionId: claims.sid,
      sessionFamilyId: session.familyId,
      sessionKind: session.kind,
      subscription: {
        status: now.status,
        writable: now.writable,
        plan: subscription?.plan.code ?? 'none',
      },
      ...(session.kind === 'PIN' && device
        ? {
            device: {
              id: device.id,
              counterId: device.counterId,
              storeId: device.storeId,
            },
          }
        : {}),
    };
  }
}
