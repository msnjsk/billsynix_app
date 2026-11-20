import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { assertCanAdd } from '../subscriptions/subscription-policy.js';
import { AppException } from '../common/errors/app-exception.js';
import { page, skipTake } from '../common/schemas.js';
import { assertPermission, type AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import { ROLES_A_BRANCH_MANAGER_MAY_ASSIGN } from '../access/permissions.js';
import { hashSecret } from '../auth/secrets.js';
import type {
  CreateMembershipInput,
  ListMembershipsQuery,
  UpdateMembershipInput,
} from './memberships.schemas.js';

const include = {
  user: { select: { id: true, name: true, email: true, status: true } },
  roles: {
    select: { role: { select: { key: true, name: true, tenantWide: true } } },
  },
  stores: { select: { storeId: true } },
} as const;

type Row = {
  id: string;
  status: string;
  pinHash: string | null;
  createdAt: Date;
  user: { id: string; name: string; email: string; status: string };
  roles: { role: { key: string; name: string; tenantWide: boolean } }[];
  stores: { storeId: string }[];
};

const view = (m: Row) => {
  const tenantWide = m.roles.some((r) => r.role.tenantWide);
  return {
    id: m.id,
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    status: m.status,
    roles: m.roles.map((r) => r.role.key),
    /** null = every branch (tenant-wide role). */
    storeIds: tenantWide ? null : m.stores.map((s) => s.storeId),
    hasPin: m.pinHash !== null,
    createdAt: m.createdAt,
  };
};

const forbidden = (message: string) =>
  new AppException('FORBIDDEN', message, HttpStatus.FORBIDDEN);
const unprocessable = (code: string, message: string, field?: string) =>
  new AppException(
    code,
    message,
    HttpStatus.UNPROCESSABLE_ENTITY,
    field ? [{ field, issue: message }] : undefined,
  );

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /* ---------- rules ---------- */

  private async rolesFor(tx: Tx, tenantId: string, keys: string[]) {
    const roles = await tx.role.findMany({
      where: { tenantId, key: { in: keys } },
    });
    const missing = keys.filter((k) => !roles.some((r) => r.key === k));
    if (missing.length)
      throw unprocessable(
        'UNKNOWN_ROLE',
        `Unknown role: ${missing.join(', ')}.`,
        'roleKeys',
      );
    return roles;
  }

  /** Branch ids must belong to this business; ids of other businesses look like missing ones. */
  private async checkStores(tx: Tx, tenantId: string, ids: string[]) {
    if (!ids.length) return;
    const found = await tx.store.count({
      where: { tenantId, id: { in: ids } },
    });
    if (found !== ids.length)
      throw unprocessable(
        'UNKNOWN_STORE',
        'One or more branches were not found.',
        'storeIds',
      );
  }

  /** What the caller may hand out: owners only by owners; branch managers only cashiers in their own branches. */
  private assertMayAssign(
    auth: AuthContext,
    roleKeys: string[],
    storeIds: string[],
  ) {
    if (roleKeys.includes('owner') && !auth.roles.includes('owner')) {
      throw forbidden('Only an owner can make someone an owner.');
    }
    if (auth.storeIds !== 'ALL') {
      const scope = auth.storeIds;
      const rolesOk = roleKeys.every((k) =>
        (ROLES_A_BRANCH_MANAGER_MAY_ASSIGN as readonly string[]).includes(k),
      );
      const storesOk =
        storeIds.length > 0 && storeIds.every((s) => scope.includes(s));
      if (!rolesOk || !storesOk)
        throw forbidden('You can only manage cashiers in your own branches.');
    }
  }

  /** Branch-scoped callers may only manage members who are cashiers entirely within their branches. */
  private assertMayManage(auth: AuthContext, target: Row) {
    const keys = target.roles.map((r) => r.role.key);
    if (keys.includes('owner') && !auth.roles.includes('owner')) {
      throw forbidden('Only an owner can change an owner.');
    }
    if (auth.storeIds !== 'ALL') {
      this.assertMayAssign(
        auth,
        keys,
        target.stores.map((s) => s.storeId),
      );
    }
  }

  private async activeOwnerCount(
    tx: Tx,
    tenantId: string,
    excludingMembershipId?: string,
  ) {
    return tx.membership.count({
      where: {
        tenantId,
        status: 'ACTIVE',
        ...(excludingMembershipId
          ? { id: { not: excludingMembershipId } }
          : {}),
        roles: { some: { role: { key: 'owner' } } },
      },
    });
  }

  private async load(tx: Tx, auth: AuthContext, id: string): Promise<Row> {
    const m = await tx.membership.findFirst({
      where: { id, tenantId: auth.tenantId },
      include,
    });
    if (!m)
      throw new AppException(
        'NOT_FOUND',
        'Member not found.',
        HttpStatus.NOT_FOUND,
      );
    if (
      auth.storeIds !== 'ALL' &&
      !m.stores.some((s) =>
        (auth.storeIds as readonly string[]).includes(s.storeId),
      )
    ) {
      throw new AppException(
        'NOT_FOUND',
        'Member not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return m;
  }

  /* ---------- queries ---------- */

  list(auth: AuthContext, q: ListMembershipsQuery) {
    assertPermission(auth, 'users:manage');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const scope = auth.storeIds === 'ALL' ? undefined : [...auth.storeIds];
      const storeFilter = q.storeId
        ? scope && !scope.includes(q.storeId)
          ? ['00000000-0000-0000-0000-000000000000']
          : [q.storeId]
        : scope;
      const where = {
        tenantId: auth.tenantId,
        ...(q.status ? { status: q.status } : {}),
        ...(storeFilter
          ? { stores: { some: { storeId: { in: storeFilter } } } }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.membership.findMany({
          where,
          include,
          orderBy: { createdAt: 'asc' },
          ...skipTake(q),
        }),
        tx.membership.count({ where }),
      ]);
      return page(rows.map(view), total, q);
    });
  }

  get(auth: AuthContext, id: string) {
    assertPermission(auth, 'users:manage');
    return this.prisma.withTenant(auth.tenantId, async (tx) =>
      view(await this.load(tx, auth, id)),
    );
  }

  roles(auth: AuthContext) {
    assertPermission(auth, 'users:manage');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.role.findMany({
        where: { tenantId: auth.tenantId },
        include: { permissions: { select: { permissionKey: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return {
        data: rows.map((r) => ({
          id: r.id,
          key: r.key,
          name: r.name,
          tenantWide: r.tenantWide,
          isSystem: r.isSystem,
          permissions: r.permissions.map((p) => p.permissionKey).sort(),
        })),
      };
    });
  }

  /* ---------- commands ---------- */

  async create(
    auth: AuthContext,
    input: CreateMembershipInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'users:manage');
    const pinHash = input.pin ? await hashSecret(input.pin) : null;
    const newPasswordHash = input.password
      ? await hashSecret(input.password)
      : null;

    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const roles = await this.rolesFor(tx, auth.tenantId, input.roleKeys);
      const tenantWide = roles.some((r) => r.tenantWide);
      const storeIds = tenantWide ? [] : input.storeIds;
      if (!tenantWide && !storeIds.length) {
        throw unprocessable(
          'STORES_REQUIRED',
          'Assign at least one branch for this role.',
          'storeIds',
        );
      }
      await this.checkStores(tx, auth.tenantId, storeIds);
      this.assertMayAssign(auth, input.roleKeys, storeIds);
      await assertCanAdd(tx, auth.tenantId, 'users');

      // A person can work for several businesses: reuse their account, never touch its password.
      let user = await tx.user.findUnique({ where: { email: input.email } });
      const existingAccount = user !== null;
      if (user) {
        const already = await tx.membership.findFirst({
          where: { tenantId: auth.tenantId, userId: user.id },
          select: { id: true },
        });
        if (already) {
          throw new AppException(
            'ALREADY_EXISTS',
            'This person is already a member of the business.',
            HttpStatus.CONFLICT,
          );
        }
      } else {
        if (!newPasswordHash) {
          throw unprocessable(
            'PASSWORD_REQUIRED',
            'Set a password for this new account.',
            'password',
          );
        }
        user = await tx.user.create({
          data: {
            email: input.email,
            name: input.name,
            passwordHash: newPasswordHash,
          },
        });
      }

      const created = await tx.membership.create({
        data: { tenantId: auth.tenantId, userId: user.id, pinHash },
      });
      await tx.membershipRole.createMany({
        data: roles.map((r) => ({
          tenantId: auth.tenantId,
          membershipId: created.id,
          roleId: r.id,
        })),
      });
      if (storeIds.length) {
        await tx.storeMembership.createMany({
          data: storeIds.map((storeId) => ({
            tenantId: auth.tenantId,
            membershipId: created.id,
            storeId,
          })),
        });
      }
      const m = await tx.membership.findUniqueOrThrow({
        where: { id: created.id },
        include,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'membership.created',
          entity: 'membership',
          entityId: m.id,
          data: {
            userId: user.id,
            roles: input.roleKeys,
            storeIds,
            existingAccount,
          },
          meta,
        },
        tx,
      );
      return view(m);
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    patch: UpdateMembershipInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'users:manage');
    const pinHash = patch.pin
      ? await hashSecret(patch.pin)
      : patch.pin === null
        ? null
        : undefined;

    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.load(tx, auth, id);
      this.assertMayManage(auth, cur);
      if (
        id === auth.membershipId &&
        (patch.roleKeys || patch.status || patch.storeIds)
      ) {
        throw unprocessable(
          'SELF_CHANGE',
          "You can't change your own roles, branches or status.",
        );
      }

      const roleKeys = patch.roleKeys ?? cur.roles.map((r) => r.role.key);
      const roles = await this.rolesFor(tx, auth.tenantId, roleKeys);
      const tenantWide = roles.some((r) => r.tenantWide);
      const storeIds = tenantWide
        ? []
        : (patch.storeIds ?? cur.stores.map((s) => s.storeId));
      if (!tenantWide && !storeIds.length) {
        throw unprocessable(
          'STORES_REQUIRED',
          'Assign at least one branch for this role.',
          'storeIds',
        );
      }
      await this.checkStores(tx, auth.tenantId, storeIds);
      this.assertMayAssign(auth, roleKeys, storeIds);
      if (patch.status === 'ACTIVE' && cur.status !== 'ACTIVE')
        await assertCanAdd(tx, auth.tenantId, 'users');

      const wasOwner =
        cur.roles.some((r) => r.role.key === 'owner') &&
        cur.status === 'ACTIVE';
      const staysOwner =
        roleKeys.includes('owner') && (patch.status ?? cur.status) === 'ACTIVE';
      if (
        wasOwner &&
        !staysOwner &&
        (await this.activeOwnerCount(tx, auth.tenantId, id)) === 0
      ) {
        throw unprocessable(
          'LAST_OWNER',
          'The business must keep at least one active owner.',
        );
      }

      if (patch.roleKeys) {
        await tx.membershipRole.deleteMany({
          where: { tenantId: auth.tenantId, membershipId: id },
        });
        await tx.membershipRole.createMany({
          data: roles.map((r) => ({
            tenantId: auth.tenantId,
            membershipId: id,
            roleId: r.id,
          })),
        });
      }
      if (patch.roleKeys || patch.storeIds) {
        await tx.storeMembership.deleteMany({
          where: { tenantId: auth.tenantId, membershipId: id },
        });
        if (storeIds.length) {
          await tx.storeMembership.createMany({
            data: storeIds.map((storeId) => ({
              tenantId: auth.tenantId,
              membershipId: id,
              storeId,
            })),
          });
        }
      }
      const m = await tx.membership.update({
        where: { id },
        data: {
          ...(patch.status ? { status: patch.status } : {}),
          ...(pinHash !== undefined ? { pinHash } : {}),
        },
        include,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'membership.updated',
          entity: 'membership',
          entityId: id,
          data: {
            ...(patch.roleKeys ? { roles: roleKeys } : {}),
            ...(patch.storeIds || patch.roleKeys ? { storeIds } : {}),
            ...(patch.status ? { status: patch.status } : {}),
            ...(patch.pin !== undefined
              ? { pin: patch.pin === null ? 'cleared' : 'changed' }
              : {}),
          },
          meta,
        },
        tx,
      );
      return view(m);
    });
  }
}
