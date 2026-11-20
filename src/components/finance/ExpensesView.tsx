'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Download, Plus, ReceiptIndianRupee, Tags, Wallet } from 'lucide-react';
import { PageHead, downloadCsv } from '@/components/AppShell';
import { errorMessage } from '@/lib/api/client';
import { can, isLive } from '@/lib/live/session';
import { currentStoreId } from '@/lib/live/hydrate';
import { stores, useBranches } from '@/lib/branch-data';
import { TODAY } from '@/lib/suppliers-data';
import {
  PAY_MODE_LABEL,
  addExpense,
  addExpenseCategory,
  expenseCategories,
  listExpenses,
  voidExpense,
  type Expense,
  type ExpenseCategory,
  type PayMode,
} from '@/lib/live/stockops';
import { Badge, Blocked, Btn, Empty, ErrorLine, Loading, Modal, dayFmt, fieldCls, fieldFixed, inr2, labelCls } from '@/components/live/kit';

const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;

/** Running costs other than stock: rent, salaries, power, transport… */
export function ExpensesView() {
  const branches = useBranches();
  const shops = stores(branches);
  const allowed = isLive() && can('expenses:write');

  const [from, setFrom] = useState(monthStart(TODAY));
  const [to, setTo] = useState(TODAY);
  const [storeId, setStoreId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [rows, setRows] = useState<Expense[] | null>(null);
  const [cats, setCats] = useState<ExpenseCategory[]>([]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<Expense | null>(null);

  const load = useCallback(async () => {
    if (!allowed || from > to) return;
    setError('');
    try {
      const [e, c] = await Promise.all([
        listExpenses({ from, to, ...(storeId ? { storeId } : {}), ...(categoryId ? { categoryId } : {}) }),
        expenseCategories(),
      ]);
      setRows(e.data);
      setCats(c);
    } catch (err) {
      setError(errorMessage(err));
      setRows([]);
    }
  }, [allowed, from, to, storeId, categoryId]);
  useEffect(() => {
    void load();
  }, [load]);

  const recorded = useMemo(() => (rows ?? []).filter((r) => r.status === 'RECORDED'), [rows]);
  const total = recorded.reduce((s, r) => s + Number(r.amount), 0);
  const gst = recorded.reduce((s, r) => s + Number(r.gstAmount), 0);
  const byCat = useMemo(() => {
    const m = new Map<string, number>();
    recorded.forEach((r) => m.set(r.category.name, (m.get(r.category.name) ?? 0) + Number(r.amount)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [recorded]);
  const branchName = (id: string) => shops.find((b) => b.id === id)?.name ?? '';

  const exportCsv = () =>
    downloadCsv(`expenses_${from}_to_${to}.csv`, [
      ['No', 'Date', 'Branch', 'Category', 'Payee', 'Paid by', 'Reference', 'Amount', 'GST', 'Status', 'Note'],
      ...(rows ?? []).map((r) => [r.number, r.spentOn, branchName(r.storeId), r.category.name, r.payee ?? '', PAY_MODE_LABEL[r.mode], r.reference ?? '', r.amount, r.gstAmount, r.status, r.note ?? '']),
    ]);

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageHead title="Expenses" sub="Rent, salaries, electricity, transport and other running costs">
        {allowed && (
          <>
            <Btn onClick={exportCsv} disabled={!rows?.length}>
              <Download className="size-4" /> Export CSV
            </Btn>
            <Btn tone="primary" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Add expense
            </Btn>
          </>
        )}
      </PageHead>

      {!isLive() ? (
        <Blocked kind="offline" />
      ) : !allowed ? (
        <Blocked kind="denied">Recording expenses needs the “Record expenses” permission.</Blocked>
      ) : (
        <>
          <section className="card flex flex-wrap items-end gap-3 p-4">
            <label className={labelCls}>
              From
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={`${fieldFixed} mt-1 h-9 w-40`} />
            </label>
            <label className={labelCls}>
              To
              <input type="date" value={to} min={from} max={TODAY} onChange={(e) => setTo(e.target.value)} className={`${fieldFixed} mt-1 h-9 w-40`} />
            </label>
            {shops.length > 1 && (
              <label className={labelCls}>
                Branch
                <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={`${fieldFixed} mt-1 h-9 w-44`}>
                  <option value="">All branches</option>
                  {shops.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className={labelCls}>
              Category
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={`${fieldFixed} mt-1 h-9 w-44`}>
                <option value="">All categories</option>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <ErrorLine>{error}</ErrorLine>

          <section className="grid gap-3 sm:grid-cols-3">
            <Stat icon={<Wallet className="size-5" />} label="Spent" value={inr2(total)} sub={`${recorded.length} expense${recorded.length === 1 ? '' : 's'}`} />
            <Stat icon={<ReceiptIndianRupee className="size-5" />} label="GST on bills" value={inr2(gst)} sub="May be claimable as input tax" />
            <Stat icon={<Tags className="size-5" />} label="Biggest category" value={byCat[0]?.[0] ?? '—'} sub={byCat[0] ? inr2(byCat[0][1]) : 'Nothing yet'} />
          </section>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <section className="card overflow-hidden">
              {rows === null ? (
                <Loading />
              ) : !rows.length ? (
                <Empty>No expenses in this period. Add rent, salaries, power bills and other costs to see your true profit.</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-bg/60 text-left text-xs uppercase tracking-wide text-mute">
                      <tr>
                        <th className="px-4! py-2.5!">Date</th>
                        <th className="px-4! py-2.5!">Category</th>
                        <th className="px-4! py-2.5!">Paid to</th>
                        <th className="px-4! py-2.5!">Paid by</th>
                        <th className="px-4! py-2.5! text-right">GST</th>
                        <th className="px-4! py-2.5! text-right">Amount</th>
                        <th className="px-4! py-2.5!" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {rows.map((r) => (
                        <tr key={r.id} className={r.status === 'VOIDED' ? 'text-mute' : ''}>
                          <td className="px-4! py-3! whitespace-nowrap">
                            <div>{dayFmt(r.spentOn)}</div>
                            <div className="font-mono text-[11px] text-mute">{r.number}</div>
                          </td>
                          <td className="px-4! py-3!">
                            <div className="font-medium">{r.category.name}</div>
                            {shops.length > 1 && <div className="text-xs text-mute">{branchName(r.storeId)}</div>}
                          </td>
                          <td className="px-4! py-3!">
                            <div>{r.payee ?? '—'}</div>
                            {r.note && <div className="max-w-[220px] truncate text-xs text-mute">{r.note}</div>}
                          </td>
                          <td className="px-4! py-3!">
                            {PAY_MODE_LABEL[r.mode]}
                            {r.cashSessionId && <div className="text-xs text-mute">From drawer</div>}
                            {r.reference && <div className="text-xs text-mute">{r.reference}</div>}
                          </td>
                          <td className="px-4! py-3! text-right tabular-nums">{Number(r.gstAmount) ? inr2(r.gstAmount) : '—'}</td>
                          <td className={`px-4! py-3! text-right font-semibold tabular-nums ${r.status === 'VOIDED' ? 'line-through' : ''}`}>{inr2(r.amount)}</td>
                          <td className="px-4! py-3! text-right">
                            {r.status === 'VOIDED' ? (
                              <span title={r.voided?.reason}>
                                <Badge tone="mute">Voided</Badge>
                              </span>
                            ) : (
                              <Btn size="sm" tone="quiet" onClick={() => setVoiding(r)}>
                                Void
                              </Btn>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="card p-4">
              <h3 className="font-bold">By category</h3>
              {!byCat.length ? (
                <p className="mt-3 text-sm text-sub">Nothing spent in this period.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {byCat.map(([name, v]) => (
                    <li key={name}>
                      <div className="flex justify-between text-sm">
                        <span>{name}</span>
                        <span className="font-semibold tabular-nums">{inr2(v)}</span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-bg">
                        <div className="h-2 rounded-full bg-blue" style={{ width: `${Math.max(3, (v / byCat[0]![1]) * 100)}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}

      {adding && (
        <AddExpense
          shops={shops.map((s) => ({ id: s.id, name: s.name }))}
          cats={cats}
          onCats={setCats}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
      {voiding && (
        <VoidExpense
          e={voiding}
          onClose={() => setVoiding(null)}
          onDone={() => {
            setVoiding(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

const SUGGESTED = ['Rent', 'Salaries & wages', 'Electricity', 'Transport & delivery', 'Packaging', 'Repairs & maintenance', 'Internet & phone', 'Tea & refreshments'];

function AddExpense({
  shops,
  cats,
  onCats,
  onClose,
  onSaved,
}: {
  shops: { id: string; name: string }[];
  cats: ExpenseCategory[];
  onCats: (c: ExpenseCategory[]) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const active = cats.filter((c) => c.isActive);
  const [storeId, setStoreId] = useState(currentStoreId() || shops[0]?.id || '');
  const [categoryId, setCategoryId] = useState('');
  const [newCat, setNewCat] = useState(active.length ? '' : SUGGESTED[0]!);
  const [spentOn, setSpentOn] = useState(TODAY);
  const [amount, setAmount] = useState('');
  const [gstAmount, setGst] = useState('');
  const [mode, setMode] = useState<PayMode>('CASH');
  const [fromDrawer, setFromDrawer] = useState(false);
  const [payee, setPayee] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const creating = !active.length || categoryId === 'new';

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      let cat = categoryId;
      if (creating) {
        const c = await addExpenseCategory(newCat.trim());
        onCats([...cats, c]);
        cat = c.id;
      }
      await addExpense({ storeId, categoryId: cat, spentOn, amount: Number(amount), gstAmount: Number(gstAmount || 0), mode, payee, reference, note, fromDrawer: mode === 'CASH' && fromDrawer });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const ok = (creating || !!categoryId) && Number(amount) > 0 && Number(gstAmount || 0) <= Number(amount) && (!creating || newCat.trim()) && storeId;

  return (
    <Modal open onClose={onClose} title="Add expense" sub="Money spent on running the business — not stock (that goes in Purchases).">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) void save();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelCls}>
            Category
            {active.length > 0 ? (
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={`${fieldCls} mt-1`}>
                <option value="" disabled>
                  Choose…
                </option>
                {active.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value="new">+ New category…</option>
              </select>
            ) : (
              <select value={newCat} onChange={(e) => setNewCat(e.target.value)} className={`${fieldCls} mt-1`}>
                {SUGGESTED.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            )}
          </label>
          {categoryId === 'new' ? (
            <label className={labelCls}>
              New category name
              <input autoFocus value={newCat} onChange={(e) => setNewCat(e.target.value)} maxLength={60} className={`${fieldCls} mt-1`} placeholder="e.g. Rent" />
            </label>
          ) : (
            <label className={labelCls}>
              Date
              <input type="date" value={spentOn} max={TODAY} onChange={(e) => setSpentOn(e.target.value)} className={`${fieldCls} mt-1`} />
            </label>
          )}
          <label className={labelCls}>
            Amount (incl. GST)
            <input inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} className={`${fieldCls} mt-1`} placeholder="₹0.00" />
          </label>
          <label className={labelCls}>
            GST on the bill <span className="font-normal text-mute">(optional)</span>
            <input inputMode="decimal" value={gstAmount} onChange={(e) => setGst(e.target.value.replace(/[^\d.]/g, ''))} className={`${fieldCls} mt-1`} placeholder="₹0.00" />
          </label>
          <label className={labelCls}>
            Paid by
            <select value={mode} onChange={(e) => setMode(e.target.value as PayMode)} className={`${fieldCls} mt-1`}>
              {(Object.keys(PAY_MODE_LABEL) as PayMode[]).map((m) => (
                <option key={m} value={m}>
                  {PAY_MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Paid to
            <input value={payee} onChange={(e) => setPayee(e.target.value)} maxLength={100} className={`${fieldCls} mt-1`} placeholder="e.g. TNEB, landlord" />
          </label>
          {mode !== 'CASH' && (
            <label className={labelCls}>
              Reference
              <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} className={`${fieldCls} mt-1`} placeholder="UTR / cheque no." />
            </label>
          )}
          {shops.length > 1 && (
            <label className={labelCls}>
              Branch
              <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={`${fieldCls} mt-1`}>
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {categoryId === 'new' && (
          <label className={labelCls}>
            Date
            <input type="date" value={spentOn} max={TODAY} onChange={(e) => setSpentOn(e.target.value)} className={`${fieldCls} mt-1 sm:w-1/2`} />
          </label>
        )}
        <label className={labelCls}>
          Note
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={`${fieldCls} mt-1`} placeholder="Optional" />
        </label>
        {mode === 'CASH' && (
          <label className="flex items-start gap-2 rounded-xl bg-bg p-3 text-sm">
            <input type="checkbox" checked={fromDrawer} onChange={(e) => setFromDrawer(e.target.checked)} className="mt-0.5 accent-[var(--blue)]" />
            <span>
              <b>Paid from my cash drawer</b>
              <span className="block text-xs text-sub">Takes the cash out of your open drawer so it still adds up at closing.</span>
            </span>
          </label>
        )}
        <ErrorLine>{error}</ErrorLine>
        <div className="flex justify-end gap-2 pt-1">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn tone="primary" type="submit" disabled={!ok} busy={busy}>
            Save {Number(amount) > 0 ? inr2(amount) : 'expense'}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}

function VoidExpense({ e, onClose, onDone }: { e: Expense; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal open onClose={onClose} title={`Void ${e.number}?`} sub={`${e.category.name} · ${inr2(e.amount)} on ${dayFmt(e.spentOn)}. It stays on record, marked voided.`}>
      <input autoFocus value={reason} onChange={(x) => setReason(x.target.value)} maxLength={200} placeholder="Why? (required)" className={fieldCls} />
      <ErrorLine>{error}</ErrorLine>
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>Keep it</Btn>
        <Btn
          tone="danger"
          disabled={!reason.trim()}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await voidExpense(e.id, reason.trim());
              onDone();
            } catch (x) {
              setError(errorMessage(x));
              setBusy(false);
            }
          }}
        >
          Void expense
        </Btn>
      </div>
    </Modal>
  );
}

function Stat({ icon, label, value, sub }: { icon: ReactNode; label: string; value: string; sub: string }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-blue/10 text-blue">{icon}</span>
        <span className="text-sm font-semibold text-sub">{label}</span>
      </div>
      <div className="mt-3 truncate text-[24px] font-extrabold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-mute">{sub}</div>
    </div>
  );
}
