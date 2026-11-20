'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Search, Tags, X } from 'lucide-react';
import { errorMessage } from '@/lib/api/client';
import { can } from '@/lib/live/session';
import { stores, useBranches } from '@/lib/branch-data';
import {
  assignPriceList,
  createPriceList,
  listPriceLists,
  liveProducts,
  pricesOf,
  removePrice,
  setPrices,
  type ListPrice,
  type PriceList,
} from '@/lib/live/stockops';
import { Badge, Btn, Empty, ErrorLine, Loading, Modal, fieldCls, fieldFixed, inr2, labelCls } from '@/components/live/kit';

const PAGE = 50;

/**
 * Branch pricing (connected mode): a price list holds the prices that differ from the catalogue;
 * a branch uses one list (or the catalogue prices). Prices never go above MRP.
 */
export function LivePriceLists() {
  const branches = useBranches();
  const shops = stores(branches);
  const editable = can('prices:write');
  const [lists, setLists] = useState<PriceList[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);

  const load = useCallback(() => {
    listPriceLists()
      .then((l) => {
        setLists(l);
        setSelected((s) => s ?? l[0]?.id ?? null);
      })
      .catch((e) => {
        setLists([]);
        setError(errorMessage(e));
      });
  }, []);
  useEffect(load, [load]);

  const current = lists?.find((l) => l.id === selected) ?? lists?.[0];
  const listOf = (storeId: string) => lists?.find((l) => l.storeIds.includes(storeId));

  const assign = async (storeId: string, priceListId: string) => {
    setAssigning(storeId);
    setError('');
    try {
      await assignPriceList(storeId, priceListId || null);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAssigning(null);
    }
  };

  if (lists === null)
    return (
      <div className="card">
        <Loading />
      </div>
    );

  return (
    <div className="space-y-4">
      <ErrorLine>{error}</ErrorLine>
      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <div className="space-y-4">
          <section className="card p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">Price lists</h3>
              {editable && (
                <Btn size="sm" tone="primary" onClick={() => setCreating(true)}>
                  <Plus className="size-4" /> New list
                </Btn>
              )}
            </div>
            {!lists.length ? (
              <p className="mt-3 text-sm text-sub">Every branch sells at the catalogue price. Create a price list to sell some products cheaper at a branch.</p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {lists.map((l) => (
                  <li key={l.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(l.id)}
                      className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition ${
                        current?.id === l.id ? 'border-blue bg-blue/5' : 'border-line hover:border-blue/40'
                      }`}
                    >
                      <Tags className="size-4 text-blue" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{l.name}</span>
                        <span className="block truncate text-xs text-mute">
                          {l.storeIds.length ? shops.filter((s) => l.storeIds.includes(s.id)).map((s) => s.name).join(', ') : 'Not used by any branch'}
                        </span>
                      </span>
                      {!l.isActive && <Badge tone="mute">Off</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-4">
            <h3 className="font-bold">Which prices each branch uses</h3>
            <ul className="mt-3 space-y-2">
              {shops.map((s) => (
                <li key={s.id} className="flex items-center gap-3 text-sm">
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <select
                    value={listOf(s.id)?.id ?? ''}
                    disabled={!editable || assigning === s.id}
                    onChange={(e) => void assign(s.id, e.target.value)}
                    className={`${fieldFixed} h-9 w-44`}
                    aria-label={`Price list for ${s.name}`}
                  >
                    <option value="">Catalogue prices</option>
                    {lists
                      .filter((l) => l.isActive)
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                  </select>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className="card overflow-hidden">
          {current ? <ListEditor key={current.id} list={current} editable={editable} /> : <Empty>Create a price list to set branch prices.</Empty>}
        </section>
      </div>

      {creating && (
        <NewList
          onClose={() => setCreating(false)}
          onCreated={(l) => {
            setCreating(false);
            setSelected(l.id);
            load();
          }}
        />
      )}
    </div>
  );
}

function ListEditor({ list, editable }: { list: PriceList; editable: boolean }) {
  const products = useMemo(liveProducts, []);
  const [prices, setPricesState] = useState<Map<string, ListPrice> | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [onlySet, setOnlySet] = useState(false);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    pricesOf(list.id)
      .then((p) => setPricesState(new Map(p.map((x) => [x.productId, x]))))
      .catch((e) => setError(errorMessage(e)));
  }, [list.id]);
  useEffect(load, [load]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return products.filter((p) => (!s || p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s)) && (!onlySet || prices?.has(p.id) || p.id in edits));
  }, [products, q, onlySet, prices, edits]);
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));

  const problems = Object.entries(edits).filter(([id, v]) => {
    const p = products.find((x) => x.id === id);
    const n = Number(v);
    return !v || Number.isNaN(n) || n <= 0 || (p?.mrp ? n > Number(p.mrp) : false);
  });
  const dirty = Object.keys(edits).length;

  const save = async () => {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const items = Object.entries(edits).map(([productId, v]) => ({ productId, sellingPrice: Number(v) }));
      for (let i = 0; i < items.length; i += 500) await setPrices(list.id, items.slice(i, i + 500));
      setEdits({});
      setMsg(`${items.length} price${items.length === 1 ? '' : 's'} saved.`);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (productId: string) => {
    setError('');
    try {
      await removePrice(list.id, productId);
      setEdits(({ [productId]: _, ...rest }) => rest);
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-bold">{list.name}</h3>
          <p className="text-xs text-mute">
            {prices ? `${prices.size} product${prices.size === 1 ? '' : 's'} priced differently` : 'Loading…'} · blank = catalogue price
          </p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" />
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
            placeholder="Find product"
            className={`${fieldFixed} h-9 w-56 pl-9`}
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-sub">
          <input
            type="checkbox"
            checked={onlySet}
            onChange={(e) => {
              setOnlySet(e.target.checked);
              setPage(0);
            }}
            className="accent-[var(--blue)]"
          />
          Only list prices
        </label>
      </div>
      {!prices ? (
        <Loading />
      ) : !shown.length ? (
        <Empty>No products match.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-bg/60 text-left text-xs uppercase tracking-wide text-mute">
              <tr>
                <th className="px-4! py-2.5!">Product</th>
                <th className="px-4! py-2.5! text-right">MRP</th>
                <th className="px-4! py-2.5! text-right">Catalogue</th>
                <th className="px-4! py-2.5! text-right">This list</th>
                <th className="px-4! py-2.5!" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((p) => {
                const set = prices.get(p.id);
                const v = edits[p.id] ?? (set ? String(Number(set.sellingPrice)) : '');
                const n = Number(v);
                const bad = p.id in edits && (!v || n <= 0 || (p.mrp ? n > Number(p.mrp) : false));
                const saving = v && n > 0 ? Number(p.sellingPrice) - n : 0;
                return (
                  <tr key={p.id} className={set || p.id in edits ? '' : 'text-sub'}>
                    <td className="px-4! py-2!">
                      <div className="font-medium text-ink">{p.name}</div>
                      <div className="text-xs text-mute">{p.sku}</div>
                    </td>
                    <td className="px-4! py-2! text-right tabular-nums">{p.mrp ? inr2(p.mrp) : '—'}</td>
                    <td className="px-4! py-2! text-right tabular-nums">{inr2(p.sellingPrice)}</td>
                    <td className="px-4! py-2! text-right">
                      {editable ? (
                        <input
                          value={v}
                          inputMode="decimal"
                          placeholder="—"
                          onChange={(e) => {
                            const x = e.target.value.replace(/[^\d.]/g, '');
                            setEdits((s) => {
                              if (!x && !set) {
                                const { [p.id]: _, ...rest } = s;
                                return rest;
                              }
                              return { ...s, [p.id]: x };
                            });
                          }}
                          aria-label={`Price of ${p.name} in ${list.name}`}
                          className={`h-8 w-24 rounded-lg border bg-surface px-2 text-right tabular-nums outline-none focus:border-blue ${bad ? 'border-coral' : 'border-line'}`}
                        />
                      ) : (
                        <span className="tabular-nums">{set ? inr2(set.sellingPrice) : '—'}</span>
                      )}
                      {saving > 0 && <div className="text-[11px] text-teal">{inr2(saving)} less</div>}
                    </td>
                    <td className="px-4! py-2! text-right">
                      {editable && set && (
                        <button type="button" onClick={() => void clear(p.id)} title="Back to the catalogue price" className="text-mute hover:text-coral">
                          <X className="size-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-sm">
        <div className="flex items-center gap-2 text-sub">
          <Btn size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ‹
          </Btn>
          Page {page + 1} of {pages}
          <Btn size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
            ›
          </Btn>
        </div>
        <div className="flex items-center gap-2">
          {problems.length > 0 && <span className="text-xs text-coral">{problems.length} price{problems.length === 1 ? '' : 's'} above MRP or blank</span>}
          {msg && <span className="text-xs text-teal">{msg}</span>}
          {editable && (
            <>
              {dirty > 0 && (
                <Btn size="sm" tone="quiet" onClick={() => setEdits({})}>
                  Discard
                </Btn>
              )}
              <Btn tone="primary" size="sm" disabled={!dirty || problems.length > 0} busy={busy} onClick={() => void save()}>
                Save {dirty || ''} price{dirty === 1 ? '' : 's'}
              </Btn>
            </>
          )}
        </div>
      </div>
      <div className="px-4 pb-3">
        <ErrorLine>{error}</ErrorLine>
      </div>
    </div>
  );
}

function NewList({ onClose, onCreated }: { onClose: () => void; onCreated: (l: PriceList) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal open onClose={onClose} title="New price list" sub="Then set the prices that differ and pick which branches use it.">
      <label className={labelCls}>
        Name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Anna Nagar prices" className={`${fieldCls} mt-1`} />
      </label>
      <ErrorLine>{error}</ErrorLine>
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn
          tone="primary"
          disabled={!name.trim()}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              onCreated(await createPriceList(name.trim()));
            } catch (e) {
              setError(errorMessage(e));
              setBusy(false);
            }
          }}
        >
          Create
        </Btn>
      </div>
    </Modal>
  );
}
