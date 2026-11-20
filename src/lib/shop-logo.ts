/**
 * The shop's own logo (shown as the profile picture in the app, and available for receipts).
 *
 * - Connected: uploaded to the server (PUT /tenants/current/logo). A copy is kept on this computer
 *   with the server's version, so it shows straight away, offline too, and is re-fetched only when
 *   someone uploads a new one.
 * - On this computer only: kept in browser storage.
 *
 * Either way the image is resized in the browser first (longest side 512 px), so uploads stay
 * small and fast.
 */
import { useSyncExternalStore } from 'react';
import { api, apiConfigured } from '@/lib/api/client';

const KEY = 'kirana:shop-logo';
const MAX_SIDE = 512;
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

type Stored = { dataUrl: string; version: string; tenantId: string };

let cache: Stored | null | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function read(): Stored | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Stored) : null;
    return v && typeof v.dataUrl === 'string' && v.dataUrl.startsWith('data:image/') ? v : null;
  } catch {
    return null;
  }
}

function write(v: Stored | null) {
  cache = v;
  try {
    if (v) window.localStorage.setItem(KEY, JSON.stringify(v));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* storage full or blocked — the logo still shows until the page is closed */
  }
  emit();
}

function current(): Stored | null {
  if (typeof window === 'undefined') return null;
  if (cache === undefined) cache = read();
  return cache;
}

/** The logo as a data URL, or null when the shop has none. */
export const getShopLogo = () => current()?.dataUrl ?? null;

export function useShopLogo(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getShopLogo,
    () => null,
  );
}

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read the image.'));
    r.readAsDataURL(blob);
  });

/** Scales the picture down to fit 512×512 (keeping transparency) and returns it as PNG. */
async function shrink(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file isn’t an image we can read. Use a PNG, JPG or WebP.'));
      i.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Checks the picked file before anything is uploaded. Returns an error message, or null. */
export function logoProblem(file: File): string | null {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return 'Use a PNG, JPG or WebP image.';
  if (file.size > 8 * 1024 * 1024) return 'That image is larger than 8 MB — pick a smaller one.';
  return null;
}

/** Sets the shop logo from a picked file. */
export async function setShopLogo(file: File, tenantId = '') {
  const small = await shrink(file);
  if (small.size > MAX_LOGO_BYTES) throw new Error('Even after resizing, the logo is over 2 MB. Try a simpler image.');
  if (apiConfigured) {
    const form = new FormData();
    form.append('logo', small, 'logo.png');
    const t = await api<{ id: string; logo: { version: string } | null }>('PUT', '/tenants/current/logo', { form });
    write({ dataUrl: await toDataUrl(small), version: t.logo?.version ?? '', tenantId: t.id });
    return;
  }
  write({ dataUrl: await toDataUrl(small), version: 'local', tenantId });
}

export async function removeShopLogo() {
  if (apiConfigured) await api('DELETE', '/tenants/current/logo');
  write(null);
}

/**
 * Connected: brings this computer's copy in line with the server (called when the business
 * loads). Fetches the image only when the server has a different version than the copy here.
 */
export async function syncShopLogo(tenant: { id: string; logo?: { version: string } | null }) {
  const have = current();
  if (!tenant.logo) {
    if (have) write(null);
    return;
  }
  if (have && have.tenantId === tenant.id && have.version === tenant.logo.version) return;
  try {
    const blob = await api<Blob>('GET', '/tenants/current/logo', { blob: true });
    write({ dataUrl: await toDataUrl(blob), version: tenant.logo.version, tenantId: tenant.id });
  } catch {
    // Keep showing the old copy if it's this business's; otherwise none (try again next load).
    if (have && have.tenantId !== tenant.id) write(null);
  }
}
