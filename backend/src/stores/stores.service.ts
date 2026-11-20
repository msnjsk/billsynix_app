import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { assertCanAdd } from '../subscriptions/subscription-policy.js';
import { AppException } from '../common/errors/app-exception.js';
import { gstinProblem, panOf } from '../common/gst.js';
import { page, skipTake } from '../common/schemas.js';
import {
  assertPermission,
  canAccessStore,
  type AuthContext,
} from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Tenant } from '../generated/prisma/client.js';
import { counterView, deviceView, storeView } from './stores.views.js';
import type {
  CreateCounterInput,
  CreateStoreInput,
  ListStoresQuery,
  RegisterDeviceInput,
  UpdateCounterInput,
  UpdateStoreInput,
} from './stores.schemas.js';

const notFound = (what: string) =>
  new AppException('NOT_FOUND', `${what} not found.`, HttpStatus.NOT_FOUND);
const unprocessable = (code: string, message: string, field?: string) =>
  new AppException(
    code,
    message,
    HttpStatus.UNPROCESSABLE_ENTITY,
    field ? [{ field, issue: message }] : undefined,
  );

/** Branch GSTIN rules: one registration per state under the business's PAN. */
export function storeGstProblem(
  tenant: Pick<Tenant, 'registration' | 'gstin'>,
  stateCode: string,
  gstin: string | null | undefined,
): string | null {
  if (tenant.registration === 'UNREGISTERED')
    return gstin ? 'An unregistered business has no GSTIN.' : null;
  if (!gstin) return 'GSTIN is required for a GST-registered business.';
  const p = gstinProblem(gstin);
  if (p) return p;
  if (gstin.slice(0, 2) !== stateCode)
    return 'GSTIN state code does not match the branch state.';
  if (tenant.gstin && panOf(gstin) !== panOf(tenant.gstin))
    return "GSTIN must be registered under the business's PAN.";
  return null;
}

/** Device keys: `<tenantId>.<deviceId>.<secret>`; only a SHA-256 of the whole key is stored. */
export const hashDeviceKey = (key: string) =>
  createHash('sha256').update(key).digest('hex');

