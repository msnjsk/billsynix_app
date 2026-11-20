/**
 * Signing in against the backend (when NEXT_PUBLIC_API_URL is set).
 *
 * The UI keeps using the `Session` from `@/lib/auth` (name, role, counter) — here it is built from
 * the API's `/auth/me`. Backend roles map onto the three UI roles (owner / manager / cashier) for
 * navigation; what someone may actually *do* is decided by the API on every request — hiding a
 * button here is a convenience, never the security boundary (`can()` mirrors the permissions only
 * so the UI doesn't offer what will be refused).
 */
import { useSyncExternalStore } from 'react';
import { api, apiConfigured, errorMessage, lastRefreshFailure, onSessionEnded, refreshSession, setAccessToken, setRefreshToken } from '@/lib/api/client';
import type { LoginResult, Me } from '@/lib/api/types';
import { onSignOut, setLiveSession, type Role, type Session } from '@/lib/auth';
import { cachedMe, forgetCashier, startOffline, stopOffline } from '../offline/engine';
import { pinSignIn } from '../offline/device';
import { scopeLocalData } from '../pos/store';

export const isLive = () => apiConfigured;

/** Resolves when the server has ended the session after signOut() (tests wait on it). */
export let lastSignOut: Promise<void> = Promise.resolve();

/* ---------- status ---------- */

export type LiveStatus =
  | { state: 'restoring' }
  | { state: 'signedOut' }
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'error'; message: string };

let status: LiveStatus = { state: 'restoring' };
const listeners = new Set<() => void>();
const setStatus = (s: LiveStatus) => {
  status = s;
  listeners.forEach((l) => l());
};
export const getLiveStatus = () => status;
export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
    () => status,
  );
}

/* ---------- who is signed in ---------- */

let me: Me | null = null;
let permissions = new Set<string>();
export const currentMe = () => me;

/** Mirrors an API permission for showing/hiding UI. The API still checks every request. */
export const can = (permission: string) => !isLive() || permissions.has(permission);

export function roleOf(roles: string[]): Role {
  if (roles.includes('owner') || roles.includes('business_admin')) return 'owner';
  if (roles.includes('branch_manager') || roles.includes('inventory_manager')) return 'manager';
  return 'cashier';
}

function toSession(m: Me): Session {
  const now = new Date();
  return {
    userId: m.user.id,
    name: m.user.name,
    role: roleOf(m.membership.roles),
    counter: null,
    method: m.session.kind === 'PIN' ? 'pin' : 'password',
    signedInAt: now.toISOString(),
    // The API decides when the session ends; this is just far enough ahead for the UI.
    expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
  };
}

/** Data loaders register here (see hydrate.ts) to avoid an import cycle. */
let loader: (() => Promise<void>) | null = null;
export const registerLoader = (fn: () => Promise<void>) => {
  loader = fn;
};

/** true while a registered counter runs on its own data because the server can't be reached. */
let offlineStart = false;
export const startedOffline = () => offlineStart;

async function enter(cached?: Me): Promise<void> {
  me = cached ?? (await api<Me>('GET', '/auth/me'));
  // Saved counter data from another business (or the sample store) never shows up here.
  scopeLocalData(me.tenant.id);
  offlineStart = !!cached;
  permissions = new Set(me.membership.permissions);
  setLiveSession(toSession(me));
  // A cashier on a registered counter: keep what's needed to bill offline (Phase 9).
  if (me.session.device) await startOffline(me);
  setStatus({ state: 'loading' });
  try {
    await loader?.();
    setStatus({ state: 'ready' });
  } catch (e) {
    setStatus({ state: 'error', message: errorMessage(e) });
  }
}

/**
 * On page load: continue the session from the refresh cookie (or, in the desktop app, the
 * OS-encrypted refresh token). If the server can't be reached, a registered counter reopens with
 * the cashier who was signed in — until their shift session ends — on the data it kept.
 */
let booted = false;
export async function bootLive() {
  if (!isLive() || booted) return;
  booted = true;
  if (!(await refreshSession())) {
    const offline = lastRefreshFailure === 'network' ? await cachedMe().catch(() => null) : null;
    if (offline) return enter(offline);
    return setStatus({ state: 'signedOut' });
  }
  try {
    await enter();
  } catch {
    setStatus({ state: 'signedOut' });
  }
}

/** Cashier PIN sign-in on this registered counter. */
export async function livePinSignIn(membershipId: string, pin: string): Promise<LiveSignIn> {
  try {
    await pinSignIn(membershipId, pin);
    booted = true;
    await enter();
    return { ok: true, session: toSession(me!) };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function retryLoad() {
  setStatus({ state: 'loading' });
  try {
    await loader?.();
    setStatus({ state: 'ready' });
  } catch (e) {
    setStatus({ state: 'error', message: errorMessage(e) });
  }
}

export type LiveSignIn =
  | { ok: true; session: Session }
  | { ok: false; error: string }
  | { ok: false; chooseBusiness: { id: string; displayName: string }[] };

export async function liveSignIn(email: string, password: string, tenantId?: string): Promise<LiveSignIn> {
  try {
    const r = await api<LoginResult>('POST', '/auth/login', { body: { email: email.trim().toLowerCase(), password, ...(tenantId ? { tenantId } : {}) } });
    if (r.status === 'SELECT_TENANT') return { ok: false, chooseBusiness: r.tenants };
    setAccessToken(r.accessToken);
    if ('refreshToken' in r) setRefreshToken((r as { refreshToken?: string }).refreshToken ?? null);
    booted = true;
    await enter();
    const s = toSession(me!);
    return { ok: true, session: s };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

function signedOut() {
  me = null;
  permissions = new Set();
  offlineStart = false;
  setAccessToken(null);
  setRefreshToken(null);
  // Unsent bills stay in the outbox; the next cashier's session sends them.
  stopOffline();
  void forgetCashier().catch(() => undefined);
  setStatus({ state: 'signedOut' });
}

if (typeof window !== 'undefined' && apiConfigured) {
  // signOut() in the UI → end the session on the server too.
  onSignOut(() => {
    const done = api('POST', '/auth/logout').catch(() => undefined);
    lastSignOut = done.then(() => undefined);
    signedOut();
  });
  // The server ended the session (expired, revoked, signed out elsewhere).
  onSessionEnded(() => {
    setLiveSession(null);
    signedOut();
  });
}
