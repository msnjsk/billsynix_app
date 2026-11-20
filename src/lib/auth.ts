/**
 * Sign-in for the front end (no server yet).
 *
 * Accounts are created in the first-run setup (/setup) and stored on this computer with salted,
 * iterated SHA-256 hashes — the plain password / PIN is never stored. Sessions live in browser storage.
 *
 * ⚠ This decides what each person sees (owner → dashboard, cashier → POS), but it is not server-grade
 * security: anyone with access to this computer's browser storage can copy the hashes, and a 4-digit
 * PIN is easy to guess offline. Move accounts and sessions to a real auth API before going multi-store.
 */
import { useSyncExternalStore } from 'react';
import { sha256Hex } from '@/lib/sha256';
import { apiConfigured } from '@/lib/api/client';

export type Role = 'owner' | 'manager' | 'cashier';

export type StoredAccount = {
  id: string;
  name: string;
  role: Role;
  phone: string;
  email: string;
  counter?: string | undefined;
  salt: string;
  passwordHash: string;
  pinHash?: string | undefined;
};

/** What setup (or the demo) provides to create an account. */
export type NewAccount = {
  name: string;
  role: Role;
  phone: string;
  email: string;
  counter?: string | undefined;
  /** Optional for PIN-only cashiers. */
  password?: string | undefined;
  pin?: string | undefined;
};

/** Built-in accounts used only in "Explore with demo data" mode (shown on the login page). */
export const demoAccounts: (NewAccount & { id: string; password: string })[] = [
  { id: 'owner', name: 'Senthil Kumar', role: 'owner', phone: '9840012345', email: 'owner@billsynix.app', password: 'owner@123' },
  { id: 'manager', name: 'Revathi M', role: 'manager', phone: '9840054321', email: 'manager@billsynix.app', password: 'manager@123' },
  { id: 'priya', name: 'Priya S', role: 'cashier', phone: '9840011111', email: 'priya@billsynix.app', password: 'cashier@123', pin: '1111', counter: 'Counter 1' },
  { id: 'arun', name: 'Arun K', role: 'cashier', phone: '9840022222', email: 'arun@billsynix.app', password: 'cashier@123', pin: '2222', counter: 'Counter 2' },
  { id: 'kavitha', name: 'Kavitha R', role: 'cashier', phone: '9840033333', email: 'kavitha@billsynix.app', password: 'cashier@123', pin: '3333', counter: 'Counter 3' },
];

export const roleLabel: Record<Role, string> = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier' };

/** Name for a greeting: "Dr. R. Meena" → "Dr. Meena", "Senthil Kumar" → "Senthil". */
export const greetingName = (fullName: string | null | undefined) => {
  const words = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'there';
  return /^dr\.?$/i.test(words[0]!) && words.length > 1 ? `Dr. ${words[words.length - 1]}` : words[0]!;
};

/** Where each role lands after signing in. */
export const homeFor = (role: Role) => (role === 'cashier' ? '/pos' : '/dashboard');

/** Pages a role may open (prefix match). Cashiers only bill. */
export const canOpen = (role: Role, path: string) => role !== 'cashier' || path.startsWith('/pos');

/* ---------- accounts on this computer ---------- */

const ACCOUNTS_KEY = 'kirana:accounts';
const HASH_ROUNDS = 5000;

const randomHex = (bytes: number) => {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** Salted, iterated SHA-256 — slows down guessing if the stored hashes are copied. */
export const hashSecret = (salt: string, secret: string) => {
  let h = sha256Hex(`${salt}:${secret}`);
  for (let i = 1; i < HASH_ROUNDS; i++) h = sha256Hex(h + salt);
  return h;
};

const digits = (s: string) => s.replace(/\D/g, '');
export const normalisePhone = (s: string) => digits(s).slice(-10);

export function getAccounts(): StoredAccount[] {
  if (typeof window === 'undefined') return [];
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(ACCOUNTS_KEY) ?? '[]');
    return Array.isArray(v) ? (v as StoredAccount[]) : [];
  } catch {
    return [];
  }
}

/** Replaces all accounts on this computer (used by setup). */
export function setAccounts(list: (NewAccount & { id?: string })[]) {
  const used = new Set<string>();
  const stored = list.map((a): StoredAccount => {
    const base = (a.id ?? a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')) || 'user';
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    const salt = randomHex(16);
    return {
      id,
      name: a.name.trim(),
      role: a.role,
      phone: normalisePhone(a.phone),
      email: a.email.trim().toLowerCase(),
      counter: a.counter,
      salt,
      // PIN-only cashiers get an unguessable random password.
      passwordHash: hashSecret(salt, a.password ?? randomHex(24)),
      pinHash: a.pin ? hashSecret(salt, `pin:${a.pin}`) : undefined,
    };
  });
  try {
    window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(stored));
  } catch {
    /* storage blocked */
  }
  return stored;
}

export const getCashiers = () => getAccounts().filter((a) => a.role === 'cashier' && a.pinHash);

/* ---------- sign in / out ---------- */

