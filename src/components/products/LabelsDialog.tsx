'use client';

import { useMemo, useState } from 'react';
import { Minus, Plus, Printer, Search, Trash2 } from 'lucide-react';
import { posCatalog, type PosItem } from '@/lib/pos/catalog';
import { live } from '@/lib/live/hydrate';
import { isLive } from '@/lib/live/session';
import { useBusinessProfile } from '@/lib/business-profile';
import { barcodeSvg } from '@/lib/barcode';
import { Btn, ErrorLine, Modal, fieldCls, labelCls } from '@/components/live/kit';

/* ---------- label stock ---------- */

type Sheet = { cols: number; rows: number; marginTop: number; marginLeft: number; gapX: number; gapY: number };
type Size = { id: string; title: string; w: number; h: number; sheet?: Sheet };
const SIZES: Size[] = [
  { id: '50x25', title: '50 × 25 mm roll (thermal label printer)', w: 50, h: 25 },
  { id: '38x25', title: '38 × 25 mm roll', w: 38, h: 25 },
  { id: '75x50', title: '75 × 50 mm roll (shelf label)', w: 75, h: 50 },
  { id: 'a4-65', title: 'A4 sheet, 65 labels (38.1 × 21.2 mm)', w: 38.1, h: 21.2, sheet: { cols: 5, rows: 13, marginTop: 10.7, marginLeft: 4.7, gapX: 2.5, gapY: 0 } },
  { id: 'a4-24', title: 'A4 sheet, 24 labels (64 × 34 mm)', w: 64, h: 33.9, sheet: { cols: 3, rows: 8, marginTop: 13, marginLeft: 7.2, gapX: 2.5, gapY: 0 } },
];

type Fields = { store: boolean; name: boolean; price: boolean; mrp: boolean; barcode: boolean; sku: boolean };
type Line = { item: PosItem; copies: number };

const mrpOf = (p: PosItem) => {
  if (!isLive()) return p.price;
  const m = live.products.get(p.sku)?.mrp;
  return m ? Number(m) : null;
};
const rupee = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** One label's inner HTML (shared by the preview and the print page). Classes are bl- prefixed so the preview can't clash with the app. */
function labelHtml(p: PosItem, f: Fields, store: string, size: Size) {
  const mrp = mrpOf(p);
  const small = size.h < 24;
  const parts: string[] = [];
  if (f.store) parts.push(`<div class="bl-store">${esc(store)}</div>`);
  if (f.name) parts.push(`<div class="bl-name">${esc(p.name)}</div>`);
  const prices: string[] = [];
  if (f.price) prices.push(`<span class="bl-price">${rupee(p.price)}</span>`);
  if (f.mrp && mrp !== null && (!f.price || mrp > p.price))
    prices.push(`<span class="bl-mrp">MRP ${rupee(mrp)}${small ? '' : ' <small>incl. of all taxes</small>'}</span>`);
  if (prices.length) parts.push(`<div class="bl-prices">${prices.join('')}</div>`);
  if (f.barcode && p.barcode) {
    try {
      parts.push(`<div class="bl-bc">${barcodeSvg(p.barcode, { height: 40, showText: true })}</div>`);
    } catch {
      parts.push(`<div class="bl-sku">${esc(p.barcode)}</div>`);
    }
  }
  if (f.sku && (!f.barcode || p.barcode !== p.sku)) parts.push(`<div class="bl-sku">${esc(p.sku)}</div>`);
  return parts.join('');
}

