/**
 * This computer as a registered POS counter (Phase 9).
 *
 * A manager registers the computer once (POST /counters/:id/devices); the API returns a device key
 * that is shown only once. It is kept on the computer — encrypted by the OS in the desktop app,
 * in the POS database in a browser — and lets cashiers sign in with their PIN at this counter.
 */
import {
  api,
  API_URL,
  ApiError,
  isNativeClient,
  setAccessToken,
  setRefreshToken,
} from '@/lib/api/client';
import { closePosDb, kvGet, kvSet, posDb } from './db';

export type DeviceInfo = {
  device: { id: string; name: string };
  counter: { id: string; number: number; name: string };
  store: { id: string; code: string; name: string };
  cashiers: { membershipId: string; name: string }[];
};

const desktop = () =>
  typeof window !== 'undefined' ? window.posDesktop : undefined;

export async function getDeviceKey(): Promise<string | null> {
  const d = desktop();
  if (d?.secureGet) return d.secureGet('deviceKey');
  return (await kvGet<string>('deviceKey')) ?? null;
}

async function setDeviceKey(key: string | null) {
  const d = desktop();
  if (d?.secureSet) await d.secureSet('deviceKey', key);
  else await kvSet('deviceKey', key);
}

/** Registers this computer as a counter's POS (needs `devices:register`). */
export async function registerThisDevice(counterId: string, name: string) {
  if (await hasUnsentWork())
    throw new Error(
      'This computer still has bills that have not reached the server. Sync them first.'
    );
  const r = await api<{ device: { id: string }; deviceKey: string }>(
    'POST',
    `/counters/${counterId}/devices`,
    { body: { name } }
  );
  await forgetLocalData();
  await setDeviceKey(r.deviceKey);
  return r.device;
}

/** Stops using this computer as a counter (the key is removed here; revoke it on the server too). */
export async function forgetThisDevice() {
  if (await hasUnsentWork())
    throw new Error(
      'This computer still has bills that have not reached the server. Sync them first.'
    );
  await setDeviceKey(null);
  await forgetLocalData();
}

async function hasUnsentWork() {
  return (
    (await posDb().outbox.where('status').anyOf('pending', 'failed').count()) >
    0
  );
}

/** Drops cached business data (catalogue, config, reads) — never unsent bills. */
async function forgetLocalData() {
  const db = posDb();
  await db.transaction('rw', db.products, db.kv, db.reads, async () => {
    await db.products.clear();
    await db.reads.clear();
    const keep = await db.kv.get('deviceKey');
    await db.kv.clear();
    if (keep) await db.kv.put(keep);
  });
}

async function deviceCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = await getDeviceKey();
  if (!key)
    throw new ApiError(
      401,
      'DEVICE_NOT_REGISTERED',
      'This computer is not registered as a counter.'
    );
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-device-key': key,
        ...(isNativeClient() ? { 'x-client': 'native' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Can’t reach the server.');
  }
  const body = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  } & T;
  if (!res.ok)
    throw new ApiError(
      res.status,
      body.error?.code ?? 'ERROR',
      body.error?.message ?? res.statusText
    );
  return body;
}

/** The counter and the cashiers who may sign in on it (cached for showing names offline). */
export async function deviceInfo(): Promise<DeviceInfo | null> {
  if (!(await getDeviceKey())) return null;
  try {
    const info = await deviceCall<DeviceInfo>('/auth/device/cashiers');
    await kvSet('deviceInfo', info);
    return info;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'NETWORK')
      return (await kvGet<DeviceInfo>('deviceInfo')) ?? null;
    if (e instanceof ApiError && e.status === 401) {
      // Revoked, or registered with a server that no longer knows this computer (e.g. after a
      // reset). Forget the key so the sign-in screen offers to register it again — unless bills
      // made here are still waiting to reach the server.
      if (!(await hasUnsentWork())) {
        await setDeviceKey(null);
        await kvSet('deviceInfo', null);
      }
      return null;
    }
    throw e;
  }
}

/** Cashier PIN sign-in on this counter. Returns the access token (also installed in the API client). */
export async function pinSignIn(membershipId: string, pin: string) {
  const r = await deviceCall<{ accessToken: string; refreshToken?: string }>(
    '/auth/pin-login',
    {
      method: 'POST',
      body: JSON.stringify({ membershipId, pin }),
    }
  );
  setAccessToken(r.accessToken);
  if (r.refreshToken) setRefreshToken(r.refreshToken);
  return r.accessToken;
}

export { closePosDb };