export type Session = {
  userId: string;
  name: string;
  role: Role;
  counter: string | null;
  method: 'password' | 'pin';
  signedInAt: string;
  expiresAt: string;
};

export type SignInResult = { ok: true; session: Session } | { ok: false; error: string };

const KEY = 'kirana:session';
const SHIFT_HOURS = 12;
const REMEMBER_DAYS = 30;

/** Accepts a 10-digit mobile number (with or without +91 / spaces) or an email. */
export function signIn(identifier: string, password: string, remember: boolean): SignInResult {
  const id = identifier.trim().toLowerCase();
  const phone = normalisePhone(id);
  const account = getAccounts().find((a) => (a.email && a.email === id) || (phone.length === 10 && a.phone === phone));
  if (!account || account.passwordHash !== hashSecret(account.salt, password))
    return { ok: false, error: 'That mobile number / email and password don’t match.' };
  return { ok: true, session: start(account, 'password', remember) };
}

export function signInWithPin(accountId: string, pin: string): SignInResult {
  const account = getCashiers().find((a) => a.id === accountId);
  if (!account || account.pinHash !== hashSecret(account.salt, `pin:${pin}`)) return { ok: false, error: 'Wrong PIN. Try again.' };
  return { ok: true, session: start(account, 'pin', false) };
}

/** Signs a just-created account in (end of setup). */
export function signInAs(accountId: string): Session | null {
  const account = getAccounts().find((a) => a.id === accountId);
  return account ? start(account, 'password', true) : null;
}

function start(a: StoredAccount, method: Session['method'], remember: boolean): Session {
  const now = new Date();
  const expires = new Date(now.getTime() + (remember ? REMEMBER_DAYS * 24 : SHIFT_HOURS) * 3_600_000);
  const session: Session = {
    userId: a.id,
    name: a.name,
    role: a.role,
    counter: a.counter ?? null,
    method,
    signedInAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
  write(session);
  return session;
}

const signOutListeners = new Set<() => void>();
/** Lets the backend connection end the server session too (see lib/live/session.ts). */
export function onSignOut(fn: () => void) {
  signOutListeners.add(fn);
}

export function signOut() {
  write(null);
  signOutListeners.forEach((l) => l());
}

/** Connected mode: the session comes from the API and lives in memory only. */
export function setLiveSession(s: Session | null) {
  write(s);
}

/* ---------- failed-attempt lockout (per browser) ---------- */

const ATTEMPTS_KEY = 'kirana:login-attempts';
const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 30;

type Attempts = { count: number; lockedUntil: number };

export function loginLock(): Attempts {
  try {
    const a = JSON.parse(window.localStorage.getItem(ATTEMPTS_KEY) ?? 'null') as Attempts | null;
    return a ?? { count: 0, lockedUntil: 0 };
  } catch {
    return { count: 0, lockedUntil: 0 };
  }
}

/** Records a failed attempt; returns seconds locked (0 if not locked). */
export function recordFailure(): number {
  const a = loginLock();
  const count = a.count + 1;
  const lockedUntil = count >= MAX_ATTEMPTS ? Date.now() + LOCK_SECONDS * 1000 : 0;
  try {
    window.localStorage.setItem(ATTEMPTS_KEY, JSON.stringify({ count: lockedUntil ? 0 : count, lockedUntil }));
  } catch {
    /* ignore */
  }
  return lockedUntil ? LOCK_SECONDS : 0;
}

export function clearFailures() {
  try {
    window.localStorage.removeItem(ATTEMPTS_KEY);
  } catch {
    /* ignore */
  }
}

/* ---------- session storage + live hook ---------- */

let cache: Session | null | undefined;
const listeners = new Set<() => void>();

function read(): Session | null {
  // With a backend, sessions are restored from the API (refresh cookie), never from storage.
  if (apiConfigured) return null;
  try {
    const raw = window.localStorage.getItem(KEY) ?? window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return new Date(s.expiresAt).getTime() > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function write(s: Session | null) {
  cache = s;
  try {
    window.localStorage.removeItem(KEY);
    window.sessionStorage.removeItem(KEY);
    if (s && !apiConfigured) {
      // "Remember me" keeps the session in localStorage; otherwise it ends with the browser session.
      const long = new Date(s.expiresAt).getTime() - Date.now() > SHIFT_HOURS * 3_600_000;
      (long ? window.localStorage : window.sessionStorage).setItem(KEY, JSON.stringify(s));
    }
  } catch {
    /* storage blocked — signed in for this page only */
  }
  listeners.forEach((l) => l());
}

export function getSession(): Session | null {
  if (typeof window === 'undefined') return null;
  if (cache === undefined) cache = read();
  if (cache && new Date(cache.expiresAt).getTime() <= Date.now()) cache = null;
  return cache;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return;
    cache = undefined; // signed in / out in another tab
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Current session (null when signed out). Always null during server rendering. */
export function useSession() {
  return useSyncExternalStore(subscribe, getSession, () => null);
}

const noop = () => () => {};
/** False during server render and hydration, true once running in the browser. */
export function useHydrated() {
  return useSyncExternalStore(noop, () => true, () => false);
}
