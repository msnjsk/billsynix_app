/**
 * Questions the live layer needs the person to answer (e.g. the opening cash before the first
 * sale). `window.prompt` doesn't exist in the desktop app, so a dialog in the UI answers instead
 * (components/live/OpeningCashDialog.tsx).
 */
import { useSyncExternalStore } from 'react';

let pending: ((amount: number | null) => void) | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Resolves with the amount entered, or null if the person cancelled. */
export function askOpeningFloat(): Promise<number | null> {
  pending?.(null);
  return new Promise((resolve) => {
    pending = resolve;
    emit();
  });
}

export function answerOpeningFloat(amount: number | null) {
  // Nothing asked: don't notify (a listener that answers on every notification would loop).
  if (!pending) return;
  const p = pending;
  pending = null;
  emit();
  p?.(amount);
}

export function onOpeningFloatRequest(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** true while a question is waiting for an answer. */
export function useOpeningFloatRequest() {
  return useSyncExternalStore(onOpeningFloatRequest, () => pending !== null, () => false);
}

/* ---------- closing a drawer left open on another counter ---------- */

/** The drawer the cashier still has open elsewhere, shown so they can count and close it. */
export type OtherDrawer = {
  id: string;
  where: string;
  openedAt: string;
  expectedCash: number;
  here: string;
  /** Someone else's drawer on this counter (a manager closes it): their name. */
  owner?: string;
};

let closing: { drawer: OtherDrawer; resolve: (counted: number | null) => void } | null = null;
const closeListeners = new Set<() => void>();
const emitClose = () => closeListeners.forEach((l) => l());

/** Resolves with the cash counted in that drawer, or null if the person cancelled. */
export function askCloseOtherDrawer(drawer: OtherDrawer): Promise<number | null> {
  closing?.resolve(null);
  return new Promise((resolve) => {
    closing = { drawer, resolve };
    emitClose();
  });
}

export function answerCloseOtherDrawer(counted: number | null) {
  if (!closing) return;
  const c = closing;
  closing = null;
  emitClose();
  c.resolve(counted);
}

export function onCloseOtherDrawerRequest(fn: () => void) {
  closeListeners.add(fn);
  return () => closeListeners.delete(fn);
}

/** The drawer waiting to be closed, or null. */
export function useCloseOtherDrawerRequest() {
  return useSyncExternalStore(onCloseOtherDrawerRequest, () => closing?.drawer ?? null, () => null);
}