function labelCss(size: Size) {
  // Small roll and sheet labels (≤ 26 mm tall): one-line name, tighter type, the barcode takes what's left.
  const small = size.h <= 26;
  const base = small ? 6.5 : Math.min(11, size.h / 3.4);
  return `
  .bl-label { width:${size.w}mm; height:${size.h}mm; box-sizing:border-box; padding:${small ? '0.8mm 1.4mm' : '1.5mm 2mm'}; overflow:hidden;
    display:flex; flex-direction:column; gap:${small ? '0.2mm' : '0.6mm'}; font-family:Arial,Helvetica,sans-serif; color:#000; background:#fff; line-height:1.1; }
  .bl-label > * { flex:0 0 auto; }
  .bl-store { font-size:${base * 0.75}pt; font-weight:700; text-transform:uppercase; letter-spacing:.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .bl-name { font-size:${base}pt; font-weight:700; overflow:hidden; ${small ? 'white-space:nowrap; text-overflow:ellipsis;' : 'max-height:2.25em;'} }
  .bl-prices { display:flex; align-items:baseline; gap:1.5mm; white-space:nowrap; overflow:hidden; }
  .bl-price { font-size:${base * 1.3}pt; font-weight:800; }
  .bl-mrp { font-size:${base * 0.8}pt; } .bl-mrp small { font-size:.75em; }
  .bl-bc { flex:1 1 0 !important; min-height:0; }
  .bl-bc svg { width:100%; height:100%; display:block; }
  .bl-sku { font-size:${base * 0.75}pt; font-family:Consolas,monospace; }`;
}

