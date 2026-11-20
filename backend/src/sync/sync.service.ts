import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Decimal } from '../common/decimal.js';
import { AppException } from '../common/errors/app-exception.js';
import { gstinProblem } from '../common/gst.js';
import { assertPermission, type AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import { Prisma, type SyncEvent } from '../generated/prisma/client.js';
import { storePrices } from '../catalogue/pricing.js';
import {
  computeBill,
  fyOf,
  inclusivePrice,
  invoiceNumber,
  seriesOf,
  type DiscountIn,
} from '../sales/bill-math.js';
import {
  conflict,
  forbidden,
  nextDocumentNo,
  salesLimits,
  todayIn,
  unprocessable,
} from '../sales/sales.common.js';
import {
  checkTenders,
  SalesService,
  type PricedLine,
} from '../sales/sales.service.js';
import {
  syncTransaction,
  type BatchInput,
  type CashSessionOpenTxn,
  type OfflineSaleTxn,
  type ReserveBlockInput,
} from './sync.schemas.js';
import {
  CLOCK_GRACE_MS,
  dateIn,
  offlinePolicy,
  payloadHash,
  requireDevice,
  type Warning,
} from './sync.common.js';

const ZERO = new Decimal(0);

type Device = { id: string; counterId: string; storeId: string };

export type TxnResult = {
  id: string;
  /**
   * ACCEPTED — recorded now (or earlier: `replayed`); FAILED — refused by a business rule and kept
   * on the server for a manager (the device keeps it too, and stops sending it); RETRY — not
   * processed (server busy); send it again later.
   */
  status: 'ACCEPTED' | 'FAILED' | 'DISCARDED' | 'RETRY';
  replayed?: boolean;
  type?: string;
  saleId?: string;
  invoiceNo?: string;
  cashSessionId?: string;
  warnings: Warning[];
  error?: { code: string; message: string };
};

type Outcome = {
  result: Record<string, unknown>;
  warnings: Warning[];
  saleId?: string;
  cashSessionId?: string;
};

const asJson = (v: unknown) =>
  JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

/** A unique index refused the row: someone else used it first. */
function uniqueViolation(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
    return JSON.stringify(e.meta ?? {});
  const msg = e instanceof Error ? e.message : '';
  return (
    /duplicate key value violates unique constraint "([^"]+)"/.exec(msg)?.[1] ??
    null
  );
}

/**
 * Offline POS synchronisation (Phase 9).
 *
 * A device uploads what it did while offline as a batch of transactions, each with its own UUID.
 * Every transaction is validated and recorded on its own, in its own database transaction, and
 * gets its own result — one bad bill never blocks the rest of the queue. The UUID is the
 * idempotency key: an upload that is retried, duplicated or sent twice at once is answered from
 * `sync_events` and never recorded twice. Refused transactions are kept, with their payload, for a
 * manager to re-run or discard (`/sync/issues`).
 *
 * Offline bills are recorded as the customer was charged: the device's price and tax (what the
 * printed invoice says), its invoice number (from a block reserved for the device, ADR-007), and
 * stock that may go below zero. Differences from what the server would have done today are
 * warnings for review, not reasons to refuse.
 */
