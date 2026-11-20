/**
 * The offline queue and its synchronisation with the server (POST /sync/batch).
 *
 *  - Transactions are written here before the cashier sees the bill as done, and leave only when
 *    the server has answered for them — so a closed tab, a crash or a restart loses nothing.
 *  - They are sent in the order they happened (a drawer opening before its bills), in batches.
 *  - Each has its own UUID, which the server uses as its idempotency key: sending one again — after
 *    a lost response, from two tabs at once, after a restart — never records it twice.
 *  - No answer (offline, server busy): the whole batch waits with exponential backoff and full
 *    jitter (2 s doubling to 5 min, randomised so a shop's counters don't retry in lockstep).
 *  - ACCEPTED → synced. FAILED → kept here as failed, shown to the operator, not sent again; a
 *    manager re-runs or discards it on the server. RETRY → that one waits and is sent again.
 */
import { useSyncExternalStore } from 'react';
import { api, ApiError, refreshSession } from '@/lib/api/client';
import { markOnline } from './cache';
import { posDb, type OutboxRow, type SyncError, type SyncWarning } from './db';

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 5 * 60_000;
const BATCH = 25;
const KEEP_SYNCED_MS = 7 * 86_400_000;

/** Full jitter: a random wait between 0 and min(cap, base·2^attempt). */
export const backoffMs = (
  attempt: number,
  random: () => number = Math.random
) =>
  Math.round(
    random() *
      Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1))
  );

type Result = {
  id: string;
  status: 'ACCEPTED' | 'FAILED' | 'DISCARDED' | 'RETRY';
  saleId?: string;
  invoiceNo?: string;
  warnings: SyncWarning[];
  error?: SyncError;
};

/* ---------- status (for the POS header and settings) ---------- */

export type SyncStatus = {
  online: boolean;
  pending: number;
  failed: number;
  oldestPendingAt: string | null;
  lastSyncAt: string | null;
  /** The cashier's session ended: the queue waits until someone signs in at this counter. */
  needsSignIn: boolean;
  syncing: boolean;
  lastError: string | null;
};

let status: SyncStatus = {
  online: true,
  pending: 0,
  failed: 0,
  oldestPendingAt: null,
  lastSyncAt: null,
  needsSignIn: false,
  syncing: false,
  lastError: null,
};
const listeners = new Set<() => void>();
const publish = (patch: Partial<SyncStatus>) => {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
};
export const getSyncStatus = () => status;
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
    () => status
  );
}
export const setOnline = (online: boolean) => publish({ online });

export async function refreshCounts() {
  const db = posDb();
  const [pending, failed, oldest] = await Promise.all([
    db.outbox.where('status').equals('pending').count(),
    db.outbox.where('status').equals('failed').count(),
    db.outbox.where('status').equals('pending').sortBy('seq'),
  ]);
  publish({ pending, failed, oldestPendingAt: oldest[0]?.createdAt ?? null });
  return { pending, failed };
}

/** The operator's view of the queue: what hasn't reached the server, and what it refused. */
export const queueRows = () =>
  posDb().outbox.where('status').anyOf('pending', 'failed').sortBy('seq');

/* ---------- enqueue ---------- */

export function newRow(
  type: OutboxRow['type'],
  id: string,
  payload: Record<string, unknown>,
  label: string
): OutboxRow {
  return {
    id,
    type,
    payload,
    status: 'pending',
    createdAt: new Date().toISOString(),
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    result: null,
    syncedAt: null,
    label,
  };
}

/* ---------- flush ---------- */

let running: Promise<FlushResult> | null = null;
export type FlushResult = {
  sent: number;
  accepted: number;
  failed: number;
  waiting: number;
  offline: boolean;
};

/** Sends what is due, in order. One run at a time per tab; Web Locks keep two tabs from sending together. */
export function flush(opts: { force?: boolean } = {}): Promise<FlushResult> {
  // A forced run ("Sync now", reconnect) doesn't settle for a run already under way — which may
  // have started offline, or be waiting out a backoff: it runs again right after it.
  if (running && opts.force)
    return running.then(
      () => flush(opts),
      () => flush(opts)
    );
  running ??= (async () => {
    try {
      const work = () => run(opts.force ?? false);
      const locks =
        typeof navigator !== 'undefined'
          ? (navigator as Navigator & { locks?: LockManager }).locks
          : undefined;
      return locks
        ? await locks.request('kirana-pos-sync', work)
        : await work();
    } finally {
      running = null;
    }
  })();
  return running;
}

