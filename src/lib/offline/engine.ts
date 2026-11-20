/**
 * Runs the offline POS on a registered counter: installs the read cache, keeps the catalogue,
 * stock, config and invoice-number blocks fresh while online, sends the outbox (now, on
 * reconnect, every 20 s while bills wait), reports the queue every few minutes, and re-checks
 * refused bills so a manager's decision on the server reaches this counter.
 *
 * Only for cashier PIN sessions on a registered device (`me.session.device`). Other sessions
 * (a manager in a browser) keep nothing on the computer and need the server.
 */
import { isReachable, onConnectivity, setReadCache } from '@/lib/api/client';
import type { Me } from '@/lib/api/types';
import { posDb, kvGet, kvSet } from './db';
import { getConfig, prime } from './cache';
import { flush, heartbeat, refreshCounts, setOnline } from './outbox';

const TICK_MS = 20_000;
const PRIME_MS = 5 * 60_000;
const RECHECK_FAILED_MS = 15 * 60_000;

let active: {
  me: Me;
  timer: ReturnType<typeof setInterval>;
  stop: () => void;
} | null = null;
let lastPrime = 0;
let lastRecheck = 0;
let ticking: Promise<void> | null = null;

export const offlineActive = () => !!active;

/** Starts offline support for a device session (idempotent). */
export async function startOffline(me: Me) {
  if (!me.session.device || typeof window === 'undefined') return;
  if (active) {
    active.me = me;
    return;
  }
  setReadCache({
    get: async (key) => (await posDb().reads.get(key))?.value,
    put: async (key, value) => {
      await posDb().reads.put({ key, value, at: new Date().toISOString() });
    },
  });
  // Remembered so the counter can reopen offline with this cashier still signed in.
  await kvSet('me', me);
  const offConn = onConnectivity((online) => {
    setOnline(online);
    if (online) void tick(true);
  });
  const onOnline = () => void tick(true);
  window.addEventListener('online', onOnline);
  const timer = setInterval(() => void tick(), TICK_MS);
  active = {
    me,
    timer,
    stop: () => {
      clearInterval(timer);
      offConn();
      window.removeEventListener('online', onOnline);
    },
  };
  await refreshCounts();
  void tick(true);
}

export function stopOffline() {
  active?.stop();
  active = null;
  setReadCache(null);
}

/** The cashier last signed in here, if their shift session hasn't ended — for starting offline. */
export async function cachedMe(): Promise<Me | null> {
  const [me, cfg] = await Promise.all([kvGet<Me>('me'), getConfig()]);
  if (!me?.session.device || !cfg) return null;
  if (
    cfg.cashier.id !== me.user.id ||
    Date.parse(cfg.cashier.sessionEndsAt) <= Date.now()
  )
    return null;
  return me;
}

/** Forget the signed-in cashier on this computer (sign-out). Unsent bills stay. */
export const forgetCashier = () => kvSet('me', null);

function tick(urgent = false): Promise<void> {
  ticking ??= (async () => {
    try {
      const now = Date.now();
      const { pending, failed } = await refreshCounts();
      if (pending) await flush({ force: urgent });
      if (urgent || now - lastPrime > PRIME_MS) {
        lastPrime = now;
        await prime();
        await heartbeat();
      }
      if (failed && now - lastRecheck > RECHECK_FAILED_MS) {
        lastRecheck = now;
        // Answered from the server's record: picks up a manager's re-run or discard.
        await posDb()
          .outbox.where('status')
          .equals('failed')
          .modify({ status: 'pending', nextAttemptAt: 0 });
        await flush({ force: true });
      }
    } catch {
      setOnline(isReachable());
    } finally {
      ticking = null;
    }
  })();
  return ticking;
}

/** Sync now (the "Sync now" button, and before an online sale when bills are waiting). */
export const syncNow = () => tick(true);