@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Loads a store the caller may see, or 404. Stores of other businesses and branches the
   * caller isn't assigned to are indistinguishable from missing ones.
   */
  private async visibleStore(tx: Tx, auth: AuthContext, storeId: string) {
    const store = await tx.store.findFirst({
      where: { id: storeId, tenantId: auth.tenantId },
    });
    if (!store || !canAccessStore(auth, store.id)) throw notFound('Branch');
    return store;
  }

  private async visibleCounter(tx: Tx, auth: AuthContext, counterId: string) {
    const counter = await tx.counter.findFirst({
      where: { id: counterId, tenantId: auth.tenantId },
      include: { store: true },
    });
    if (!counter || !canAccessStore(auth, counter.storeId))
      throw notFound('Counter');
    return counter;
  }

  /* ---------- stores ---------- */

  list(auth: AuthContext, q: ListStoresQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const where = {
        tenantId: auth.tenantId,
        ...(auth.storeIds === 'ALL' ? {} : { id: { in: [...auth.storeIds] } }),
        ...(q.status ? { status: q.status } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.store.findMany({
          where,
          orderBy: [{ isHq: 'desc' }, { name: 'asc' }],
          ...skipTake(q),
        }),
        tx.store.count({ where }),
      ]);
      return page(rows.map(storeView), total, q);
    });
  }

  get(auth: AuthContext, storeId: string) {
    return this.prisma.withTenant(auth.tenantId, async (tx) =>
      storeView(await this.visibleStore(tx, auth, storeId)),
    );
  }

  create(auth: AuthContext, input: CreateStoreInput, meta: RequestMeta) {
    assertPermission(auth, 'stores:manage');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
      });
      // The plan's branch limit first: no point fixing the form if the plan can't take it.
      await assertCanAdd(tx, auth.tenantId, 'branches');
      const problem = storeGstProblem(
        tenant,
        input.address.stateCode,
        input.gstin,
      );
      if (problem) throw unprocessable('INVALID_GSTIN', problem, 'gstin');
      const clash = await tx.store.findFirst({
        where: { tenantId: auth.tenantId, code: input.code },
        select: { id: true },
      });
      if (clash) {
        throw new AppException(
          'ALREADY_EXISTS',
          `Another branch already uses the code ${input.code}.`,
          HttpStatus.CONFLICT,
          [{ field: 'code', issue: 'taken' }],
        );
      }
      const store = await tx.store.create({
        data: {
          tenantId: auth.tenantId,
          code: input.code,
          name: input.name,
          kind: input.kind,
          addressLine1: input.address.line1,
          addressLine2: input.address.line2 ?? null,
          city: input.address.city,
          pincode: input.address.pincode,
          stateCode: input.address.stateCode,
          gstin: input.gstin ?? null,
          phone: input.phone ?? null,
          managerName: input.managerName ?? null,
          monthlyTarget: input.monthlyTarget ?? 0,
          openedOn: input.openedOn ? new Date(input.openedOn) : null,
          timezone: tenant.timezone,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'store.created',
          entity: 'store',
          entityId: store.id,
          data: { code: store.code, name: store.name, kind: store.kind },
          meta,
        },
        tx,
      );
      return storeView(store);
    });
  }

  update(
    auth: AuthContext,
    storeId: string,
    patch: UpdateStoreInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'stores:manage');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.visibleStore(tx, auth, storeId);
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
      });
      const stateCode = patch.address?.stateCode ?? cur.stateCode;
      const gstin = patch.gstin !== undefined ? patch.gstin : cur.gstin;
      if (
        cur.isHq &&
        (patch.gstin !== undefined || patch.address?.stateCode !== undefined)
      ) {
        throw unprocessable(
          'HQ_FOLLOWS_PROFILE',
          "The head office uses the business profile's GSTIN and state — change them there.",
        );
      }
      const problem = storeGstProblem(tenant, stateCode, gstin);
      if (problem) throw unprocessable('INVALID_GSTIN', problem, 'gstin');
      const a = patch.address;
      const store = await tx.store.update({
        where: { id: cur.id },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(a?.line1 !== undefined && { addressLine1: a.line1 }),
          ...(a?.line2 !== undefined && { addressLine2: a.line2 }),
          ...(a?.city !== undefined && { city: a.city }),
          ...(a?.pincode !== undefined && { pincode: a.pincode }),
          ...(patch.phone !== undefined && { phone: patch.phone }),
          ...(patch.managerName !== undefined && {
            managerName: patch.managerName,
          }),
          ...(patch.monthlyTarget !== undefined && {
            monthlyTarget: patch.monthlyTarget,
          }),
          ...(patch.openedOn !== undefined && {
            openedOn: patch.openedOn ? new Date(patch.openedOn) : null,
          }),
          stateCode,
          gstin: gstin ?? null,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'store.updated',
          entity: 'store',
          entityId: store.id,
          data: { fields: Object.keys(patch) },
          meta,
        },
        tx,
      );
      return storeView(store);
    });
  }

  /** Closing keeps history; the head office can't be closed. (Phase 5 adds "no stock left".) */
  close(auth: AuthContext, storeId: string, meta: RequestMeta) {
    assertPermission(auth, 'stores:manage');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.visibleStore(tx, auth, storeId);
      if (cur.isHq)
        throw unprocessable(
          'HQ_NOT_CLOSABLE',
          "The head office can't be closed.",
        );
      if (cur.status === 'CLOSED') return storeView(cur);
      const store = await tx.store.update({
        where: { id: cur.id },
        data: { status: 'CLOSED' },
      });
      await tx.counter.updateMany({
        where: { tenantId: auth.tenantId, storeId: cur.id },
        data: { status: 'DISABLED' },
      });
      await tx.terminalDevice.updateMany({
        where: { tenantId: auth.tenantId, storeId: cur.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'store.closed',
          entity: 'store',
          entityId: store.id,
          meta,
        },
        tx,
      );
      return storeView(store);
    });
  }

  /* ---------- counters ---------- */

  listCounters(auth: AuthContext, storeId: string) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const store = await this.visibleStore(tx, auth, storeId);
      const rows = await tx.counter.findMany({
        where: { tenantId: auth.tenantId, storeId: store.id },
        orderBy: { number: 'asc' },
      });
      return { data: rows.map(counterView) };
    });
  }

  createCounter(
    auth: AuthContext,
    storeId: string,
    input: CreateCounterInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'counters:manage');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const store = await this.visibleStore(tx, auth, storeId);
      if (store.status !== 'ACTIVE')
        throw unprocessable('STORE_CLOSED', 'This branch is closed.');
      if (store.kind !== 'STORE')
        throw unprocessable(
          'NOT_A_STORE',
          "Warehouses don't have billing counters.",
        );
      const taken = new Set(
        (
          await tx.counter.findMany({
            where: { tenantId: auth.tenantId, storeId: store.id },
            select: { number: true },
          })
        ).map((c) => c.number),
      );
      const number =
        input.number ?? [1, 2, 3, 4, 5, 6, 7, 8, 9].find((n) => !taken.has(n));
      if (number === undefined)
        throw unprocessable(
          'COUNTER_LIMIT',
          'A branch can have at most 9 counters.',
        );
      await assertCanAdd(tx, auth.tenantId, 'counters');
      if (taken.has(number)) {
        throw new AppException(
          'ALREADY_EXISTS',
          `Counter ${number} already exists in this branch.`,
          HttpStatus.CONFLICT,
          [{ field: 'number', issue: 'taken' }],
        );
      }
      const counter = await tx.counter.create({
        data: {
          tenantId: auth.tenantId,
          storeId: store.id,
          number,
          name: input.name,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'counter.created',
          entity: 'counter',
          entityId: counter.id,
          data: { storeId: store.id, number },
          meta,
        },
        tx,
      );
      return counterView(counter);
    });
  }

  updateCounter(
    auth: AuthContext,
    counterId: string,
    patch: UpdateCounterInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'counters:manage');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.visibleCounter(tx, auth, counterId);
      if (patch.status === 'ACTIVE' && cur.store.status !== 'ACTIVE')
        throw unprocessable('STORE_CLOSED', 'This branch is closed.');
      if (patch.status === 'ACTIVE' && cur.status !== 'ACTIVE')
        await assertCanAdd(tx, auth.tenantId, 'counters');
      const counter = await tx.counter.update({
        where: { id: cur.id },
        data: patch,
      });
      if (patch.status === 'DISABLED') {
        await tx.terminalDevice.updateMany({
          where: {
            tenantId: auth.tenantId,
            counterId: cur.id,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'counter.updated',
          entity: 'counter',
          entityId: counter.id,
          data: patch,
          meta,
        },
        tx,
      );
      return counterView(counter);
    });
  }

  /* ---------- devices ---------- */

  /** Registers a POS computer for a counter. The device key is returned once and never again. */
  registerDevice(
    auth: AuthContext,
    counterId: string,
    input: RegisterDeviceInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'devices:register');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const counter = await this.visibleCounter(tx, auth, counterId);
      if (counter.status !== 'ACTIVE' || counter.store.status !== 'ACTIVE')
        throw unprocessable('COUNTER_INACTIVE', 'This counter is not active.');
      const id = randomUUID();
      const deviceKey = `${auth.tenantId}.${id}.${randomBytes(32).toString('base64url')}`;
      const device = await tx.terminalDevice.create({
        data: {
          id,
          tenantId: auth.tenantId,
          storeId: counter.storeId,
          counterId: counter.id,
          name: input.name,
          keyHash: hashDeviceKey(deviceKey),
          registeredByUserId: auth.userId,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'device.registered',
          entity: 'device',
          entityId: device.id,
          data: { counterId: counter.id, name: device.name },
          meta,
        },
        tx,
      );
      return { device: deviceView(device), deviceKey };
    });
  }

  listDevices(auth: AuthContext, storeId: string) {
    assertPermission(auth, 'devices:register');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const store = await this.visibleStore(tx, auth, storeId);
      const rows = await tx.terminalDevice.findMany({
        where: { tenantId: auth.tenantId, storeId: store.id },
        orderBy: { createdAt: 'asc' },
      });
      return { data: rows.map(deviceView) };
    });
  }

  revokeDevice(auth: AuthContext, deviceId: string, meta: RequestMeta) {
    assertPermission(auth, 'devices:register');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await tx.terminalDevice.findFirst({
        where: { id: deviceId, tenantId: auth.tenantId },
      });
      if (!cur || !canAccessStore(auth, cur.storeId)) throw notFound('Device');
      if (cur.revokedAt) return deviceView(cur);
      const device = await tx.terminalDevice.update({
        where: { id: cur.id },
        data: { revokedAt: new Date() },
      });
      // Its reserved invoice numbers are no longer handed out (bills it already numbered still sync).
      await tx.invoiceBlock.updateMany({
        where: { tenantId: auth.tenantId, deviceId: cur.id, closedAt: null },
        data: { closedAt: new Date() },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'device.revoked',
          entity: 'device',
          entityId: device.id,
          meta,
        },
        tx,
      );
      return deviceView(device);
    });
  }
}
