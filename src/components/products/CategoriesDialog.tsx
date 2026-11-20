'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, CornerDownRight, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { api, errorMessage } from '@/lib/api/client';
import type { Category } from '@/lib/api/types';
import { reload } from '@/lib/live/hydrate';
import { Badge, Btn, ErrorLine, Loading, Modal, fieldCls } from '@/components/live/kit';

/** The server allows three levels: Department › Category › Sub-category. */
const MAX_DEPTH = 3;

type Node = Category & { children: Node[]; depth: number };

function tree(all: Category[]): Node[] {
  const byParent = new Map<string | null, Category[]>();
  for (const c of all) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
  const build = (parent: string | null, depth: number): Node[] =>
    (byParent.get(parent) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ ...c, depth, children: build(c.id, depth + 1) }));
  return build(null, 1);
}

/**
 * Product categories (connected mode): add departments and sub-categories, rename them, switch
 * them off or delete unused ones. Products keep their category; an inactive one just isn't offered.
 */
export function CategoriesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [cats, setCats] = useState<Category[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<{ parentId: string | null } | null>(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const load = useCallback(() => {
    api<{ data: Category[] }>('GET', '/categories', { query: { includeInactive: 'true' } })
      .then((r) => setCats(r.data))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  const nodes = useMemo(() => (cats ? tree(cats) : []), [cats]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      setChanged(true);
      load();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    const n = name.trim();
    if (!n || !adding) return;
    if (await run('add', () => api('POST', '/categories', { body: { name: n, ...(adding.parentId ? { parentId: adding.parentId } : {}) } }))) {
      setName('');
      setAdding(null);
    }
  };

  const close = () => {
    // The product form and filters read the category list loaded at sign-in: refresh it.
    if (changed) void reload();
    onClose();
  };

  const row = (c: Node) => (
    <li key={c.id}>
      <div className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-bg ${c.isActive ? '' : 'opacity-60'}`} style={{ paddingLeft: `${(c.depth - 1) * 22 + 8}px` }}>
        {c.depth > 1 ? <CornerDownRight className="size-3.5 shrink-0 text-mute" /> : <ChevronRight className="size-3.5 shrink-0 text-mute" />}
        {editing?.id === c.id ? (
          <form
            className="flex flex-1 gap-1.5"
            onSubmit={async (e) => {
              e.preventDefault();
              const n = editing.name.trim();
              if (n && n !== c.name && (await run(`ren:${c.id}`, () => api('PATCH', `/categories/${c.id}`, { body: { name: n } })))) setEditing(null);
              else if (n === c.name) setEditing(null);
            }}
          >
            <input autoFocus value={editing.name} onChange={(e) => setEditing({ id: c.id, name: e.target.value })} maxLength={60} className={`${fieldCls} h-8`} aria-label={`New name for ${c.name}`} />
            <Btn size="sm" tone="primary" type="submit" busy={busy === `ren:${c.id}`}>
              Save
            </Btn>
            <Btn size="sm" tone="quiet" onClick={() => setEditing(null)}>
              Cancel
            </Btn>
          </form>
        ) : (
          <>
            <span className={`flex-1 truncate ${c.depth === 1 ? 'font-semibold' : ''}`}>{c.name}</span>
            {!c.isActive && <Badge tone="mute">Off</Badge>}
            <span className="flex gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
              {c.depth < MAX_DEPTH && c.isActive && (
                <Btn size="sm" tone="quiet" title="Add a sub-category" onClick={() => { setAdding({ parentId: c.id }); setName(''); }}>
                  <FolderPlus className="size-3.5" /> Sub
                </Btn>
              )}
              <Btn size="sm" tone="quiet" title="Rename" aria-label={`Rename ${c.name}`} onClick={() => setEditing({ id: c.id, name: c.name })}>
                <Pencil className="size-3.5" />
              </Btn>
              <Btn
                size="sm"
                tone="quiet"
                busy={busy === `act:${c.id}`}
                onClick={() => void run(`act:${c.id}`, () => api('PATCH', `/categories/${c.id}`, { body: { isActive: !c.isActive } }))}
              >
                {c.isActive ? 'Switch off' : 'Switch on'}
              </Btn>
              <Btn
                size="sm"
                tone="quiet"
                title="Delete (only if no product uses it)"
                aria-label={`Delete ${c.name}`}
                busy={busy === `del:${c.id}`}
                onClick={() => {
                  if (window.confirm(`Delete “${c.name}”? This works only if no product or sub-category uses it.`))
                    void run(`del:${c.id}`, () => api('DELETE', `/categories/${c.id}`));
                }}
              >
                <Trash2 className="size-3.5 text-coral" />
              </Btn>
            </span>
          </>
        )}
      </div>
      {adding?.parentId === c.id && addForm(c.name)}
      {c.children.length > 0 && <ul>{c.children.map(row)}</ul>}
    </li>
  );

  const addForm = (under?: string) => (
    <form
      className="my-1 flex gap-1.5 rounded-xl bg-blue/5 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={60}
        placeholder={under ? `New sub-category under ${under}` : 'New department, e.g. Dry fruits'}
        aria-label="New category name"
        className={`${fieldCls} h-9`}
      />
      <Btn tone="primary" type="submit" disabled={!name.trim()} busy={busy === 'add'}>
        Add
      </Btn>
      <Btn tone="quiet" onClick={() => setAdding(null)}>
        Cancel
      </Btn>
    </form>
  );

  return (
    <Modal open={open} onClose={close} wide title="Categories" sub="Departments and their sub-categories (up to three levels), used on products, reports and the POS.">
      <div className="space-y-3">
        <div className="flex justify-end">
          <Btn tone="primary" size="sm" onClick={() => { setAdding({ parentId: null }); setName(''); }}>
            <FolderPlus className="size-4" /> New department
          </Btn>
        </div>
        {adding?.parentId === null && addForm()}
        <ErrorLine>{error}</ErrorLine>
        {cats === null ? (
          <Loading />
        ) : !nodes.length ? (
          <p className="rounded-xl bg-bg px-4 py-8 text-center text-sm text-sub">No categories yet. Add a department such as “Grocery”, then sub-categories like “Atta & flour”.</p>
        ) : (
          <ul className="max-h-[55vh] overflow-auto rounded-xl border border-line p-1">{nodes.map(row)}</ul>
        )}
        <p className="text-xs text-mute">Switching a category off hides it from new products; products already in it keep it. Delete works only for unused categories.</p>
        <div className="flex justify-end border-t border-line pt-3">
          <Btn onClick={close}>Done</Btn>
        </div>
      </div>
    </Modal>
  );
}
