import { apiConfigured } from '@/lib/api/client';

/**
 * Per-counter POS settings (cashier, printer, UPI ID).
 * Store identity — name, address, GSTIN, invoice prefix — lives in the Business profile
 * (src/lib/business-profile.ts), edited on the Business profile screen.
 */

/** browser = print dialog · serial = raw ESC/POS over Web Serial · desktop = silent print in the desktop app */
export type PrintMethod = 'browser' | 'serial' | 'desktop';
export type PaperWidth = 58 | 80;

export type PosSettings = {
  cashier: string;
  counter: string;
  upiId: string;
  paperWidth: PaperWidth;
  printMethod: PrintMethod;
  /** Print the receipt as soon as payment is recorded. */
  autoPrint: boolean;
  /** Pulse the cash drawer on cash payments (direct printing only). */
  openDrawer: boolean;
  baudRate: number;
  /** Desktop app: printer to print to silently ('' = system default). */
  desktopPrinter: string;
};

export const defaultSettings: PosSettings = {
  cashier: 'Priya S',
  counter: 'Counter 1',
  upiId: 'senthilfreshmart@okaxis',
  paperWidth: 80,
  printMethod: 'browser',
  autoPrint: false,
  openDrawer: true,
  baudRate: 9600,
  desktopPrinter: '',
};

/** In the desktop app, silent printing is the sensible default until the cashier changes it. */
export const initialSettings = (): PosSettings => ({
  ...defaultSettings,
  // A real (connected) business starts with its own UPI ID and cashier, never the sample ones.
  ...(apiConfigured && { upiId: '', cashier: '' }),
  printMethod: typeof window !== 'undefined' && window.posDesktop ? 'desktop' : defaultSettings.printMethod,
});

export const counters = ['Counter 1', 'Counter 2', 'Counter 3'];

/* ---------- browser storage (per counter; safe to lose) ---------- */

const PREFIX = 'kirana-pos:';

export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadLocalArray<T>(key: string): T[] {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function saveLocal(key: string, value: unknown) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — the POS still works for this session */
  }
}

/** UPI intent link; any UPI app can scan this as a QR to pay the exact amount. */
export const upiLink = (upiId: string, amount: number, note: string, payeeName: string) =>
  `upi://pay?${new URLSearchParams({
    pa: upiId,
    pn: payeeName,
    am: amount.toFixed(2),
    cu: 'INR',
    tn: note,
  }).toString()}`;

/* ---------- whose data is this? ---------- */

const OWNER_KEY = `${PREFIX}owner`;
/** Sample values that must never reach a real business (the UPI ID would take customers' money elsewhere). */
const DEMO_UPI = 'senthilfreshmart@okaxis';
const DEMO_CASHIER = 'Priya S';

/**
 * Connected mode: the counter's saved bills, held bills and draft belong to one business. When a
 * different business — or the old sample store — was last used on this computer, drop them so
 * its bills and numbers never show up here, and clear the sample cashier and UPI ID. Printer and
 * device settings stay. The offline outbox (IndexedDB) is never touched: unsynced bills are safe.
 */
/** Whether this computer has signed in to a real business before (so its saved store name is real). */
export function knowsLiveOwner() {
  try {
    return !!window.localStorage.getItem(OWNER_KEY);
  } catch {
    return false;
  }
}

export function scopeLocalData(owner: string) {
  try {
    const ls = window.localStorage;
    if (ls.getItem(OWNER_KEY) !== owner) {
      ls.removeItem(`${PREFIX}session`);
      // The sample store's profile, branches, purchases and logo: the server's copies replace them.
      for (const k of ['kirana:business-profile', 'kirana:branches', 'kirana:purchases', 'kirana:shop-logo']) ls.removeItem(k);
      const raw = ls.getItem(`${PREFIX}settings`);
      if (raw) {
        const s = JSON.parse(raw) as Partial<PosSettings>;
        ls.setItem(`${PREFIX}settings`, JSON.stringify({ ...s, upiId: '', cashier: '' }));
      }
      ls.setItem(OWNER_KEY, owner);
    }
    // Belt and braces: the sample values are never kept for a real business.
    const raw = ls.getItem(`${PREFIX}settings`);
    if (raw) {
      const s = JSON.parse(raw) as Partial<PosSettings>;
      if (s.upiId === DEMO_UPI || s.cashier === DEMO_CASHIER)
        ls.setItem(`${PREFIX}settings`, JSON.stringify({ ...s, ...(s.upiId === DEMO_UPI && { upiId: '' }), ...(s.cashier === DEMO_CASHIER && { cashier: '' }) }));
    }
  } catch {
    /* storage blocked: nothing saved, nothing to clear */
  }
}
