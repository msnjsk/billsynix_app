'use client';

import { useEffect, useRef } from 'react';

/**
 * USB / Bluetooth barcode scanners act as keyboards: they "type" the code very fast and press Enter.
 * This hook catches those bursts anywhere on the page — except inside text fields, where the
 * field's own Enter handling applies (the POS search box looks codes up itself).
 */
export function useBarcodeScanner(onScan: (code: string) => void, enabled = true) {
  const buf = useRef('');
  const last = useRef(0);
  const cb = useRef(onScan);
  useEffect(() => {
    cb.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!enabled) return;
    const MAX_GAP_MS = 50; // humans rarely type faster than this between keys
    const MIN_LENGTH = 6;

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const now = performance.now();
      if (now - last.current > MAX_GAP_MS) buf.current = '';
      last.current = now;

      if (e.key === 'Enter') {
        if (buf.current.length >= MIN_LENGTH) {
          e.preventDefault();
          cb.current(buf.current);
        }
        buf.current = '';
      } else if (e.key.length === 1) {
        buf.current += e.key;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}
