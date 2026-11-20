import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { page, skipTake } from '../common/schemas.js';
import {
  assertPermission,
  canAccessStore,
  storeScope,
  type AuthContext,
} from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Prisma, SyncEvent } from '../generated/prisma/client.js';
import { invoiceNumber, seriesOf } from '../sales/bill-math.js';
import { conflict, notFound } from '../sales/sales.common.js';
import { SyncService } from './sync.service.js';
import type {
  ListIssuesQuery,
  RetryInput,
  StoreQuery,
} from './sync.schemas.js';
import type { Warning } from './sync.common.js';

/** A device's queue is worth a look when its oldest unsent bill is older than this. */
const STALE_QUEUE_MS = 60 * 60_000;

/**
 * What a manager sees of offline synchronisation: transactions that failed or were accepted with
 * warnings (and what to do with them), each device's queue, and the reserved number blocks.
 * Needs `cash:reconcile` at the branch.
 */
@Injectable()
export class SyncReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sync: SyncService,
  ) {}

  private async view(tx: Prisma.TransactionClient, rows: SyncEvent[]) {
    const deviceIds = [...new Set(rows.map((r) => r.deviceId))];
    const userIds = [
      ...new Set(
        rows.flatMap((r) => [r.cashierUserId, r.reviewedByUserId ?? '']),
      ),
    ].filter(Boolean);
    const devices = new Map(
      (
        await tx.terminalDevice.findMany({
          where: { id: { in: deviceIds } },
          select: { id: true, name: true },
        })
      ).map((d) => [d.id, d.name]),
    );
    const users = new Map(
      (
        await tx.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      ).map((u) => [u.id, u.name]),
    );
    return rows.map((r) => {
      const p = r.payload as {
        invoiceNo?: string;
        payable?: string;
        openingFloat?: string;
      };
      return {
        id: r.id,
        type: r.type,
        status: r.status,
        needsReview: r.needsReview,
        device: { id: r.deviceId, name: devices.get(r.deviceId) ?? null },
        storeId: r.storeId,
        counterId: r.counterId,
        cashier: {
          id: r.cashierUserId,
          name: users.get(r.cashierUserId) ?? null,
        },
        occurredAt: r.occurredAt,
        receivedAt: r.receivedAt,
        invoiceNo:
          (r.result as { invoiceNo?: string } | null)?.invoiceNo ??
          p.invoiceNo ??
          null,
        printedInvoiceNo: p.invoiceNo ?? null,
        payable: p.payable ?? null,
        openingFloat: p.openingFloat ?? null,
        saleId: r.saleId,
        cashSessionId: r.cashSessionId,
        warnings: r.warnings as Warning[],
        error: r.errorCode
          ? { code: r.errorCode, message: r.errorMessage }
          : null,
        attempts: r.attempts,
        review: r.reviewedAt
          ? {
              at: r.reviewedAt,
              by: {
                id: r.reviewedByUserId,
                name: users.get(r.reviewedByUserId ?? '') ?? null,
              },
              note: r.reviewNote,
            }
          : null,
        payload: r.payload,
      };
    });
  }

  issues(auth: AuthContext, q: ListIssuesQuery) {
    assertPermission(auth, 'cash:reconcile');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (q.storeId && !canAccessStore(auth, q.storeId))
        throw notFound('Branch');
      const where: Prisma.SyncEventWhereInput = {
        tenantId: auth.tenantId,
        ...(q.storeId ? { storeId: q.storeId } : storeScope(auth)),
        ...(q.deviceId && { deviceId: q.deviceId }),
        ...(q.status && { status: q.status }),
        ...(q.open && { needsReview: true }),
      };
      const rows = await tx.syncEvent.findMany({
        where,
        orderBy: [{ occurredAt: 'asc' }],
        ...skipTake(q),
      });
      const total = await tx.syncEvent.count({ where });
      return page(await this.view(tx, rows), total, q);
    });
  }

  private async loadEvent(auth: AuthContext, id: string) {
    const e = await this.prisma.withTenant(auth.tenantId, (tx) =>
      tx.syncEvent.findUnique({
        where: { tenantId_id: { tenantId: auth.tenantId, id } },
      }),
    );
    if (!e || !canAccessStore(auth, e.storeId))
      throw notFound('Sync transaction');
    return e;
  }

  private async one(auth: AuthContext, id: string) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const e = await tx.syncEvent.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: auth.tenantId, id } },
      });
      return (await this.view(tx, [e]))[0]!;
    });
  }

  /**
   * Runs a failed transaction again, as if its device had just sent it — after the cause was
   * fixed (drawer closed, product restored…). `renumber` records it under the counter's next
   * number when the printed one can't be used.
   */
  async retry(
    auth: AuthContext,
    id: string,
    input: RetryInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'cash:reconcile');
    const e = await this.loadEvent(auth, id);
    if (e.status !== 'FAILED')
      throw conflict(
        'INVALID_STATE',
        'Only a failed transaction can be re-run.',
      );
    const result = await this.sync.process(
      auth.tenantId,
      { id: e.deviceId, counterId: e.counterId, storeId: e.storeId },
      e.payload as Record<string, unknown> & { id: string; type: string },
      meta,
      { reviewerId: auth.userId, renumber: input.renumber, note: input.note },
    );
    await this.audit.record({
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action:
        result.status === 'ACCEPTED'
          ? 'sync.rerun_accepted'
          : 'sync.rerun_failed',
      entity: 'sync_event',
      entityId: id,
      data: {
        renumber: input.renumber,
        ...(result.error ? { error: result.error.code } : {}),
      },
      meta,
    });
    return { result, event: await this.one(auth, id) };
  }

  /** A failed transaction that will not be recorded (e.g. a test bill); the reason is kept. */
  async discard(
    auth: AuthContext,
    id: string,
    note: string,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'cash:reconcile');
    const e = await this.loadEvent(auth, id);
    await this.prisma.withTenant(auth.tenantId, async (tx) => {
      const done = await tx.syncEvent.updateMany({
        where: { tenantId: auth.tenantId, id: e.id, status: 'FAILED' },
        data: {
          status: 'DISCARDED',
          needsReview: false,
          reviewedAt: new Date(),
          reviewedByUserId: auth.userId,
          reviewNote: note,
        },
      });
      if (!done.count)
        throw conflict(
          'INVALID_STATE',
          'Only a failed transaction can be discarded.',
        );
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'sync.discarded',
          entity: 'sync_event',
          entityId: e.id,
          data: {
            note,
            error: e.errorCode,
            invoiceNo: (e.payload as { invoiceNo?: string }).invoiceNo ?? null,
          },
          meta,
        },
        tx,
      );
    });
    return this.one(auth, id);
  }

  /** The warnings of an accepted transaction were looked at. */
  async acknowledge(
    auth: AuthContext,
    id: string,
    note: string | undefined,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'cash:reconcile');
    const e = await this.loadEvent(auth, id);
    await this.prisma.withTenant(auth.tenantId, async (tx) => {
      const done = await tx.syncEvent.updateMany({
        where: {
          tenantId: auth.tenantId,
          id: e.id,
          status: 'ACCEPTED',
          needsReview: true,
        },
        data: {
          needsReview: false,
          reviewedAt: new Date(),
          reviewedByUserId: auth.userId,
          reviewNote: note ?? null,
        },
      });
      if (!done.count)
        throw conflict(
          'INVALID_STATE',
          'Nothing to acknowledge on this transaction.',
        );
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'sync.acknowledged',
          entity: 'sync_event',
          entityId: e.id,
          data: { codes: (e.warnings as Warning[]).map((w) => w.code) },
          meta,
        },
        tx,
      );
    });
    return this.one(auth, id);
  }

  /** Each POS device: last contact, its reported queue (age, size, failures), open reviews, blocks. */
  devices(auth: AuthContext, q: StoreQuery) {
    assertPermission(auth, 'cash:reconcile');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (q.storeId && !canAccessStore(auth, q.storeId))
        throw notFound('Branch');
      const devices = await tx.terminalDevice.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(q.storeId ? { storeId: q.storeId } : storeScope(auth)),
        },
        include: {
          counter: true,
          store: true,
          invoiceBlocks: { where: { closedAt: null } },
        },
        orderBy: [{ storeId: 'asc' }, { createdAt: 'asc' }],
      });
      const open = await tx.syncEvent.groupBy({
        by: ['deviceId', 'status'],
        where: {
          tenantId: auth.tenantId,
          needsReview: true,
          deviceId: { in: devices.map((d) => d.id) },
        },
        _count: { _all: true },
      });
      const now = Date.now();
      return {
        data: devices.map((d) => {
          const failed =
            open.find((o) => o.deviceId === d.id && o.status === 'FAILED')
              ?._count._all ?? 0;
          const warnings =
            open.find((o) => o.deviceId === d.id && o.status === 'ACCEPTED')
              ?._count._all ?? 0;
          const ageMs = d.queueOldestAt ? now - d.queueOldestAt.getTime() : 0;
          const numbersLeft = d.invoiceBlocks.reduce(
            (s, b) => s + (b.toSeq - (b.highestUsed ?? b.fromSeq - 1)),
            0,
          );
          const alerts = [
            ...(d.queuePending && ageMs > STALE_QUEUE_MS ? ['QUEUE_OLD'] : []),
            ...((d.queueFailed ?? 0) > 0 || failed > 0 ? ['FAILED_SYNC'] : []),
            ...(warnings > 0 ? ['REVIEW_WARNINGS'] : []),
            ...(Math.abs(d.clockSkewSeconds ?? 0) > 300 ? ['CLOCK_SKEW'] : []),
            ...(!d.revokedAt && numbersLeft < 20 ? ['FEW_NUMBERS_LEFT'] : []),
          ];
          return {
            id: d.id,
            name: d.name,
            store: { id: d.storeId, code: d.store.code, name: d.store.name },
            counter: {
              id: d.counterId,
              number: d.counter.number,
              name: d.counter.name,
            },
            revoked: !!d.revokedAt,
            lastSeenAt: d.lastSeenAt,
            lastSyncAt: d.lastSyncAt,
            appVersion: d.appVersion,
            clockSkewSeconds: d.clockSkewSeconds,
            queue: {
              pending: d.queuePending ?? 0,
              failed: d.queueFailed ?? 0,
              oldestAt: d.queueOldestAt,
              ageMinutes: Math.floor(ageMs / 60_000),
            },
            needsReview: { failed, warnings },
            numbersLeft,
            alerts,
          };
        }),
      };
    });
  }

  /**
   * Reserved number blocks with what was used — the unused numbers of finished blocks are the
   * series' only gaps, listed here for the GST records.
   */
  blocks(auth: AuthContext, q: StoreQuery) {
    assertPermission(auth, 'cash:reconcile');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (q.storeId && !canAccessStore(auth, q.storeId))
        throw notFound('Branch');
      const rows = await tx.invoiceBlock.findMany({
        where: {
          tenantId: auth.tenantId,
          counter: q.storeId ? { storeId: q.storeId } : storeScope(auth),
        },
        include: {
          device: { select: { name: true } },
          counter: { include: { store: true } },
        },
        orderBy: [{ counterId: 'asc' }, { fy: 'asc' }, { fromSeq: 'asc' }],
      });
      return {
        data: rows.map((b) => {
          const series = seriesOf(b.counter.store.code, b.counter.number);
          return {
            id: b.id,
            device: { id: b.deviceId, name: b.device.name },
            counter: {
              id: b.counterId,
              number: b.counter.number,
              name: b.counter.name,
            },
            fy: b.fy,
            first: invoiceNumber(series, b.fy, b.fromSeq),
            last: invoiceNumber(series, b.fy, b.toSeq),
            size: b.toSeq - b.fromSeq + 1,
            used: b.usedCount,
            unused: b.toSeq - b.fromSeq + 1 - b.usedCount,
            highestUsed:
              b.highestUsed === null
                ? null
                : invoiceNumber(series, b.fy, b.highestUsed),
            closedAt: b.closedAt,
            createdAt: b.createdAt,
          };
        }),
      };
    });
  }
}
