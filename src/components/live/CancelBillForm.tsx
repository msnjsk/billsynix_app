'use client';

import { useEffect, useState } from 'react';
import { Ban, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { errorMessage } from '@/lib/api/client';
import { can } from '@/lib/live/session';
import { approvers as loadApprovers, rupees, type Approver } from '@/lib/live/shift';

const REASONS = ['Wrong items billed', 'Duplicate bill', 'Customer didn’t pay / left', 'Wrong price or discount', 'Other'] as const;

/**
 * Cancels (voids) one of today's bills: stock goes back, the number stays on record as cancelled,
 * the payment is reversed. Cashiers need a manager to approve it with their counter PIN.
 */
export function CancelBillForm({
  invoiceNo,
  amount,
  storeId,
  run,
  onClose,
}: {
  invoiceNo: string;
  amount: number;
  storeId: string;
  run: (reason: string, approval?: { userId: string; pin: string }) => Promise<void>;
  onClose: () => void;
}) {
  const needsApproval = !can('sales:void');
  const [reason, setReason] = useState<(typeof REASONS)[number]>(REASONS[0]);
  const [other, setOther] = useState('');
  const [list, setList] = useState<Approver[] | null>(needsApproval ? null : []);
  const [approver, setApprover] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!needsApproval) return;
    loadApprovers(storeId)
      .then((l) => {
        setList(l);
        if (l[0]) setApprover(l[0].userId);
      })
      .catch((e) => {
        setList([]);
        setError(errorMessage(e));
      });
  }, [needsApproval, storeId]);

  const text = reason === 'Other' ? other.trim() : reason;
  const ready = !!text && (!needsApproval || (!!approver && /^\d{4}$/.test(pin)));

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      await run(text, needsApproval ? { userId: approver, pin } : undefined);
    } catch (e) {
      setError(errorMessage(e));
      setPin('');
      setBusy(false);
    }
  };

  const field = 'h-10 w-full rounded-xl border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-blue';

  return (
    <form
      className="space-y-4 text-[13px]"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-3 rounded-xl bg-coral/10 p-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-coral/15 text-coral">
          <Ban className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="font-bold text-ink">
            Cancel bill {invoiceNo} · {rupees(amount)}
          </div>
          <div className="text-[12px] text-sub">
            Items go back into stock and the payment is reversed. The bill number stays on record, marked CANCELLED.
          </div>
        </div>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-[12px] font-semibold text-sub">Why is it being cancelled?</legend>
        <div className="flex flex-wrap gap-1.5">
          {REASONS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReason(r)}
              className={`h-8 rounded-lg border px-3 text-[12px] font-semibold transition ${
                reason === r ? 'border-coral bg-coral/10 text-coral' : 'border-line text-sub hover:border-coral/50'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        {reason === 'Other' && (
          <input autoFocus value={other} onChange={(e) => setOther(e.target.value)} maxLength={200} placeholder="Reason" className={`${field} mt-2`} />
        )}
      </fieldset>

      {needsApproval && (
        <div className="space-y-2 rounded-xl border border-line p-3">
          <div className="flex items-center gap-2 font-semibold text-ink">
            <ShieldCheck className="size-4 text-blue" aria-hidden="true" /> Manager approval
          </div>
          {list === null ? (
            <div className="flex items-center gap-2 text-sub">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Finding managers…
            </div>
          ) : list.length === 0 ? (
            <p className="text-[12px] text-amber">
              No manager at this branch has a counter PIN set. A manager can set one on the Staff page, or sign in and cancel it themselves.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
              <label className="text-[12px] text-sub">
                Manager
                <select value={approver} onChange={(e) => setApprover(e.target.value)} className={`${field} mt-1`}>
                  {list.map((a) => (
                    <option key={a.userId} value={a.userId}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[12px] text-sub">
                Their PIN
                <span className="relative mt-1 block">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" aria-hidden="true" />
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={4}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="••••"
                    className={`${field} pl-9 tracking-[0.4em]`}
                  />
                </span>
              </label>
            </div>
          )}
        </div>
      )}

      {error && <p className="rounded-xl bg-coral/10 px-3 py-2 text-[12.5px] text-coral">{error}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-10 rounded-xl border border-line px-4 font-semibold hover:bg-bg">
          Keep bill
        </button>
        <button
          type="submit"
          disabled={!ready || busy}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-coral px-4 font-semibold text-onbrand disabled:opacity-50"
        >
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          Cancel bill
        </button>
      </div>
    </form>
  );
}
