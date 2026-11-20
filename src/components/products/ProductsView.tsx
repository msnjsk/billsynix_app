'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PageHead, downloadCsv } from '@/components/AppShell';
import { ProductForm, type ProductFormValues } from '@/components/products/ProductForm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { inr } from '@/lib/store-data';
import { categoryColor, categoryPill } from '@/lib/category-tones';
import { inventoryItems, makeSku, statusOf, type InventoryItem, type StockStatus } from '@/lib/inventory-data';
import { can, isLive } from '@/lib/live/session';
import { LabelsDialog } from '@/components/products/LabelsDialog';
import { ImportProductsDialog } from '@/components/products/ImportProductsDialog';
import { CategoriesDialog } from '@/components/products/CategoriesDialog';
import { MoreMenu } from '@/components/MoreMenu';
import { Download, FolderTree, Upload } from 'lucide-react';
import { useLiveVersion } from '@/lib/live/hydrate';
import { archiveProduct, saveProduct, taxIdOf } from '@/lib/live/actions';
import { errorMessage } from '@/lib/api/client';
import { useNotice } from '@/components/live/Notice';

/* ---------- config ---------- */

const revenueOf = (p: InventoryItem) => p.units * p.price;
const marginOf = (p: InventoryItem) => (p.price > 0 ? ((p.price - p.cost) / p.price) * 100 : 0);

const sorts = {
  revenue: { label: 'Revenue', fn: (a: InventoryItem, b: InventoryItem) => revenueOf(b) - revenueOf(a) },
  units: { label: 'Units sold', fn: (a: InventoryItem, b: InventoryItem) => b.units - a.units },
  trend: { label: 'Trend', fn: (a: InventoryItem, b: InventoryItem) => b.trend - a.trend },
  priceHigh: { label: 'Price: high to low', fn: (a: InventoryItem, b: InventoryItem) => b.price - a.price },
  priceLow: { label: 'Price: low to high', fn: (a: InventoryItem, b: InventoryItem) => a.price - b.price },
  name: { label: 'Name', fn: (a: InventoryItem, b: InventoryItem) => a.name.localeCompare(b.name) },
} as const;
type SortKey = keyof typeof sorts;

const stockBadge: Record<StockStatus, { label: (n: number) => string; cls: string }> = {
  ok: { label: (n) => `${n} in stock`, cls: 'bg-teal/15 text-teal' },
  low: { label: (n) => `${n} left`, cls: 'bg-amber/15 text-amber' },
  critical: { label: (n) => `${n} left`, cls: 'bg-coral/15 text-coral' },
  out: { label: () => 'Out of stock', cls: 'bg-coral text-onbrand' },
};

type View = 'grid' | 'list';
type Editing = { key: number; product: InventoryItem | null };

const emptyForm: ProductFormValues = {
  name: '',
  category: '',
  supplier: '',
  price: Number.NaN,
  cost: Number.NaN,
  stock: 0,
};

/* ---------- small pieces ---------- */

function Trend({ value }: { value: number }) {
  if (value === 0) return <span className="text-mute">—</span>;
  const up = value > 0;
  return (
    <span className={`font-semibold tabular-nums ${up ? 'text-teal' : 'text-coral'}`}>
      {up ? '▲' : '▼'} {Math.abs(value)}%
    </span>
  );
}

