/**
 * First-run setup state for this computer, and the step that applies everything the wizard collected:
 * business profile, staff accounts, this counter's POS settings and the starting bill number.
 */
import { useSyncExternalStore } from 'react';
import { apiConfigured } from '@/lib/api/client';
import { demoAccounts, setAccounts, type NewAccount } from '@/lib/auth';
import { resetBusinessProfile, saveBusinessProfile, type BusinessProfile } from '@/lib/business-profile';
import { defaultSettings, saveLocal, type PosSettings } from '@/lib/pos/store';
import { FIRST_POS_SEQ } from '@/lib/pos/billing';

export type SetupMode = 'store' | 'demo';
export type SetupState = { mode: SetupMode; completedAt: string; version: 1 };

const KEY = 'kirana:setup';
export const DRAFT_KEY = 'kirana:setup-draft';

let cache: SetupState | null | undefined;
const listeners = new Set<() => void>();

function read(): SetupState | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as SetupState | null;
    return v && (v.mode === 'store' || v.mode === 'demo') ? v : null;
  } catch {
    return null;
  }
}

/** Connected to a backend: the business is set up on the server, not on this computer. */
const LIVE_SETUP: SetupState = { mode: 'store', completedAt: '', version: 1 };

export function getSetup(): SetupState | null {
  if (typeof window === 'undefined') return null;
  if (apiConfigured) return LIVE_SETUP;
  if (cache === undefined) cache = read();
  return cache;
}

function write(s: SetupState | null) {
  cache = s;
  try {
    if (s) window.localStorage.setItem(KEY, JSON.stringify(s));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return;
    cache = undefined;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** null until this computer has been set up. Always null during server rendering. */
export function useSetup() {
  return useSyncExternalStore(subscribe, getSetup, () => null);
}

/** A fresh, empty POS register that starts at the given bill number. */
const freshRegister = (seq: number) => ({
  docs: [],
  held: [],
  seq,
  cnSeq: 1,
  patched: {},
  draft: { lines: [], billDiscount: null, buyer: null },
});

export type SetupPayload = {
  profile: BusinessProfile;
  owner: { name: string; phone: string; email: string; password: string };
  cashiers: { name: string; counter: string; pin: string }[];
  counter: Pick<PosSettings, 'counter' | 'upiId' | 'paperWidth' | 'printMethod' | 'desktopPrinter' | 'autoPrint' | 'openDrawer'>;
  startingBillNo: number;
};

/** Applies a completed setup. Returns the owner's account id (to sign them in). */
export function finishSetup(p: SetupPayload): string {
  saveBusinessProfile({ ...p.profile, ownerName: p.owner.name, isSample: false });

  const accounts: NewAccount[] = [
    { name: p.owner.name, role: 'owner', phone: p.owner.phone, email: p.owner.email, password: p.owner.password },
    ...p.cashiers.map((c) => ({ name: c.name, role: 'cashier' as const, phone: '', email: '', counter: c.counter, pin: c.pin })),
  ];
  const stored = setAccounts(accounts);

  saveLocal('settings', { ...defaultSettings, ...p.counter, cashier: p.owner.name });
  saveLocal('session', freshRegister(p.startingBillNo));

  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
  write({ mode: 'store', completedAt: new Date().toISOString(), version: 1 });
  return stored[0]!.id;
}

/** "Explore with demo data": sample store, demo staff (listed on the login page), demo bills. */
export function startDemo() {
  resetBusinessProfile();
  setAccounts(demoAccounts);
  saveLocal('session', freshRegister(FIRST_POS_SEQ));
  write({ mode: 'demo', completedAt: new Date().toISOString(), version: 1 });
}

/** Wipes setup on this computer so the wizard runs again (accounts and profile are replaced on finish). */
export function resetSetup() {
  write(null);
}