@Injectable()
export class SyncService {
  private readonly log = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sales: SalesService,
  ) {}

  /* ---------- device configuration ---------- */

  /** What the device needs to bill offline: who it is, the business on the bill, limits, blocks. */
  config(authIn: AuthContext) {
    const auth = requireDevice(authIn);
    assertPermission(auth, 'sales:create');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const device = await tx.terminalDevice.findUniqueOrThrow({
        where: { id: auth.device.id },
        include: { counter: true, store: true },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
      });
      const user = await tx.user.findUniqueOrThrow({
        where: { id: auth.userId },
        select: { id: true, name: true },
      });
      const session = await tx.session.findUniqueOrThrow({
        where: { id: auth.sessionId },
        select: { familyExpiresAt: true },
      });
      const policy = await offlinePolicy(tx, auth.tenantId);
      const limits = await salesLimits(tx, auth.tenantId);
      const today = todayIn(device.store.timezone);
      const drawer = await tx.cashSession.findFirst({
        where: {
          tenantId: auth.tenantId,
          counterId: device.counterId,
          status: 'OPEN',
        },
        select: { id: true, userId: true, openingFloat: true, openedAt: true },
      });
      return {
        serverTime: new Date(),
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
          stateCode: device.store.stateCode,
          gstin: device.store.gstin ?? tenant.gstin,
          timezone: device.store.timezone,
          address: [
            device.store.addressLine1,
            device.store.addressLine2,
            device.store.city,
            device.store.pincode,
          ]
            .filter(Boolean)
            .join(', '),
          phone: device.store.phone ?? tenant.phone,
        },
        business: {
          displayName: tenant.displayName,
          legalName: tenant.legalName,
          registration: tenant.registration,
          documentType:
            tenant.registration === 'REGULAR'
              ? 'TAX_INVOICE'
              : 'BILL_OF_SUPPLY',
        },
        /** The cashier signed in now; offline billing ends with their shift. */
        cashier: { ...user, sessionEndsAt: session.familyExpiresAt },
        drawer: drawer
          ? {
              id: drawer.id,
              userId: drawer.userId,
              openingFloat: drawer.openingFloat.toFixed(2),
              openedAt: drawer.openedAt,
            }
          : null,
        series: seriesOf(device.store.code, device.counter.number),
        fy: fyOf(today),
        policy,
        discountLimitPct: Number(limits.discountPct),
        blocks: await this.openBlocks(tx, auth.tenantId, device.id),
      };
    });
  }

  private async openBlocks(tx: Tx, tenantId: string, deviceId: string) {
    const rows = await tx.invoiceBlock.findMany({
      where: { tenantId, deviceId, closedAt: null },
      include: { counter: { include: { store: true } } },
      orderBy: { fromSeq: 'asc' },
    });
    return rows.map((b) => ({
      id: b.id,
      fy: b.fy,
      series: seriesOf(b.counter.store.code, b.counter.number),
      from: b.fromSeq,
      to: b.toSeq,
      /** Highest number the server has received a bill for; continue after it. */
      highestUsed: b.highestUsed,
      first: invoiceNumber(
        seriesOf(b.counter.store.code, b.counter.number),
        b.fy,
        b.fromSeq,
      ),
    }));
  }

  /* ---------- invoice number blocks (ADR-007) ---------- */

  /**
   * Reserves the next `size` numbers of the counter's series for this device, for the current
   * financial year. Online sales on the counter carry on after the block. A device holds at most
   * two unfinished blocks (the one in use and the next).
   */
  reserveBlock(
    authIn: AuthContext,
    input: ReserveBlockInput,
    meta: RequestMeta,
  ) {
    const auth = requireDevice(authIn);
    assertPermission(auth, 'sales:create');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const counter = await tx.counter.findFirstOrThrow({
        where: { id: auth.device.counterId, tenantId: auth.tenantId },
        include: { store: true },
      });
      const policy = await offlinePolicy(tx, auth.tenantId);
      const size = input.size ?? policy.blockSize;
      const fy = fyOf(todayIn(counter.store.timezone));
      // Blocks of past years, and fully used ones, are finished.
      await tx.$executeRaw`
        UPDATE invoice_blocks SET closed_at = now()
        WHERE tenant_id = ${auth.tenantId}::uuid AND device_id = ${auth.device.id}::uuid
          AND closed_at IS NULL AND (fy <> ${fy} OR highest_used = to_seq)`;
      const open = await tx.invoiceBlock.count({
        where: {
          tenantId: auth.tenantId,
          deviceId: auth.device.id,
          closedAt: null,
        },
      });
      if (open >= 2)
        throw conflict(
          'BLOCKS_AVAILABLE',
          'This device already has two blocks of numbers it has not used up.',
        );
      const [row] = await tx.$queryRaw<{ from_seq: number }[]>`
        INSERT INTO invoice_sequences (tenant_id, counter_id, fy, kind, next)
        VALUES (${auth.tenantId}::uuid, ${counter.id}::uuid, ${fy}, 'INV', ${1 + size})
        ON CONFLICT (counter_id, fy, kind) DO UPDATE SET next = invoice_sequences.next + ${size}
        RETURNING next - ${size} AS from_seq`;
      const from = row!.from_seq;
      const to = from + size - 1;
      if (to > 99_999)
        throw conflict(
          'SERIES_EXHAUSTED',
          'This counter has used up its number series for the year.',
        );
      const block = await tx.invoiceBlock.create({
        data: {
          tenantId: auth.tenantId,
          deviceId: auth.device.id,
          counterId: counter.id,
          fy,
          fromSeq: from,
          toSeq: to,
          createdByUserId: auth.userId,
        },
      });
      const series = seriesOf(counter.store.code, counter.number);
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'invoice_block.reserved',
          entity: 'invoice_block',
          entityId: block.id,
          data: {
            deviceId: auth.device.id,
            first: invoiceNumber(series, fy, from),
            last: invoiceNumber(series, fy, to),
          },
          meta,
        },
        tx,
      );
      return {
        id: block.id,
        fy,
        series,
        from,
        to,
        highestUsed: null,
        first: invoiceNumber(series, fy, from),
        last: invoiceNumber(series, fy, to),
      };
    });
  }

  /* ---------- batch upload ---------- */

  async batch(authIn: AuthContext, input: BatchInput, meta: RequestMeta) {
    const auth = requireDevice(authIn);
    assertPermission(auth, 'sales:create');
    const now = new Date();
    await this.prisma.withTenant(auth.tenantId, (tx) =>
      tx.terminalDevice.update({
        where: { id: auth.device.id },
        data: {
          lastSeenAt: now,
          lastSyncAt: now,
          ...(input.appVersion ? { appVersion: input.appVersion } : {}),
          ...(input.deviceTime
            ? {
                clockSkewSeconds: Math.round(
                  (Date.parse(input.deviceTime) - now.getTime()) / 1000,
                ),
              }
            : {}),
          ...(input.queue
            ? {
                queuePending: input.queue.pending,
                queueFailed: input.queue.failed,
                queueOldestAt: input.queue.oldestAt
                  ? new Date(input.queue.oldestAt)
                  : null,
              }
            : {}),
        },
      }),
    );
    const results: TxnResult[] = [];
    // In order: a drawer opened offline comes before the bills taken in it.
    for (const raw of input.transactions)
      results.push(await this.process(auth.tenantId, auth.device, raw, meta));
    return { serverTime: new Date(), results };
  }

  /**
   * One transaction, idempotently. Also used to re-run a failed one (`retry`), with the device it
   * came from.
   */
  async process(
    tenantId: string,
    device: Device,
    raw: Record<string, unknown> & { id: string; type: string },
    meta: RequestMeta,
    retry?: {
      reviewerId: string;
      renumber: boolean;
      note?: string | undefined;
    },
  ): Promise<TxnResult> {
    const id = raw.id;
    const hash = payloadHash(raw);

    if (!retry) {
      const prior = await this.prisma.withTenant(tenantId, (tx) =>
        tx.syncEvent.findUnique({ where: { tenantId_id: { tenantId, id } } }),
      );
      if (prior) return this.replay(prior, hash);
    }

    const parsed = syncTransaction.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return this.fail(
        tenantId,
        device,
        raw,
        hash,
        {
          code: 'VALIDATION_FAILED',
          message: issue
            ? `${issue.path.join('.') || 'transaction'}: ${issue.message}`
            : 'The transaction is not valid.',
        },
        retry,
      );
    }
    const txn = parsed.data;

    try {
      return await this.prisma.withTenant(
        tenantId,
        async (tx) => {
          if (retry) {
            const [locked] = await tx.$queryRaw<{ status: string }[]>`
              SELECT status::text FROM sync_events
              WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
            if (locked?.status !== 'FAILED')
              throw conflict(
                'INVALID_STATE',
                'Only a failed transaction can be re-run.',
              );
          } else {
            // Claim the id first: a concurrent duplicate waits here, then replays our answer.
            const inserted = await tx.$executeRaw`
              INSERT INTO sync_events (tenant_id, id, device_id, store_id, counter_id, type, status,
                                       request_hash, payload, occurred_at, cashier_user_id)
              VALUES (${tenantId}::uuid, ${id}::uuid, ${device.id}::uuid, ${device.storeId}::uuid,
                      ${device.counterId}::uuid, ${txn.type}::"SyncEventType", 'ACCEPTED',
                      ${hash}, ${JSON.stringify(raw)}::jsonb, ${new Date(txn.occurredAt)},
                      ${txn.cashierUserId}::uuid)
              ON CONFLICT DO NOTHING`;
            if (inserted === 0) {
              const prior = await tx.syncEvent.findUniqueOrThrow({
                where: { tenantId_id: { tenantId, id } },
              });
              return this.replay(prior, hash);
            }
          }

          const out =
            txn.type === 'SALE'
              ? await this.recordSale(tx, tenantId, device, txn, meta, retry)
              : await this.openDrawer(tx, tenantId, device, txn, meta);
          const warnings = out.warnings;
          await tx.syncEvent.update({
            where: { tenantId_id: { tenantId, id } },
            data: {
              status: 'ACCEPTED',
              result: asJson(out.result),
              warnings: asJson(warnings),
              saleId: out.saleId ?? null,
              cashSessionId: out.cashSessionId ?? null,
              errorCode: null,
              errorMessage: null,
              processedAt: new Date(),
              ...(retry
                ? {
                    attempts: { increment: 1 },
                    needsReview: false,
                    reviewedAt: new Date(),
                    reviewedByUserId: retry.reviewerId,
                    reviewNote: retry.note ?? null,
                  }
                : { needsReview: warnings.length > 0 }),
            },
          });
          if (warnings.length && !retry)
            await tx.outboxEvent.create({
              data: {
                tenantId,
                topic: 'sync.review_needed',
                payload: asJson({
                  syncEventId: id,
                  deviceId: device.id,
                  storeId: device.storeId,
                  codes: warnings.map((w) => w.code),
                }),
              },
            });
          return {
            id,
            status: 'ACCEPTED' as const,
            type: txn.type,
            ...(out.result as Partial<TxnResult>),
            warnings,
          };
        },
        { timeout: 30_000 },
      );
    } catch (e) {
      let err = e;
      const unique = uniqueViolation(e);
      if (unique)
        err = conflict(
          /invoice_no/.test(unique) ? 'NUMBER_IN_USE' : 'DUPLICATE',
          /invoice_no/.test(unique)
            ? 'Another bill already has this invoice number.'
            : 'This was recorded already by another upload.',
        );
      if (err instanceof AppException)
        return this.fail(
          tenantId,
          device,
          raw,
          hash,
          {
            code: err.code,
            message: err.message,
          },
          retry,
        );
      // Deadlock, timeout, lost connection: nothing was recorded; the device sends it again.
      this.log.warn(`sync ${id} not processed: ${(e as Error).message}`);
      return {
        id,
        status: 'RETRY',
        warnings: [],
        error: {
          code: 'TRY_AGAIN',
          message: 'The server could not take this now.',
        },
      };
    }
  }

  private replay(prior: SyncEvent, hash: string): TxnResult {
    if (prior.requestHash !== hash)
      return {
        id: prior.id,
        status: 'FAILED',
        warnings: [],
        error: {
          code: 'ID_REUSED',
          message:
            'This transaction id was already used for a different transaction.',
        },
      };
    return {
      id: prior.id,
      status: prior.status,
      replayed: true,
      type: prior.type,
      ...((prior.result ?? {}) as Partial<TxnResult>),
      warnings: prior.warnings as Warning[],
      ...(prior.errorCode
        ? {
            error: { code: prior.errorCode, message: prior.errorMessage ?? '' },
          }
        : {}),
    };
  }

  /** Keeps a refused transaction (and its payload) for a manager. */
  private async fail(
    tenantId: string,
    device: Device,
    raw: Record<string, unknown> & { id: string; type: string },
    hash: string,
    error: { code: string; message: string },
    retry?: { reviewerId: string },
  ): Promise<TxnResult> {
    const type =
      raw.type === 'CASH_SESSION_OPEN' ? 'CASH_SESSION_OPEN' : 'SALE';
    const occurred = Date.parse(String(raw['occurredAt']));
    const cashier =
      typeof raw['cashierUserId'] === 'string' &&
      /^[0-9a-f-]{36}$/i.test(raw['cashierUserId'])
        ? raw['cashierUserId']
        : null;
    await this.prisma.withTenant(tenantId, async (tx) => {
      if (retry) {
        await tx.syncEvent.update({
          where: { tenantId_id: { tenantId, id: raw.id } },
          data: {
            attempts: { increment: 1 },
            errorCode: error.code,
            errorMessage: error.message,
          },
        });
        return;
      }
      const inserted = await tx.$executeRaw`
        INSERT INTO sync_events (tenant_id, id, device_id, store_id, counter_id, type, status,
                                 request_hash, payload, occurred_at, cashier_user_id,
                                 error_code, error_message, needs_review, processed_at)
        VALUES (${tenantId}::uuid, ${raw.id}::uuid, ${device.id}::uuid, ${device.storeId}::uuid,
                ${device.counterId}::uuid, ${type}::"SyncEventType", 'FAILED', ${hash},
                ${JSON.stringify(raw)}::jsonb,
                ${Number.isNaN(occurred) ? new Date() : new Date(occurred)},
                COALESCE(${cashier}::uuid, '00000000-0000-0000-0000-000000000000'::uuid),
                ${error.code}, ${error.message}, true, now())
        ON CONFLICT DO NOTHING`;
      if (inserted)
        await tx.outboxEvent.create({
          data: {
            tenantId,
            topic: 'sync.failed',
            payload: asJson({
              syncEventId: raw.id,
              deviceId: device.id,
              error,
            }),
          },
        });
    });
    return { id: raw.id, status: 'FAILED', type, warnings: [], error };
  }

  /* ---------- the transactions ---------- */

  /**
   * The cashier must have been signed in (PIN) on this device when it happened. If that session
   * had already been ended because they signed in on another computer (which this one, offline,
   * couldn't know), the transaction is still accepted — it happened — with a warning.
   */
  private async assertCashierOnDevice(
    tx: Tx,
    tenantId: string,
    device: Device,
    userId: string,
    at: Date,
  ): Promise<Warning | null> {
    const sessions = await tx.session.findMany({
      where: {
        tenantId,
        userId,
        deviceId: device.id,
        kind: 'PIN',
        createdAt: { lte: new Date(at.getTime() + CLOCK_GRACE_MS) },
        familyExpiresAt: { gte: new Date(at.getTime() - CLOCK_GRACE_MS) },
      },
      select: { revokedAt: true, revokedReason: true },
    });
    if (!sessions.length)
      throw forbidden(
        'CASHIER_NOT_SIGNED_IN',
        'That cashier was not signed in on this device at the time of the bill.',
      );
    const endedElsewhere = (s: (typeof sessions)[number]) =>
      s.revokedReason === 'PIN_ELSEWHERE' &&
      !!s.revokedAt &&
      s.revokedAt.getTime() + CLOCK_GRACE_MS < at.getTime();
    if (sessions.every(endedElsewhere))
      return {
        code: 'CASHIER_SIGNED_IN_ELSEWHERE',
        message:
          'Made after this cashier signed in on another computer (this one was offline and kept billing).',
      };
    return null;
  }

  private assertNotFuture(at: Date) {
    if (at.getTime() > Date.now() + CLOCK_GRACE_MS)
      throw unprocessable(
        'FUTURE_DATED',
        'The device clock is ahead: this is dated in the future. Fix the clock and re-run it.',
        'occurredAt',
      );
  }

  private async openDrawer(
    tx: Tx,
    tenantId: string,
    device: Device,
    t: CashSessionOpenTxn,
    meta: RequestMeta,
  ): Promise<Outcome> {
    const at = new Date(t.occurredAt);
    this.assertNotFuture(at);
    const elsewhere = await this.assertCashierOnDevice(
      tx,
      tenantId,
      device,
      t.cashierUserId,
      at,
    );
    const busy = await tx.cashSession.findFirst({
      where: {
        tenantId,
        status: 'OPEN',
        OR: [{ counterId: device.counterId }, { userId: t.cashierUserId }],
      },
    });
    if (busy)
      throw conflict(
        busy.counterId === device.counterId
          ? 'DRAWER_BUSY'
          : 'SESSION_ELSEWHERE',
        busy.counterId === device.counterId
          ? 'A drawer was already open on this counter — close it, then re-run this one.'
          : 'This cashier has a drawer open on another counter — close it, then re-run this one.',
      );
    const s = await tx.cashSession.create({
      data: {
        id: t.id,
        tenantId,
        storeId: device.storeId,
        counterId: device.counterId,
        userId: t.cashierUserId,
        openingFloat: t.openingFloat,
        openedAt: at,
        offline: true,
      },
    });
    await this.audit.record(
      {
        tenantId,
        actorUserId: t.cashierUserId,
        action: 'cash_session.opened_offline',
        entity: 'cash_session',
        entityId: s.id,
        data: { deviceId: device.id, openingFloat: t.openingFloat },
        meta,
      },
      tx,
    );
    return {
      result: { cashSessionId: s.id },
      cashSessionId: s.id,
      warnings: elsewhere ? [elsewhere] : [],
    };
  }

  private async recordSale(
    tx: Tx,
    tenantId: string,
    device: Device,
    t: OfflineSaleTxn,
    meta: RequestMeta,
    retry?: { renumber: boolean },
  ): Promise<Outcome> {
    const warnings: Warning[] = [];
    const at = new Date(t.occurredAt);
    this.assertNotFuture(at);
    const counter = await tx.counter.findFirstOrThrow({
      where: { id: device.counterId, tenantId },
      include: { store: true },
    });
    const store = counter.store;
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    const policy = await offlinePolicy(tx, tenantId);
    const elsewhere = await this.assertCashierOnDevice(
      tx,
      tenantId,
      device,
      t.cashierUserId,
      at,
    );
    if (elsewhere) warnings.push(elsewhere);

    // Already recorded under this id (e.g. the online request did reach the server).
    const dup = await tx.sale.findFirst({
      where: { tenantId, counterId: counter.id, clientRef: t.id },
      select: { id: true, invoiceNo: true },
    });
    if (dup) {
      if (dup.invoiceNo !== t.invoiceNo)
        warnings.push({
          code: 'RENUMBERED',
          message: `The receipt shows ${t.invoiceNo}; the bill is recorded as ${dup.invoiceNo}.`,
          printed: t.invoiceNo,
          recorded: dup.invoiceNo,
        });
      return {
        result: { saleId: dup.id, invoiceNo: dup.invoiceNo },
        saleId: dup.id,
        warnings,
      };
    }

    if (at.getTime() < Date.now() - policy.maxOfflineHours * 3_600_000)
      warnings.push({
        code: 'OFFLINE_TOO_LONG',
        message: `Billed more than ${policy.maxOfflineHours} h before it reached the server.`,
      });

    const businessDate = dateIn(at, store.timezone);
    const fy = fyOf(businessDate);
    const series = seriesOf(store.code, counter.number);

    // The invoice number: from a block reserved for this device, in the bill's financial year.
    let invoiceNo = t.invoiceNo;
    if (retry?.renumber) {
      invoiceNo = await nextDocumentNo(
        tx,
        tenantId,
        counter,
        todayIn(store.timezone),
        'INV',
      );
      warnings.push({
        code: 'RENUMBERED',
        message: `The receipt shows ${t.invoiceNo}; the bill is recorded as ${invoiceNo}.`,
        printed: t.invoiceNo,
        recorded: invoiceNo,
      });
    } else {
      const m = /^(.+)\/(\d{4})\/(\d{5})$/.exec(t.invoiceNo);
      const n = m ? Number(m[3]) : NaN;
      const block =
        m && m[1] === series && m[2] === fy
          ? await tx.invoiceBlock.findFirst({
              where: {
                tenantId,
                deviceId: device.id,
                counterId: counter.id,
                fy,
                fromSeq: { lte: n },
                toSeq: { gte: n },
              },
            })
          : null;
      if (!block)
        throw unprocessable(
          'NUMBER_NOT_RESERVED',
          `${t.invoiceNo} is not from a block of numbers reserved for this device in ${fy.slice(0, 2)}-${fy.slice(2)}.`,
          'invoiceNo',
        );
      if (
        await tx.sale.findFirst({
          where: { tenantId, invoiceNo: t.invoiceNo },
          select: { id: true },
        })
      )
        throw conflict(
          'NUMBER_IN_USE',
          `Another bill already has the number ${t.invoiceNo}.`,
        );
      await tx.$executeRaw`
        UPDATE invoice_blocks
        SET used_count = used_count + 1,
            highest_used = GREATEST(COALESCE(highest_used, 0), ${n}),
            closed_at = CASE WHEN GREATEST(COALESCE(highest_used, 0), ${n}) = to_seq THEN now() ELSE closed_at END
        WHERE id = ${block.id}::uuid`;
    }

    // The drawer the cash went into.
    let sessionId: string;
    if (t.cashSessionId) {
      const s = await tx.cashSession.findFirst({
        where: { id: t.cashSessionId, tenantId },
      });
      if (!s || s.counterId !== counter.id || s.userId !== t.cashierUserId)
        throw unprocessable(
          'UNKNOWN_DRAWER',
          'The drawer this bill was taken in is not recorded for this cashier and counter (did opening it fail?).',
          'cashSessionId',
        );
      if (s.status !== 'OPEN')
        warnings.push({
          code: 'DRAWER_CLOSED',
          message:
            'The drawer was closed before this bill arrived: its counted cash did not include it.',
          cashSessionId: s.id,
        });
      sessionId = s.id;
    } else {
      const s = await tx.cashSession.findFirst({
        where: {
          tenantId,
          counterId: counter.id,
          userId: t.cashierUserId,
          status: 'OPEN',
        },
      });
      if (!s)
        throw conflict(
          'NO_OPEN_SESSION',
          'The cashier has no drawer open on this counter for this bill.',
        );
      sessionId = s.id;
    }

    // Products, as billed. The device's price and tax are what the customer paid.
    const ids = [...new Set(t.lines.map((l) => l.productId))];
    const products = new Map(
      (
        await tx.product.findMany({
          where: { tenantId, id: { in: ids } },
          include: { unit: true, taxRate: true },
        })
      ).map((p) => [p.id, p]),
    );
    const chargeGst = t.documentType === 'TAX_INVOICE';
    if (chargeGst !== (tenant.registration === 'REGULAR'))
      warnings.push({
        code: 'REGISTRATION_CHANGED',
        message: `Issued as a ${chargeGst ? 'tax invoice' : 'bill of supply'}, but the business is now set up otherwise.`,
      });

    const buyerGstin = t.buyer?.gstin;
    if (buyerGstin) {
      const problem = gstinProblem(buyerGstin);
      if (problem) throw unprocessable('INVALID_GSTIN', problem, 'buyer.gstin');
    }
    const placeOfSupply = buyerGstin ? buyerGstin.slice(0, 2) : store.stateCode;
    const interState = chargeGst && placeOfSupply !== store.stateCode;

    const lines: PricedLine[] = t.lines.map((l, i) => {
      const f = `lines.${i}`;
      const p = products.get(l.productId);
      if (!p)
        throw unprocessable(
          'INVALID_REFERENCE',
          'Product not found.',
          `${f}.productId`,
        );
      const qty = new Decimal(l.qty);
      if (qty.decimalPlaces() > p.unit.decimals)
        throw unprocessable(
          'INVALID_QTY',
          `${p.name}: quantity has too many decimals.`,
          `${f}.qty`,
        );
      const unitPrice = new Decimal(l.unitPrice);
      const mrp = l.mrp
        ? new Decimal(l.mrp)
        : p.mrp && unitPrice.lte(p.mrp)
          ? p.mrp
          : null;
      if (mrp && unitPrice.gt(mrp))
        throw unprocessable(
          'PRICE_ABOVE_MRP',
          `${p.name}: billed above its MRP.`,
          `${f}.unitPrice`,
        );
      return {
        product: p,
        qty,
        unitPrice,
        priceSource: l.priceSource,
        mrp,
        gstRate: new Decimal(l.gstRate),
        cessRate: new Decimal(l.cessRate),
        discount: l.discount
          ? { kind: l.discount.kind, value: new Decimal(l.discount.value) }
          : null,
        batchId: l.batchId,
      };
    });

    const billDiscount: DiscountIn = t.billDiscount
      ? { kind: t.billDiscount.kind, value: new Decimal(t.billDiscount.value) }
      : null;
    const bill = computeBill(lines, billDiscount, { interState, chargeGst });
    if (!bill.payable.eq(t.payable))
      throw unprocessable(
        'PAYABLE_MISMATCH',
        `The device charged ₹${new Decimal(t.payable).toFixed(2)}, but its lines add up to ₹${bill.payable.toFixed(2)}.`,
        'payable',
      );
    const { tenders, change } = checkTenders(t.payments, bill.payable);

    // What would be different online today — for review, not refusal.
    const current = await storePrices(tx, tenantId, store.priceListId, [
      ...products.values(),
    ]);
    const changed: Record<string, unknown>[] = [];
    const taxChanged: Record<string, unknown>[] = [];
    lines.forEach((l, i) => {
      const p = l.product;
      const taxed = p.taxRate.kind === 'TAXABLE';
      const gst = taxed && chargeGst ? p.taxRate.rate : ZERO;
      const cess = taxed && chargeGst ? p.taxRate.cessRate : ZERO;
      if (!gst.eq(l.gstRate) || !cess.eq(l.cessRate))
        taxChanged.push({
          line: i + 1,
          productId: p.id,
          name: p.name,
          billed: Number(l.gstRate),
          now: Number(gst),
        });
      if (l.priceSource === 'OPEN_PRICE') return;
      const sp = new Decimal(current.get(p.id)!.sellingPrice);
      const now =
        p.priceIncludesTax || !chargeGst ? sp : inclusivePrice(sp, gst, cess);
      if (!now.eq(l.unitPrice))
        changed.push({
          line: i + 1,
          productId: p.id,
          name: p.name,
          billed: l.unitPrice.toFixed(2),
          now: now.toFixed(2),
        });
    });
    if (changed.length)
      warnings.push({
        code: 'PRICE_CHANGED',
        message: `Billed at the device's price; ${changed.length} item(s) now cost differently.`,
        lines: changed,
      });
    if (taxChanged.length)
      warnings.push({
        code: 'TAX_CHANGED',
        message: `Billed with the device's GST rate; ${taxChanged.length} item(s) are taxed differently now.`,
        lines: taxChanged,
      });
    const inactive = lines.filter((l) => l.product.status !== 'ACTIVE');
    if (inactive.length)
      warnings.push({
        code: 'PRODUCT_INACTIVE',
        message: `${inactive.map((l) => l.product.name).join(', ')} had been archived.`,
      });

    // Discounts above the limit: a manager's PIN can't be checked offline.
    const limits = await salesLimits(tx, tenantId);
    const pct = (part: Decimal, whole: Decimal) =>
      whole.gt(0) ? part.times(100).dividedBy(whole) : ZERO;
    const maxLine = bill.rows.reduce(
      (m, r) => Decimal.max(m, pct(r.lineDiscount, r.gross)),
      ZERO,
    );
    const overall = pct(bill.lineDiscounts.plus(bill.billDiscount), bill.gross);
    if (Decimal.max(maxLine, overall).gt(limits.discountPct))
      warnings.push({
        code: 'DISCOUNT_ABOVE_LIMIT',
        message: `A discount above ${limits.discountPct.toFixed(0)}% was given offline, without a manager's approval.`,
        pct: Number(Decimal.max(maxLine, overall).toFixed(2)),
      });

    const { sale, movements } = await this.sales.record(tx, {
      tenantId,
      tenant,
      store,
      counter,
      cashSessionId: sessionId,
      cashierUserId: t.cashierUserId,
      chargeGst,
      interState,
      placeOfSupply,
      lines,
      bill,
      billDiscount,
      discountApprovedBy: null,
      buyer: t.buyer,
      tenders,
      change,
      invoiceNo,
      businessDate,
      issuedAt: at,
      clientRef: t.id,
      offlineDeviceId: device.id,
      auditAction: 'sale.synced_offline',
      meta,
    });

    const below = movements.filter((m) => m.negative);
    if (below.length) {
      const name = new Map(lines.map((l) => [l.product.id, l.product.name]));
      const items = [
        ...new Map(below.map((m) => [m.productId, m])).values(),
      ].map((m) => ({
        productId: m.productId,
        name: name.get(m.productId),
        balanceAfter: m.balanceAfter.toFixed(3),
      }));
      warnings.push({
        code: 'NEGATIVE_STOCK',
        message: `Stock went below zero for ${items.map((x) => x.name).join(', ')} — count it or check for missing receipts.`,
        items,
      });
      await tx.outboxEvent.create({
        data: {
          tenantId,
          topic: 'stock.negative',
          payload: asJson({ storeId: store.id, saleId: sale.id, items }),
        },
      });
    }

    return {
      result: {
        saleId: sale.id,
        invoiceNo: sale.invoiceNo,
        payable: sale.payable.toFixed(2),
        paymentStatus: sale.paymentStatus,
      },
      saleId: sale.id,
      warnings,
    };
  }
}