function StockBadge({ p }: { p: InventoryItem }) {
  const s = stockBadge[statusOf(p)];
  return <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${s.cls}`}>{s.label(p.stock)}</span>;
}

function SummaryCard({
  label,
  value,
  foot,
  brand,
}: {
  label: string;
  value: string;
  foot: string;
  brand?: boolean;
}) {
  return (
    <div className={`rounded-2xl p-4 ${brand ? 'gbv text-onbrand shadow-lg shadow-blue/25' : 'card'}`}>
      <div className={brand ? 'text-onbrand/80' : 'text-sub'}>{label}</div>
      <div className={`mt-2 truncate text-[22px] font-extrabold tabular-nums ${brand ? '' : 'text-ink'}`}>{value}</div>
      <div className={`mt-1 text-[12px] ${brand ? 'text-onbrand/80' : 'text-mute'}`}>{foot}</div>
    </div>
  );
}

function RowActions({ onEdit, onDelete, onLabel, name }: { onEdit: () => void; onDelete: () => void; onLabel: () => void; name: string }) {
  return (
    <div className="flex justify-end gap-1.5">
      <button
        onClick={onLabel}
        aria-label={`Print labels for ${name}`}
        title="Print barcode labels"
        className="h-8 rounded-lg border border-line px-3 text-[12px] font-semibold text-sub hover:border-blue hover:text-ink"
      >
        Label
      </button>
      <button
        onClick={onEdit}
        aria-label={`Edit ${name}`}
        className="h-8 rounded-lg border border-line px-3 text-[12px] font-semibold text-ink hover:border-blue"
      >
        Edit
      </button>
      <button
        onClick={onDelete}
        aria-label={`Delete ${name}`}
        className="h-8 rounded-lg border border-line px-3 text-[12px] font-semibold text-coral hover:border-coral"
      >
        Delete
      </button>
    </div>
  );
}

/* ---------- main view ---------- */

export function ProductsView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [items, setItems] = useState<InventoryItem[]>(inventoryItems);
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [category, setCategory] = useState('All');
  const [sort, setSort] = useState<SortKey>('revenue');
  const [view, setView] = useState<View>('list');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [labels, setLabels] = useState<{ key: number; skus: string[] } | null>(null);
  const [importing, setImporting] = useState(false);
  const [managingCategories, setManagingCategories] = useState(false);
  const [deleting, setDeleting] = useState<InventoryItem | null>(null);
  const [serial, setSerial] = useState(2000);
  const [notice, notify] = useNotice();
  // Connected: the catalogue reloads from the server after every change.
  const liveVersion = useLiveVersion();
  useEffect(() => {
    if (isLive()) setItems([...inventoryItems]);
  }, [liveVersion]);

  // Header search (/products?q=…) and the dashboard's "+ Add new product" (/products?add=true).
  const qParam = params.get('q');
  const addParam = params.get('add');
  useEffect(() => {
    if (qParam !== null) setQuery(qParam);
  }, [qParam]);
  useEffect(() => {
    if (addParam === 'true') {
      setEditing({ key: Date.now(), product: null });
      router.replace(qParam ? `${pathname}?q=${encodeURIComponent(qParam)}` : pathname, { scroll: false });
    }
  }, [addParam, qParam, pathname, router]);

  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((i) => m.set(i.category, (m.get(i.category) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((i) => category === 'All' || i.category === category)
      .filter(
        (i) =>
          !q ||
          i.name.toLowerCase().includes(q) ||
          i.sku.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q)
      )
      .sort(sorts[sort].fn);
  }, [items, query, category, sort]);

  const totalRevenue = items.reduce((s, i) => s + revenueOf(i), 0);
  const totalCost = items.reduce((s, i) => s + i.units * i.cost, 0);
  const avgMargin = totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0;
  const best = items.reduce<InventoryItem | null>((a, b) => (!a || revenueOf(b) > revenueOf(a) ? b : a), null);
  const growing = items.filter((i) => i.trend > 0).length;

  const takenNames = useMemo(
    () =>
      new Set(
        items.filter((i) => i.sku !== editing?.product?.sku).map((i) => i.name.toLowerCase())
      ),
    [items, editing]
  );

  const save = (v: ProductFormValues) => {
    const current = editing?.product;
    if (isLive()) {
      saveProduct(v, current ?? null)
        .then((r) => {
          setEditing(null);
          notify(r.message ?? (current ? 'Product updated' : 'Product added'));
        })
        .catch((e: unknown) => notify(errorMessage(e), true));
      return;
    }
    if (current) {
      setItems((prev) =>
        prev.map((i) =>
          i.sku === current.sku
            ? {
                ...i,
                ...v,
                // Keep the SKU unless the category (and so its prefix) changed.
                sku: v.category === i.category ? i.sku : makeSku(v.category, serial),
              }
            : i
        )
      );
      if (v.category !== current.category) setSerial((n) => n + 1);
    } else {
      setItems((prev) => [{ ...v, sku: makeSku(v.category, serial), units: 0, trend: 0 }, ...prev]);
      setSerial((n) => n + 1);
      setCategory('All');
      setQuery('');
    }
    setEditing(null);
  };

  const confirmDelete = () => {
    if (deleting && isLive()) {
      const d = deleting;
      setDeleting(null);
      archiveProduct(d)
        .then(() => notify(`${d.name} archived — its history is kept`))
        .catch((e: unknown) => notify(errorMessage(e), true));
      return;
    }
    if (deleting) setItems((prev) => prev.filter((i) => i.sku !== deleting.sku));
    setDeleting(null);
  };

  const exportCsv = () =>
    downloadCsv('products.csv', [
      ['SKU', 'Product', 'Category', 'Supplier', 'Price', 'Cost', 'Margin %', 'Units sold', 'Revenue', 'Stock', 'Trend %'],
      ...visible.map((i) => [
        i.sku,
        i.name,
        i.category,
        i.supplier,
        i.price,
        i.cost,
        marginOf(i).toFixed(1),
        i.units,
        revenueOf(i),
        i.stock,
        i.trend,
      ]),
    ]);

  const openEdit = (product: InventoryItem | null) => setEditing({ key: Date.now(), product });

  const chip = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-[12px] font-semibold border ${
      active ? 'gbv text-onbrand border-transparent' : 'border-line bg-surface text-sub hover:text-ink'
    }`;

  return (
    <div className="space-y-4 p-5 lg:p-6">
      <PageHead
        title="Products"
        sub={`${items.length} products · ${categoryCounts.length} categories · sales for ${isLive() ? 'the last 14 days' : '1 – 14 May 2024'}`}
      >
        <button onClick={() => setLabels({ key: Date.now(), skus: [] })} className="h-10 rounded-xl card px-4 font-semibold">
          Print labels
        </button>
        <MoreMenu
          items={[
            isLive() && can('products:write') && { label: 'Categories', hint: 'Departments and sub-categories', icon: FolderTree, onSelect: () => setManagingCategories(true) },
            isLive() && can('products:write') && { label: 'Import CSV', hint: 'Add or update many products', icon: Upload, onSelect: () => setImporting(true) },
            { label: 'Export CSV', hint: 'This list, as a spreadsheet', icon: Download, onSelect: exportCsv },
          ]}
        />
        <button
          onClick={() => openEdit(null)}
          className="flex h-10 items-center rounded-xl gbv px-5 font-semibold text-onbrand shadow-lg shadow-blue/25"
        >
          + Add new product
        </button>
      </PageHead>

      {/* Summary */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Best seller"
          value={best?.name ?? '—'}
          foot={best ? `${inr(revenueOf(best))} from ${best.units} units` : 'No sales yet'}
          brand
        />
        <SummaryCard label="Catalogue revenue" value={inr(totalRevenue)} foot={isLive() ? 'Last 14 days' : '1 – 14 May 2024'} />
        <SummaryCard label="Average margin" value={`${avgMargin.toFixed(1)}%`} foot={`${inr(totalRevenue - totalCost)} gross profit`} />
        <SummaryCard label="Growing products" value={`${growing} of ${items.length}`} foot="Sales up vs last period" />
      </section>

      {/* Catalogue */}
      <section className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, SKU or category…"
            aria-label="Search products"
            className="h-9 min-w-[200px] flex-1 rounded-xl border border-line bg-bg px-3 outline-none focus:border-blue"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort by"
            className="h-9 rounded-xl border border-line bg-surface px-3"
          >
            {(Object.keys(sorts) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                Sort: {sorts[k].label}
              </option>
            ))}
          </select>
          <div className="flex rounded-lg bg-bg p-0.5" role="radiogroup" aria-label="View">
            {(['list', 'grid'] as const).map((v) => (
              <button
                key={v}
                role="radio"
                aria-checked={view === v}
                onClick={() => setView(v)}
                className={`rounded-md px-3 py-1 text-[12px] capitalize ${
                  view === v ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-sub'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          <button className={chip(category === 'All')} onClick={() => setCategory('All')}>
            All <span className="opacity-70 tabular-nums">{items.length}</span>
          </button>
          {categoryCounts.map(([c, n]) => (
            <button key={c} className={chip(category === c)} onClick={() => setCategory(c)}>
              {c} <span className="opacity-70 tabular-nums">{n}</span>
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <div className="border-t border-line py-12 text-center text-sub">
            No products match{query ? ` “${query}”` : ' these filters'}.{' '}
            <button
              className="font-semibold text-blue"
              onClick={() => {
                setQuery('');
                setCategory('All');
              }}
            >
              Clear filters
            </button>
          </div>
        ) : view === 'list' ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
                  <th className="pb-2 font-medium">Product</th>
                  <th className="pb-2 font-medium">Category</th>
                  <th className="pb-2 font-medium text-right">Price</th>
                  <th className="hidden pb-2 font-medium text-right xl:table-cell">Margin</th>
                  <th className="pb-2 font-medium text-right">Sold</th>
                  <th className="pb-2 font-medium text-right">Revenue</th>
                  <th className="pb-2 !pl-3 font-medium">Stock</th>
                  <th className="hidden pb-2 font-medium xl:table-cell">Trend</th>
                  <th className="pb-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => (
                  <tr key={p.sku} className="h-[54px] border-t border-line">
                    <td>
                      <div className="font-semibold text-ink">{p.name}</div>
                      <div className="text-[11px] text-mute">
                        {p.sku} · {p.supplier}
                      </div>
                    </td>
                    <td>
                      <span className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${categoryPill(p.category)}`}>
                        {p.category}
                      </span>
                    </td>
                    <td className="text-right font-semibold tabular-nums text-ink">{inr(p.price)}</td>
                    <td className="hidden text-right tabular-nums text-sub xl:table-cell">{marginOf(p).toFixed(0)}%</td>
                    <td className="text-right tabular-nums">{p.units}</td>
                    <td className="text-right font-semibold tabular-nums text-ink">{inr(revenueOf(p))}</td>
                    <td className="!pl-3">
                      <StockBadge p={p} />
                    </td>
                    <td className="hidden xl:table-cell">
                      <Trend value={p.trend} />
                    </td>
                    <td>
                      <RowActions name={p.name} onEdit={() => openEdit(p)} onDelete={() => setDeleting(p)} onLabel={() => setLabels({ key: Date.now(), skus: [p.sku] })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {visible.map((p) => (
              <article key={p.sku} className="overflow-hidden rounded-2xl border border-line bg-surface">
                <div className="h-1" style={{ background: categoryColor(p.category) }} />
                <div className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${categoryPill(p.category)}`}>
                      {p.category}
                    </span>
                    <Trend value={p.trend} />
                  </div>
                  <h3 className="mt-3 font-bold text-[14px] text-ink">{p.name}</h3>
                  <div className="text-[11px] text-mute">
                    {p.sku} · {p.supplier}
                  </div>
                  <div className="mt-3 flex items-baseline justify-between">
                    <span className="text-[22px] font-extrabold tabular-nums text-ink">{inr(p.price)}</span>
                    <span className="text-[12px] text-sub">{marginOf(p).toFixed(0)}% margin</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-bg p-2.5 text-[12px]">
                    <div>
                      <div className="text-mute">Sold</div>
                      <div className="font-semibold tabular-nums text-ink">{p.units} units</div>
                    </div>
                    <div>
                      <div className="text-mute">Revenue</div>
                      <div className="font-semibold tabular-nums text-ink">{inr(revenueOf(p))}</div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <StockBadge p={p} />
                    <RowActions name={p.name} onEdit={() => openEdit(p)} onDelete={() => setDeleting(p)} onLabel={() => setLabels({ key: Date.now(), skus: [p.sku] })} />
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="mt-3 text-[12px] text-mute">
          Showing {visible.length} of {items.length} products
        </div>
      </section>

      {/* Add / edit */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="rounded-2xl border-line bg-surface text-ink">
          <DialogHeader>
            <DialogTitle className="text-[18px] font-extrabold">
              {editing?.product ? 'Edit product' : 'Add new product'}
            </DialogTitle>
            <DialogDescription className="text-sub">
              {editing?.product
                ? `${editing.product.sku}${isLive() ? '' : ' · changes are kept on this page until a backend is connected.'}`
                : isLive()
                  ? 'Saved to your catalogue on the server. Add opening stock on the Inventory page.'
                  : 'New products start with no sales. Changes are kept on this page until a backend is connected.'}
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <ProductForm
              key={editing.key}
              defaults={
                editing.product
                  ? {
                      name: editing.product.name,
                      category: editing.product.category,
                      supplier: editing.product.supplier,
                      price: editing.product.price,
                      cost: editing.product.cost,
                      stock: editing.product.stock,
                      taxRateId: isLive() ? taxIdOf(editing.product.sku) : undefined,
                    }
                  : emptyForm
              }
              takenNames={takenNames}
              submitLabel={editing.product ? 'Save changes' : 'Add product'}
              onSubmit={save}
              onCancel={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent className="rounded-2xl border-line bg-surface text-ink">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[18px] font-extrabold">Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription className="text-sub">
              It will be removed from the catalogue
              {deleting && deleting.stock > 0 ? `, along with ${deleting.stock} units of recorded stock` : ''}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="rounded-xl bg-coral text-onbrand hover:bg-coral/90">
              Delete product
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {notice}
      {labels && <LabelsDialog key={labels.key} open onClose={() => setLabels(null)} initial={labels.skus} />}
      {importing && <ImportProductsDialog open onClose={() => setImporting(false)} />}
      {managingCategories && <CategoriesDialog open onClose={() => setManagingCategories(false)} />}
    </div>
  );
}
