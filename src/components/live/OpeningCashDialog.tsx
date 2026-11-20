'use client';

import { useEffect, useState } from 'react';
import { ArrowLeftRight, Wallet } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { answerCloseOtherDrawer, answerOpeningFloat, useCloseOtherDrawerRequest, useOpeningFloatRequest } from '@/lib/live/ask';

/** Asks for the cash in the drawer when a cashier's first sale opens their drawer. */
export function OpeningCashDialog() {
  const open = useOpeningFloatRequest();
  const [value, setValue] = useState('');
  useEffect(() => {
    if (open) setValue('');
  }, [open]);
  const amount = Number(value.replace(/[₹,\s]/g, '') || '0');
  const valid = Number.isFinite(amount) && amount >= 0 && amount <= 10_000_000;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && answerOpeningFloat(null)}>
      <DialogContent className="rounded-2xl border-line bg-surface text-ink sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[18px] font-extrabold">
            <Wallet className="size-5 text-blue" /> Open the cash drawer
          </DialogTitle>
          <DialogDescription className="text-sub">Count the cash in the drawer before the first bill. Closing the drawer later compares it with what you count then.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) answerOpeningFloat(Math.round(amount * 100) / 100);
          }}
          className="space-y-4"
        >
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-semibold text-ink">Opening cash (₹)</span>
            <input
              autoFocus
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0"
              className={`h-12 w-full rounded-xl border bg-surface px-3 text-[18px] font-bold tabular-nums text-ink outline-none focus:border-blue ${valid ? 'border-line' : 'border-coral'}`}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => answerOpeningFloat(null)} className="h-10 rounded-xl border border-line px-4 font-semibold text-ink hover:border-blue">
              Cancel
            </button>
            <button type="submit" disabled={!valid} className="h-10 rounded-xl gbv px-5 font-semibold text-onbrand disabled:opacity-50">
              Open drawer
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * A cashier may have one drawer open at a time. Billing on a counter while their drawer is still
 * open on another one asks them to count and close that one first (it's closed with what they count).
 */
export function CloseOtherDrawerDialog() {
  const drawer = useCloseOtherDrawerRequest();
  const [value, setValue] = useState('');
  useEffect(() => {
    if (drawer) setValue(drawer.expectedCash.toFixed(2));
  }, [drawer]);
  const amount = Number(value.replace(/[₹,\s]/g, '') || 'NaN');
  const valid = Number.isFinite(amount) && amount >= 0 && amount <= 10_000_000;
  const diff = valid && drawer ? Math.round((amount - drawer.expectedCash) * 100) / 100 : 0;
  const opened = drawer
    ? new Date(drawer.openedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : '';

  return (
    <Dialog open={drawer !== null} onOpenChange={(o) => !o && answerCloseOtherDrawer(null)}>
      <DialogContent className="rounded-2xl border-line bg-surface text-ink sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[18px] font-extrabold">
            <ArrowLeftRight className="size-5 text-amber" /> {drawer?.owner ? 'This counter’s drawer is in use' : 'Your drawer is open elsewhere'}
          </DialogTitle>
          <DialogDescription className="text-sub">
            {drawer?.owner ? (
              <>
                <b className="text-ink">{drawer.owner}</b> has a cash drawer open on <b className="text-ink">{drawer.where}</b> (since {opened}). Count the cash in it and close it for them
                to start your own drawer here.
              </>
            ) : (
              <>
                You still have a cash drawer open on <b className="text-ink">{drawer?.where}</b> (since {opened}). Count it and close it to start billing on{' '}
                <b className="text-ink">{drawer?.here}</b>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) answerCloseOtherDrawer(Math.round(amount * 100) / 100);
          }}
          className="space-y-4"
        >
          <div className="flex items-center justify-between rounded-xl bg-bg px-3 py-2.5 text-[13px]">
            <span className="text-sub">Expected in that drawer</span>
            <span className="font-bold tabular-nums text-ink">{drawer ? inr(drawer.expectedCash) : ''}</span>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-semibold text-ink">Cash counted in it (₹)</span>
            <input
              autoFocus
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => e.target.select()}
              className={`h-12 w-full rounded-xl border bg-surface px-3 text-[18px] font-bold tabular-nums text-ink outline-none focus:border-blue ${valid ? 'border-line' : 'border-coral'}`}
            />
            {valid && diff !== 0 && (
              <span className={`mt-1 block text-[12px] font-semibold ${diff < 0 ? 'text-coral' : 'text-amber'}`}>
                {diff < 0 ? `${inr(-diff)} short` : `${inr(diff)} over`} — a large difference goes to a manager to review.
              </span>
            )}
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => answerCloseOtherDrawer(null)} className="h-10 rounded-xl border border-line px-4 font-semibold text-ink hover:border-blue">
              Not now
            </button>
            <button type="submit" disabled={!valid} className="h-10 rounded-xl gbv px-5 font-semibold text-onbrand disabled:opacity-50">
              Close it &amp; continue
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