async function run(force: boolean): Promise<FlushResult> {
  const db = posDb();
  const out: FlushResult = {
    sent: 0,
    accepted: 0,
    failed: 0,
    waiting: 0,
    offline: false,
  };
  publish({ syncing: true });
  try {
    for (let round = 0; round < 40; round++) {
      const rows = (
        await db.outbox.where('status').equals('pending').sortBy('seq')
      ).slice(0, BATCH);
      if (!rows.length) break;
      // In order: if the oldest is waiting out its backoff, everything behind it waits too.
      if (!force && rows[0]!.nextAttemptAt > Date.now()) {
        out.waiting = rows.length;
        break;
      }
      const counts = await refreshCounts();
      let results: Result[];
      try {
        results = await send(rows, counts);
      } catch (e) {
        const offline =
          e instanceof ApiError &&
          (e.code === 'NETWORK' || e.status >= 500 || e.status === 429);
        if (e instanceof ApiError && e.status === 401) {
          publish({
            needsSignIn: true,
            lastError: 'Sign in at this counter to send the waiting bills.',
          });
          break;
        }
        if (!offline) {
          // The server refused the whole batch (a bug, never a business rule): keep the bills, don't loop.
          const err = {
            code: e instanceof ApiError ? e.code : 'ERROR',
            message: e instanceof Error ? e.message : 'Upload refused',
          };
          await db.outbox.bulkUpdate(
            rows.map((r) => ({
              key: r.seq!,
              changes: { status: 'failed', lastError: err },
            }))
          );
          out.failed += rows.length;
          publish({ lastError: err.message });
          break;
        }
        await delay(db, rows);
        out.offline = true;
        publish({
          online: false,
          lastError:
            'Server unreachable — bills are kept on this computer and sent when it’s back.',
        });
        break;
      }
      publish({
        online: true,
        needsSignIn: false,
        lastError: null,
        lastSyncAt: new Date().toISOString(),
      });
      await markOnline();
      out.sent += rows.length;
      const byId = new Map(results.map((r) => [r.id, r]));
      const retry: OutboxRow[] = [];
      await db.transaction('rw', db.outbox, async () => {
        for (const row of rows) {
          const r = byId.get(row.id);
          if (!r || r.status === 'RETRY') {
            retry.push(row);
            continue;
          }
          if (r.status === 'ACCEPTED') {
            out.accepted++;
            await db.outbox.update(row.seq!, {
              status: 'synced',
              syncedAt: new Date().toISOString(),
              lastError: null,
              result: {
                ...(r.saleId ? { saleId: r.saleId } : {}),
                ...(r.invoiceNo ? { invoiceNo: r.invoiceNo } : {}),
                warnings: r.warnings,
              },
            });
          } else {
            out.failed++;
            await db.outbox.update(row.seq!, {
              status: r.status === 'DISCARDED' ? 'discarded' : 'failed',
              lastError: r.error ?? {
                code: 'FAILED',
                message: 'Refused by the server.',
              },
            });
          }
        }
      });
      if (retry.length) {
        await delay(db, retry);
        break;
      }
    }
    await db.outbox
      .where('status')
      .anyOf('synced', 'discarded')
      .filter(
        (r) =>
          !!r.syncedAt && Date.parse(r.syncedAt) < Date.now() - KEEP_SYNCED_MS
      )
      .delete();
  } finally {
    await refreshCounts();
    publish({ syncing: false });
  }
  return out;
}

async function delay(db: ReturnType<typeof posDb>, rows: OutboxRow[]) {
  await db.outbox.bulkUpdate(
    rows.map((r) => ({
      key: r.seq!,
      changes: {
        attempts: r.attempts + 1,
        nextAttemptAt: Date.now() + backoffMs(r.attempts + 1),
      },
    }))
  );
}

async function send(
  rows: OutboxRow[],
  counts: { pending: number; failed: number }
): Promise<Result[]> {
  const body = {
    deviceTime: new Date().toISOString(),
    queue: {
      pending: counts.pending,
      failed: counts.failed,
      ...(rows[0] ? { oldestAt: rows[0].createdAt } : {}),
    },
    transactions: rows.map((r) => r.payload),
  };
  try {
    return (await api<{ results: Result[] }>('POST', '/sync/batch', { body }))
      .results;
  } catch (e) {
    // The access token expired while offline: refresh once and resend.
    if (e instanceof ApiError && e.status === 401 && (await refreshSession()))
      return (await api<{ results: Result[] }>('POST', '/sync/batch', { body }))
        .results;
    throw e;
  }
}

/** An empty batch: tells the server this device's queue (monitoring), and checks the connection. */
export async function heartbeat() {
  const counts = await refreshCounts();
  const oldest = status.oldestPendingAt;
  await api('POST', '/sync/batch', {
    body: {
      deviceTime: new Date().toISOString(),
      queue: { ...counts, ...(oldest ? { oldestAt: oldest } : {}) },
      transactions: [],
    },
  });
  await markOnline();
  publish({ online: true });
}

/** Sends a failed row again now (e.g. after a manager fixed the cause and it should be re-checked). */
export async function resend(seq: number) {
  await posDb().outbox.update(seq, { status: 'pending', nextAttemptAt: 0 });
  await refreshCounts();
  return flush({ force: true });
}