/** The full print page: one label per page on a roll, or a grid per A4 sheet. */
export function labelsDocument(lines: Line[], f: Fields, store: string, size: Size) {
  const labels = lines.flatMap((l) => Array.from({ length: l.copies }, () => `<div class="bl-label">${labelHtml(l.item, f, store, size)}</div>`));
  const sheet = size.sheet;
  const css = sheet
    ? `@page { size: A4; margin: 0; } body { margin:0; }
       .bl-page { width:210mm; height:297mm; box-sizing:border-box; padding:${sheet.marginTop}mm 0 0 ${sheet.marginLeft}mm; display:grid;
         grid-template-columns:repeat(${sheet.cols}, ${size.w}mm); grid-auto-rows:${size.h}mm; column-gap:${sheet.gapX}mm; row-gap:${sheet.gapY}mm; page-break-after:always; }`
    : `@page { size: ${size.w}mm ${size.h}mm; margin: 0; } body { margin:0; } .bl-label { page-break-after: always; }`;
  const perPage = sheet ? sheet.cols * sheet.rows : 0;
  const body = sheet
    ? Array.from({ length: Math.ceil(labels.length / perPage) }, (_, i) => `<div class="bl-page">${labels.slice(i * perPage, (i + 1) * perPage).join('')}</div>`).join('')
    : labels.join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>${css}${labelCss(size)}</style></head><body>${body}</body></html>`;
}

function printLabels(html: string) {
  // A hidden frame prints just the labels, at the label's own page size, in a browser or the desktop app.
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('data-labels', '');
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60_000);
  }, 250);
}

/* ---------- dialog ---------- */

export function LabelsDialog({ open, onClose, initial = [] }: { open: boolean; onClose: () => void; initial?: string[] }) {
  const profile = useBusinessProfile();
  const [lines, setLines] = useState<Line[]>(() =>
    initial.flatMap((sku) => {
      const item = posCatalog.find((p) => p.sku === sku);
      return item ? [{ item, copies: 1 }] : [];
    })
  );
  const [q, setQ] = useState('');
  const [sizeId, setSizeId] = useState('50x25');
  const [fields, setFields] = useState<Fields>({ store: true, name: true, price: true, mrp: true, barcode: true, sku: false });
  const [error, setError] = useState('');
  const size = SIZES.find((s) => s.id === sizeId)!;
  const total = lines.reduce((s, l) => s + l.copies, 0);
  const sheets = size.sheet ? Math.ceil(total / (size.sheet.cols * size.sheet.rows)) : 0;

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return posCatalog
      .filter((p) => !lines.some((l) => l.item.sku === p.sku))
      .filter((p) => p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s) || p.barcode === s)
      .slice(0, 8);
  }, [q, lines]);

  const add = (item: PosItem) => {
    setLines((ls) => [...ls, { item, copies: 1 }]);
    setQ('');
  };
  const setCopies = (sku: string, n: number) => setLines((ls) => ls.map((l) => (l.item.sku === sku ? { ...l, copies: Math.max(1, Math.min(999, n)) } : l)));
  const preview = lines[0]?.item ?? posCatalog[0];

  return (
    <Modal open={open} onClose={onClose} wide title="Print labels" sub="Barcode and price labels for shelves and loose or repacked items.">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hits[0]) {
                  e.preventDefault();
                  add(hits[0]);
                }
              }}
              placeholder="Add a product — name, SKU or barcode"
              aria-label="Find product for labels"
              className={`${fieldCls} pl-9`}
            />
            {hits.length > 0 && (
              <ul className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-xl border border-line bg-surface py-1 shadow-lg">
                {hits.map((p) => (
                  <li key={p.sku}>
                    <button type="button" onClick={() => add(p)} className="flex w-full justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-bg">
                      <span className="truncate">{p.name}</span>
                      <span className="text-xs text-mute">{p.barcode}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {lines.length > 0 ? (
            <ul className="max-h-64 divide-y divide-line overflow-auto rounded-xl border border-line">
              {lines.map((l) => (
                <li key={l.item.sku} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{l.item.name}</span>
                    <span className="block text-xs text-mute">
                      {l.item.barcode} · {rupee(l.item.price)}
                    </span>
                  </span>
                  <button type="button" onClick={() => setCopies(l.item.sku, l.copies - 1)} className="grid size-7 place-items-center rounded-lg border border-line" aria-label="Fewer">
                    <Minus className="size-3.5" />
                  </button>
                  <input
                    value={l.copies}
                    inputMode="numeric"
                    onChange={(e) => setCopies(l.item.sku, Number(e.target.value.replace(/\D/g, '')) || 1)}
                    aria-label={`Copies of ${l.item.name}`}
                    className="h-7 w-12 rounded-lg border border-line bg-surface text-center tabular-nums"
                  />
                  <button type="button" onClick={() => setCopies(l.item.sku, l.copies + 1)} className="grid size-7 place-items-center rounded-lg border border-line" aria-label="More">
                    <Plus className="size-3.5" />
                  </button>
                  {l.item.stock > 0 && (
                    <button type="button" onClick={() => setCopies(l.item.sku, l.item.stock)} className="text-xs font-semibold text-blue" title="One label per unit in stock">
                      ×{l.item.stock}
                    </button>
                  )}
                  <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x !== l))} className="text-mute hover:text-coral" aria-label="Remove">
                    <Trash2 className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl bg-bg px-3 py-6 text-center text-sm text-sub">Add the products you want labels for.</p>
          )}
          <ErrorLine>{error}</ErrorLine>
        </div>

        <div className="space-y-3">
          <label className={labelCls}>
            Label size
            <select value={sizeId} onChange={(e) => setSizeId(e.target.value)} className={`${fieldCls} mt-1`}>
              {SIZES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="grid grid-cols-2 gap-1.5 text-sm">
            <legend className={`${labelCls} mb-1`}>Show on the label</legend>
            {(
              [
                ['store', 'Store name'],
                ['name', 'Product name'],
                ['price', 'Selling price'],
                ['mrp', 'MRP'],
                ['barcode', 'Barcode'],
                ['sku', 'SKU'],
              ] as [keyof Fields, string][]
            ).map(([k, l]) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="checkbox" checked={fields[k]} onChange={(e) => setFields((f) => ({ ...f, [k]: e.target.checked }))} className="accent-[var(--blue)]" />
                {l}
              </label>
            ))}
          </fieldset>
          {preview && (
            <div>
              <div className={`${labelCls} mb-1`}>Preview</div>
              <div className="grid place-items-center overflow-hidden rounded-xl bg-bg p-3">
                <style>{labelCss(size)}</style>
                <div
                  className="bl-label shadow-sm ring-1 ring-line"
                  style={{ zoom: Math.min(1, 220 / ((size.w * 96) / 25.4)) }}
                  dangerouslySetInnerHTML={{ __html: labelHtml(preview, fields, profile.displayName, size) }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
        <span className="text-sm text-sub">
          {total} label{total === 1 ? '' : 's'}
          {sheets > 0 && ` · ${sheets} sheet${sheets === 1 ? '' : 's'}`}
        </span>
        <div className="flex gap-2">
          <Btn onClick={onClose}>Close</Btn>
          <Btn
            tone="primary"
            disabled={!total}
            onClick={() => {
              setError('');
              try {
                printLabels(labelsDocument(lines, fields, profile.displayName, size));
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not print');
              }
            }}
          >
            <Printer className="size-4" /> Print {total || ''} label{total === 1 ? '' : 's'}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
