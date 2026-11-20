import { randomBytes, randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AccessService } from '../access/access.service.js';
import { createCatalogueDefaults } from '../catalogue/defaults.js';
import { AuditService } from '../audit/audit.service.js';
import { startTrial } from '../subscriptions/subscription-policy.js';
import { SessionService, type IssuedSession } from '../auth/session.service.js';
import { hashSecret } from '../auth/secrets.js';
import { AppException } from '../common/errors/app-exception.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Tenant } from '../generated/prisma/client.js';
import { StorageService } from '../storage/storage.service.js';
import { IMAGE_TYPES, sniffImage, typeOfKey } from '../catalogue/products.service.js';
import { assertPermission } from '../auth/auth-context.js';
import {
  tenantGstProblem,
  type AddBusinessInput,
  type BusinessInput,
  type HqInput,
  type RegisterTenantInput,
  type UpdateTenantInput,
} from './tenants.schemas.js';
import { storeView } from '../stores/stores.views.js';

/** Defaults agreed in Phase 0 (docs/phase-0/01-scope-and-decisions.md). Editable per business later. */
export const DEFAULT_SETTINGS = {
  priceBasis: 'INCLUSIVE',
  approvalLimits: {
    adjustmentValue: 5000,
    returnWithoutManager: 2000,
    discountPct: 10,
    purchaseOrderValue: 50000,
    cashVariance: 200,
  },
  offline: { maxHours: 24, maxPendingSales: 500 },
} as const;

