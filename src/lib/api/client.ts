/**
 * The one place the frontend talks to the backend API.
 *
 * - Base URL: NEXT_PUBLIC_API_URL (e.g. http://localhost:4000/api/v1). Unset → the app runs on
 *   this computer's own data (demo / standalone), exactly as before.
 * - Access token: kept in memory only (never in storage). The refresh token is the API's
 *   httpOnly cookie, which page scripts can't read; on a 401 the client refreshes once (shared by
 *   concurrent calls) and retries. If that fails the session has ended → `onSessionEnded`.
 * - Errors: every failure becomes an `ApiError` with the API's `code`, `message`, field `details`
 *   and `requestId` (shown to support), or code NETWORK when the server can't be reached.
 */
import type { paths } from './schema';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');

/** true when this build talks to a backend. */
export const apiConfigured = API_URL !== '';

export type ApiErrorDetail = { field?: string; issue: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ApiErrorDetail[] = [],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field → message, for forms. */
  fieldErrors(): Record<string, string> {
    return Object.fromEntries(this.details.filter((d) => d.field).map((d) => [d.field!, d.issue]));
  }
}

/** A user-facing sentence for any error. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'NETWORK') return 'Can’t reach the server. Check the internet connection and try again.';
    if (e.code === 'VALIDATION_FAILED' && e.details.length)
      return e.details.map((d) => (d.field ? `${d.field}: ${d.issue}` : d.issue)).join(' · ');
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}

/* ---------- tokens ---------- */

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

/**
 * Native clients (the desktop POS, and tests) can't rely on the browser's cookie jar: they send
 * `X-Client: native` and keep the refresh token themselves (here in memory; the desktop shell will
 * keep it in the OS keychain in Phase 9).
 */
let native = false;
let refreshToken: string | null = null;
export function enableNativeTokens(on = true) {
  native = on;
}
export const isNativeClient = () => native;
/** Where a native client keeps its refresh token between restarts (the desktop app: OS-encrypted). */
type TokenVault = { get(): Promise<string | null>; set(t: string | null): Promise<void> };
let vault: TokenVault | null = null;
export const setRefreshToken = (t: string | null) => {
  refreshToken = t;
  void vault?.set(t).catch(() => undefined);
};

// The desktop app runs from kirana://pos, a different site from the API, so the refresh cookie
// (SameSite=Strict) is never sent: it uses native tokens instead, kept encrypted by the OS
// (Electron safeStorage) so a restart — even offline — doesn't sign the cashier out.
const desktop = typeof window !== 'undefined' ? window.posDesktop : undefined;
if (desktop?.isDesktop) {
  native = true;
  if (desktop.secureGet && desktop.secureSet)
    vault = {
      get: () => desktop.secureGet!('refreshToken'),
      set: async (t) => {
        await desktop.secureSet!('refreshToken', t);
      },
    };
}
const endedListeners = new Set<() => void>();

/* ---------- connectivity ---------- */

/** Why the last refresh failed: the server said no (`auth`), or it couldn't be reached (`network`). */
export let lastRefreshFailure: 'auth' | 'network' | null = null;
let reachable = true;
const connectivityListeners = new Set<(online: boolean) => void>();
/** false after a request couldn't reach the server, true again after one could. */
export const isReachable = () => reachable;
export function onConnectivity(fn: (online: boolean) => void) {
  connectivityListeners.add(fn);
  return () => connectivityListeners.delete(fn);
}
function setReachable(v: boolean) {
  if (v === reachable) return;
  reachable = v;
  connectivityListeners.forEach((l) => l(v));
}

/**
 * Offline POS: GET responses are kept (in IndexedDB) and served when the server can't be reached,
 * so a registered counter can start and bill without a connection. Off unless installed.
 */
export type ReadCache = { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };
let readCache: ReadCache | null = null;
export const setReadCache = (c: ReadCache | null) => {
  readCache = c;
};

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const hasAccessToken = () => !!accessToken;

