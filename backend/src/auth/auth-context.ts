import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/errors/app-exception.js';
import type { PermissionKey } from '../access/permissions.js';
import type { EffectiveStatus } from '../subscriptions/subscription-policy.js';

/**
 * Who is calling and what they may touch — derived on every request from the access token
 * *and* the current database state of their membership. Never from client-supplied ids.
 */
export type AuthContext = {
  userId: string;
  tenantId: string;
  membershipId: string;
  roles: string[];
  permissions: ReadonlySet<PermissionKey>;
  /**
   * 'ALL' for tenant-wide roles, otherwise the branches assigned to the membership.
   * A PIN session is always limited to its device's branch.
   */
  storeIds: 'ALL' | readonly string[];
  sessionId: string;
  sessionFamilyId: string;
  sessionKind: 'PASSWORD' | 'PIN';
  /** Set for PIN sessions: the registered POS device and its counter. */
  device?: { id: string; counterId: string; storeId: string };
  /** The business's subscription as it applies now (Phase 10): read-only when not `writable`. */
  subscription: { status: EffectiveStatus; writable: boolean; plan: string };
};

export const can = (auth: AuthContext, permission: PermissionKey) =>
  auth.permissions.has(permission);

export const canAccessStore = (auth: AuthContext, storeId: string) =>
  auth.storeIds === 'ALL' || auth.storeIds.includes(storeId);

export function assertPermission(auth: AuthContext, permission: PermissionKey) {
  if (!can(auth, permission)) {
    throw new AppException(
      'FORBIDDEN',
      'You do not have permission to do this.',
      HttpStatus.FORBIDDEN,
    );
  }
}

/** Prisma `where` fragment limiting a store-owned query to the caller's branches. */
export const storeScope = (auth: AuthContext) =>
  auth.storeIds === 'ALL' ? {} : { storeId: { in: [...auth.storeIds] } };