export const tenantView = (t: Tenant) => ({
  id: t.id,
  slug: t.slug,
  displayName: t.displayName,
  legalName: t.legalName,
  businessType: t.businessType,
  registration: t.registration,
  gstin: t.gstin,
  stateCode: t.stateCode,
  phone: t.phone,
  email: t.email,
  address: {
    line1: t.addressLine1,
    line2: t.addressLine2,
    city: t.city,
    pincode: t.pincode,
  },
  timezone: t.timezone,
  /** Fetch it from GET /tenants/current/logo; changes whenever a new logo is uploaded. */
  logo: t.logoKey ? { version: t.logoKey.split('/').pop()?.split('.')[0] ?? '' } : null,
  settings: t.settings,
  status: t.status,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'business';

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly storage: StorageService,
  ) {}

  private readonly logger = new Logger(TenantsService.name);

  /** Business + system roles + owner membership + HQ branch + Counter 1, inside `tx`. */
  private async createBusiness(
    tx: Tx,
    tenantId: string,
    b: BusinessInput,
    hq: HqInput,
    owner: { userId: string; name: string },
    meta: RequestMeta,
  ) {
    const tenant = await tx.tenant.create({
      data: {
        id: tenantId,
        slug: `${slugify(b.displayName)}-${randomBytes(3).toString('hex')}`,
        displayName: b.displayName,
        legalName: b.legalName ?? null,
        businessType: b.businessType,
        registration: b.registration,
        gstin: b.gstin ?? null,
        stateCode: b.stateCode,
        phone: b.phone ?? null,
        email: b.email ?? null,
        addressLine1: b.address.line1,
        addressLine2: b.address.line2 ?? null,
        city: b.address.city,
        pincode: b.address.pincode,
        settings: DEFAULT_SETTINGS,
      },
    });
    const roleIds = await this.access.createSystemRoles(tx, tenantId);
    await createCatalogueDefaults(tx, tenantId);
    const membership = await tx.membership.create({
      data: { tenantId, userId: owner.userId },
    });
    await tx.membershipRole.create({
      data: { tenantId, membershipId: membership.id, roleId: roleIds.owner },
    });
    const store = await tx.store.create({
      data: {
        tenantId,
        code: hq.code,
        name: hq.name ?? b.address.city,
        isHq: true,
        addressLine1: b.address.line1,
        addressLine2: b.address.line2 ?? null,
        city: b.address.city,
        pincode: b.address.pincode,
        stateCode: b.stateCode,
        gstin: b.gstin ?? null,
        phone: b.phone ?? null,
        managerName: owner.name,
      },
    });
    const counter = await tx.counter.create({
      data: { tenantId, storeId: store.id, number: 1, name: 'Counter 1' },
    });
    // Every business starts with a free trial of the top plan (Phase 10).
    await startTrial(tx, tenantId);
    await this.audit.record(
      {
        tenantId,
        actorUserId: owner.userId,
        action: 'tenant.registered',
        entity: 'tenant',
        entityId: tenantId,
        data: {
          displayName: b.displayName,
          businessType: b.businessType,
          hqStoreId: store.id,
        },
        meta,
      },
      tx,
    );
    return { tenant, membership, store, counter };
  }

  private result(
    created: Awaited<ReturnType<TenantsService['createBusiness']>>,
    user: { id: string; name: string; email: string },
    session: IssuedSession,
  ) {
    return {
      ...session,
      tenant: tenantView(created.tenant),
      user: { id: user.id, name: user.name, email: user.email },
      store: storeView(created.store),
      counter: {
        id: created.counter.id,
        number: created.counter.number,
        name: created.counter.name,
      },
    };
  }

  /**
   * Onboarding a new person: owner account + business, in one transaction. Signs them in.
   * Someone who already has an account signs in and uses `addBusiness` instead.
   */
  async register(input: RegisterTenantInput, meta: RequestMeta) {
    const { business: b, owner, hq } = input;
    const existing = await this.prisma.user.findUnique({
      where: { email: owner.email },
      select: { id: true },
    });
    if (existing) {
      throw new AppException(
        'ALREADY_EXISTS',
        'An account with this email already exists. Sign in to add another business.',
        HttpStatus.CONFLICT,
      );
    }
    const passwordHash = await hashSecret(owner.password);
    const tenantId = randomUUID();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const user = await tx.user.create({
        data: { email: owner.email, name: owner.name, passwordHash },
      });
      const created = await this.createBusiness(
        tx,
        tenantId,
        b,
        hq,
        { userId: user.id, name: owner.name },
        meta,
      );
      const session = await this.sessions.issue(
        {
          userId: user.id,
          tenantId,
          membershipId: created.membership.id,
          kind: 'PASSWORD',
          meta,
        },
        tx,
      );
      return this.result(created, user, session);
    });
  }

  /** A signed-in person opens another business (they become its owner) and gets a session for it. */
  async addBusiness(
    auth: AuthContext,
    input: AddBusinessInput,
    meta: RequestMeta,
  ) {
    if (auth.sessionKind !== 'PASSWORD') {
      throw new AppException(
        'FORBIDDEN',
        'Sign in with your password to add a business.',
        HttpStatus.FORBIDDEN,
      );
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { id: true, name: true, email: true },
    });
    const tenantId = randomUUID();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const created = await this.createBusiness(
        tx,
        tenantId,
        input.business,
        input.hq,
        { userId: user.id, name: user.name },
        meta,
      );
      const session = await this.sessions.issue(
        {
          userId: user.id,
          tenantId,
          membershipId: created.membership.id,
          kind: 'PASSWORD',
          meta,
        },
        tx,
      );
      return this.result(created, user, session);
    });
  }

  async current(auth: AuthContext) {
    const t = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: auth.tenantId },
    });
    return tenantView(t);
  }

  async update(auth: AuthContext, patch: UpdateTenantInput, meta: RequestMeta) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await tx.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
      });
      // The type of business is chosen once, at setup (features, licences and reports follow it).
      if (patch.businessType !== undefined && patch.businessType !== cur.businessType)
        throw new AppException(
          'BUSINESS_TYPE_LOCKED',
          'The type of business is set when the business is created and can’t be changed.',
          HttpStatus.CONFLICT,
          [{ field: 'businessType', issue: 'set at setup; can’t be changed' }],
        );
      const merged = {
        registration: patch.registration ?? cur.registration,
        gstin:
          patch.gstin !== undefined ? patch.gstin : (cur.gstin ?? undefined),
        stateCode: patch.stateCode ?? cur.stateCode,
      };
      if (merged.registration === 'UNREGISTERED') merged.gstin = undefined;
      const problem = tenantGstProblem(merged);
      if (problem) {
        throw new AppException(
          'VALIDATION_FAILED',
          problem,
          HttpStatus.BAD_REQUEST,
          [{ field: 'gstin', issue: problem }],
        );
      }
      const a = patch.address;
      const t = await tx.tenant.update({
        where: { id: auth.tenantId },
        data: {
          ...(patch.displayName !== undefined && {
            displayName: patch.displayName,
          }),
          ...(patch.legalName !== undefined && { legalName: patch.legalName }),
          ...(patch.businessType !== undefined && {
            businessType: patch.businessType,
          }),
          ...(patch.phone !== undefined && { phone: patch.phone }),
          ...(patch.email !== undefined && { email: patch.email }),
          ...(a?.line1 !== undefined && { addressLine1: a.line1 }),
          ...(a?.line2 !== undefined && { addressLine2: a.line2 }),
          ...(a?.city !== undefined && { city: a.city }),
          ...(a?.pincode !== undefined && { pincode: a.pincode }),
          registration: merged.registration,
          gstin: merged.gstin ?? null,
          stateCode: merged.stateCode,
        },
      });
      // The head office bills under the business's own registration.
      await tx.store.updateMany({
        where: { tenantId: auth.tenantId, isHq: true },
        data: { gstin: t.gstin, stateCode: t.stateCode },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'tenant.updated',
          entity: 'tenant',
          entityId: auth.tenantId,
          data: { fields: Object.keys(patch) },
          meta,
        },
        tx,
      );
      return tenantView(t);
    });
  }

  /* ---------- shop logo ---------- */

  /** Sets the shop logo (JPEG, PNG or WebP; its real type is read from the bytes). */
  async putLogo(auth: AuthContext, file: { buffer: Buffer; size: number } | undefined, meta: RequestMeta) {
    assertPermission(auth, 'tenant:update');
    if (!file?.buffer?.length)
      throw new AppException('VALIDATION_FAILED', 'Attach the logo as the multipart field "logo".', HttpStatus.BAD_REQUEST);
    const ext = sniffImage(file.buffer);
    if (!ext)
      throw new AppException('UNSUPPORTED_MEDIA_TYPE', 'The logo must be a JPEG, PNG or WebP image.', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    const key = `t/${auth.tenantId}/logo/${randomUUID()}.${ext}`;
    await this.storage.put(key, file.buffer, IMAGE_TYPES[ext]);
    let old: string | null = null;
    try {
      const view = await this.prisma.withTenant(auth.tenantId, async (tx) => {
        const cur = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
        old = cur.logoKey;
        const t = await tx.tenant.update({ where: { id: auth.tenantId }, data: { logoKey: key } });
        await this.audit.record(
          { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'tenant.logo_set', entity: 'tenant', entityId: auth.tenantId, data: { bytes: file.size, type: IMAGE_TYPES[ext] }, meta },
          tx,
        );
        return tenantView(t);
      });
      if (old) await this.deleteQuietly(old);
      return view;
    } catch (e) {
      await this.deleteQuietly(key);
      throw e;
    }
  }

  async getLogo(auth: AuthContext) {
    assertPermission(auth, 'tenant:read');
    const t = await this.prisma.withTenant(auth.tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } }));
    const found = t.logoKey ? await this.storage.get(t.logoKey, typeOfKey(t.logoKey)) : null;
    if (!found) throw new AppException('NOT_FOUND', 'This business has no logo yet.', HttpStatus.NOT_FOUND);
    return found;
  }

  async deleteLogo(auth: AuthContext, meta: RequestMeta) {
    assertPermission(auth, 'tenant:update');
    let old: string | null = null;
    const view = await this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
      old = cur.logoKey;
      if (!old) return tenantView(cur);
      const t = await tx.tenant.update({ where: { id: auth.tenantId }, data: { logoKey: null } });
      await this.audit.record({ tenantId: auth.tenantId, actorUserId: auth.userId, action: 'tenant.logo_removed', entity: 'tenant', entityId: auth.tenantId, meta }, tx);
      return tenantView(t);
    });
    if (old) await this.deleteQuietly(old);
    return view;
  }

  private async deleteQuietly(key: string) {
    try {
      await this.storage.delete(key);
    } catch (err) {
      this.logger.warn({ err, key }, 'Could not delete stored object');
    }
  }
}