/** Called once when the server says the session is over (signed out elsewhere, expired, revoked). */
export function onSessionEnded(fn: () => void) {
  endedListeners.add(fn);
  return () => endedListeners.delete(fn);
}

/** Gets a new access token with the refresh cookie. Concurrent callers share one request. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      if (native && !refreshToken && vault) refreshToken = await vault.get().catch(() => null);
      if (native && !refreshToken) {
        lastRefreshFailure = 'auth';
        return false;
      }
      let res: Response;
      try {
        res = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', ...(native ? { 'x-client': 'native' } : {}) },
          body: JSON.stringify(native ? { refreshToken } : {}),
        });
      } catch {
        lastRefreshFailure = 'network';
        setReachable(false);
        return false;
      }
      setReachable(true);
      if (!res.ok) {
        lastRefreshFailure = res.status >= 500 ? 'network' : 'auth';
        return false;
      }
      const body = (await res.json()) as { accessToken?: string; refreshToken?: string };
      accessToken = body.accessToken ?? null;
      if (native) setRefreshToken(body.refreshToken ?? null);
      lastRefreshFailure = accessToken ? null : 'auth';
      return !!accessToken;
    } catch {
      lastRefreshFailure = 'network';
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

/* ---------- requests ---------- */

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RequestOptions = {
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Required by the API on sales, receipts, payments and stock changes; reuse it when retrying. */
  idempotencyKey?: string;
  /** multipart upload */
  form?: FormData;
  signal?: AbortSignal;
  /** Return the raw text (CSV, HTML) instead of JSON. */
  text?: boolean;
  /** Return the raw bytes (images) instead of JSON. */
  blob?: boolean;
};

/** Typed request body of an endpoint, from the OpenAPI document. */
export type RequestBody<P extends keyof paths, M extends 'post' | 'put' | 'patch'> = paths[P][M] extends {
  requestBody?: { content: { 'application/json': infer B } };
}
  ? B
  : never;

async function send(method: Method, path: string, o: RequestOptions): Promise<Response> {
  const url = new URL(`${API_URL}${path}`);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {};
  if (accessToken) headers['authorization'] = `Bearer ${accessToken}`;
  if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
  if (native) headers['x-client'] = 'native';
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      body: o.form ?? (o.body !== undefined ? JSON.stringify(o.body) : null),
      signal: o.signal ?? null,
    });
    setReachable(res.status !== 502 && res.status !== 503 && res.status !== 504);
    return res;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    setReachable(false);
    throw new ApiError(0, 'NETWORK', 'Can’t reach the server.');
  }
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const b = (await res.json()) as { error?: { code?: string; message?: string; details?: ApiErrorDetail[]; requestId?: string } };
    return new ApiError(res.status, b.error?.code ?? 'ERROR', b.error?.message ?? res.statusText, b.error?.details ?? [], b.error?.requestId);
  } catch {
    return new ApiError(res.status, 'ERROR', res.statusText || 'Request failed');
  }
}

export async function api<T>(method: Method, path: string, o: RequestOptions = {}): Promise<T> {
  let res = await send(method, path, o);
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/pin-login')) {
    if (await refreshSession()) res = await send(method, path, o);
    if (res.status === 401) {
      accessToken = null;
      endedListeners.forEach((l) => l());
    }
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (o.blob ? await res.blob() : o.text ? await res.text() : await res.json()) as T;
}

export async function get<T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal): Promise<T> {
  const o = { ...(query ? { query } : {}), ...(signal ? { signal } : {}) };
  if (!readCache) return api<T>('GET', path, o);
  const key = `${path}?${new URLSearchParams(Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString()}`;
  try {
    const value = await api<T>('GET', path, o);
    void readCache.put(key, value).catch(() => undefined);
    return value;
  } catch (e) {
    if (!(e instanceof ApiError) || (e.code !== 'NETWORK' && e.status < 500)) throw e;
    const cached = await readCache.get(key).catch(() => undefined);
    if (cached === undefined) throw e;
    return cached as T;
  }
}

/** A fresh idempotency key for one user action (keep it across retries of that action). */
export const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
