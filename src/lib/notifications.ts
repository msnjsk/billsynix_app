/**
 * Notifications for the bell and desktop pop-ups.
 *
 * Connected: the server keeps them in step with the business's data (stock, orders, drawers,
 * payments, supplier dues, subscription, staff…) and decides who sees what. This checks every
 * 30 s while the app is open (and at once when the window comes back into focus), and pops up
 * anything new on the desktop when pop-ups are turned on.
 *
 * On this computer only (no server): the demo store's low-stock items, as before.
 */
import { useSyncExternalStore } from 'react';
import { api, apiConfigured, ApiError } from '@/lib/api/client';
import { lowStock, products } from '@/lib/store-data';
import { getSetup } from '@/lib/setup';

export type NotificationSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AppNotification = {
  id: string;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  link: string | null;
  raisedAt: string;
  active: boolean;
  read: boolean;
};

type State = {
  items: AppNotification[];
  unread: number;
  /** loading: first check running; ready; offline: can't reach the server (showing the last list). */
  status: 'loading' | 'ready' | 'offline';
};

const POLL_MS = 30_000;
const POPUP_KEY = 'billsynix:popups';
const SEEN_KEY = 'billsynix:popups-seen';

let state: State = { items: [], unread: 0, status: 'loading' };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

/* ---------- checking ---------- */

let timer: number | null = null;
let subscribers = 0;
let inFlight: Promise<void> | null = null;

async function check() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (!apiConfigured) {
      set(localNotifications());
      return;
    }
    try {
      const r = await api<{ data: AppNotification[]; unread: number }>('GET', '/notifications', { query: { limit: 50 } });
      set({ items: r.data, unread: r.unread, status: 'ready' });
      popUpNew(r.data);
    } catch (e) {
      // Signed out: stop. Offline: keep showing the last list.
      if (e instanceof ApiError && e.status === 401) stop();
      set({ status: e instanceof ApiError && e.code === 'NETWORK' ? 'offline' : state.status === 'loading' ? 'ready' : state.status });
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

const onFocus = () => void check();

function start() {
  if (typeof window === 'undefined' || timer !== null) return;
  void check();
  timer = window.setInterval(() => void check(), POLL_MS);
  window.addEventListener('focus', onFocus);
}

function stop() {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
}

/** The bell's data. Checking runs while at least one bell is on screen. */
export function useNotifications(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      if (++subscribers === 1) start();
      return () => {
        listeners.delete(l);
        if (--subscribers === 0) stop();
      };
    },
    () => state,
    () => state,
  );
}

/** Check now (e.g. right after an action that may clear an alert). */
export const refreshNotifications = () => check();

/* ---------- reading ---------- */

const localRead = new Set<string>();

export async function markRead(id: string) {
  const items = state.items.map((n) => (n.id === id ? { ...n, read: true } : n));
  set({ items, unread: items.filter((n) => n.active && !n.read).length });
  if (!apiConfigured) {
    localRead.add(id);
    return;
  }
  try {
    await api('POST', `/notifications/${id}/read`);
  } catch {
    /* the next check puts it right */
  }
}

export async function markAllRead() {
  const items = state.items.map((n) => ({ ...n, read: true }));
  set({ items, unread: 0 });
  if (!apiConfigured) {
    items.forEach((n) => localRead.add(n.id));
    return;
  }
  try {
    await api('POST', '/notifications/read-all');
  } catch {
    /* the next check puts it right */
  }
}

/** This computer only: the demo store's low-stock items (a real store kept here has no stock levels yet). */
function localNotifications(): State {
  const demo = getSetup()?.mode === 'demo';
  const items: AppNotification[] = demo
    ? products.filter(lowStock).map((p) => ({
        id: `local-low-${p.name}`,
        kind: p.stock <= 0 ? 'stock.out' : 'stock.low',
        severity: p.stock <= 5 ? ('CRITICAL' as const) : ('WARNING' as const),
        title: `${p.name} is running low`,
        body: `${p.stock} left — reorder soon.`,
        link: '/inventory',
        raisedAt: new Date().toISOString(),
        active: true,
        read: localRead.has(`local-low-${p.name}`),
      }))
    : [];
  return { items, unread: items.filter((n) => !n.read).length, status: 'ready' };
}

/* ---------- desktop pop-ups ---------- */

export type PopupState = 'unsupported' | 'off' | 'on' | 'blocked';

const popupListeners = new Set<() => void>();
const supported = () => typeof window !== 'undefined' && 'Notification' in window;

function popupState(): PopupState {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  let wanted = false;
  try {
    wanted = window.localStorage.getItem(POPUP_KEY) === 'on';
  } catch {
    /* ignore */
  }
  return wanted && Notification.permission === 'granted' ? 'on' : 'off';
}

export function usePopupState(): PopupState {
  return useSyncExternalStore(
    (l) => {
      popupListeners.add(l);
      return () => popupListeners.delete(l);
    },
    popupState,
    () => 'off' as PopupState,
  );
}

/** Turns desktop pop-ups on (asking the browser's permission) or off. */
export async function setPopups(on: boolean) {
  if (!supported()) return;
  if (on && Notification.permission !== 'granted') await Notification.requestPermission();
  try {
    window.localStorage.setItem(POPUP_KEY, on && Notification.permission === 'granted' ? 'on' : 'off');
    // Only what arrives from now on pops up — not everything already in the bell.
    if (on) window.localStorage.setItem(SEEN_KEY, new Date().toISOString());
  } catch {
    /* ignore */
  }
  popupListeners.forEach((l) => l());
  if (on && Notification.permission === 'granted')
    show({ title: 'Pop-ups are on', body: 'New alerts will show here even when BillSynix is in the background.', link: null, tag: 'billsynix-test' });
}

let navigate: ((href: string) => void) | null = null;
/** The app's router, so clicking a pop-up opens the right screen. */
export const setNotificationNavigator = (fn: (href: string) => void) => {
  navigate = fn;
};

function show(n: { title: string; body: string; link: string | null; tag: string }) {
  try {
    const p = new Notification(n.title, { body: n.body, tag: n.tag, icon: '/brand/logo-mark-192.png', badge: '/brand/logo-mark-64.png' });
    p.onclick = () => {
      window.focus();
      if (n.link) navigate ? navigate(n.link) : window.location.assign(n.link);
      p.close();
    };
  } catch {
    /* some browsers only allow pop-ups from a service worker — the bell still shows it */
  }
}

/** Pops up what was raised since the last pop-up (at most 3, then one summary). */
function popUpNew(items: AppNotification[]) {
  if (popupState() !== 'on') return;
  let seen = '';
  try {
    seen = window.localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    /* ignore */
  }
  const fresh = items.filter((n) => n.active && !n.read && (!seen || n.raisedAt > seen));
  if (!fresh.length) return;
  const newest = fresh.reduce((a, n) => (n.raisedAt > a ? n.raisedAt : a), seen);
  try {
    window.localStorage.setItem(SEEN_KEY, newest);
  } catch {
    /* ignore */
  }
  // Several tabs open: the shared "seen" mark above means only the first to check pops it up.
  const urgent = [...fresh].sort((a, b) => rank(b.severity) - rank(a.severity));
  for (const n of urgent.slice(0, 3)) show({ title: n.title, body: n.body, link: n.link, tag: n.id });
  if (urgent.length > 3) show({ title: `${urgent.length - 3} more alerts`, body: 'Open the bell in BillSynix to see them all.', link: null, tag: 'billsynix-more' });
}

const rank = (s: NotificationSeverity) => (s === 'CRITICAL' ? 2 : s === 'WARNING' ? 1 : 0);
