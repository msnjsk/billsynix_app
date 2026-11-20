'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { Product } from '@/lib/api/types';
import { liveProducts } from '@/lib/live/stockops';

/** Type to find a product by name, SKU or barcode; Enter picks the first match. */
export function ProductPicker({
  onPick,
  exclude = [],
  placeholder = 'Add a product — name, SKU or barcode',
}: {
  onPick: (p: Product) => void;
  exclude?: string[];
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const all = useMemo(liveProducts, []);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return all
      .filter((p) => !exclude.includes(p.id))
      .filter((p) => p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s) || p.barcodes.some((b) => b.code === s))
      .slice(0, 8);
  }, [q, all, exclude]);

  const pick = (p: Product) => {
    onPick(p);
    setQ('');
  };

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" aria-hidden="true" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (hits[0]) pick(hits[0]);
          }
        }}
        placeholder={placeholder}
        aria-label="Find product"
        className="h-10 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-sm outline-none focus:border-blue"
      />
      {hits.length > 0 && (
        <ul className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-xl border border-line bg-surface py-1 shadow-lg">
          {hits.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => pick(p)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-bg">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block text-xs text-mute">
                    {p.sku} · {p.unit.code}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-sub">₹{Number(p.sellingPrice).toFixed(2)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
