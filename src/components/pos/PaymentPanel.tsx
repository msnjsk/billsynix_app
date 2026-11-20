'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { ArrowLeft, Banknote, Check, CreditCard, Delete, QrCode, Smartphone, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { money, payMethods, r2, type PayMethod, type Payment } from '@/lib/pos/billing';
import { upiLink } from '@/lib/pos/store';

const methodKey: Record<PayMethod, string> = { Cash: 'F5', UPI: 'F6', Card: 'F7' };
const methodIcon: Record<PayMethod, LucideIcon> = { Cash: Banknote, UPI: QrCode, Card: CreditCard };
/** Each method has its own colour, used on its tab, its panel and the confirm button. */
const tone: Record<PayMethod, { tab: string; icon: string; button: string; soft: string }> = {
  Cash: { tab: 'border-teal bg-teal/10 text-teal', icon: 'bg-teal text-onbrand', button: 'bg-teal shadow-teal/30', soft: 'bg-teal/10 text-teal' },
  UPI: { tab: 'border-blue bg-blue/10 text-blue', icon: 'bg-blue text-onbrand', button: 'gbv shadow-blue/30', soft: 'bg-blue/10 text-blue' },
  Card: { tab: 'border-vio bg-vio/10 text-vio', icon: 'bg-vio text-onbrand', button: 'bg-vio shadow-vio/30', soft: 'bg-vio/10 text-vio' },
};

const keypad = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'] as const;

/** Hides the browser's number spinner arrows. */
const noSpin = '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

const rupees = (n: number) => money(n).replace(/\.00$/, '');

/** Quick-tender buttons: exact amount plus the next round note values above it. */
const quickTenders = (due: number) => {
  const opts = new Set<number>([due]);
  for (const step of [10, 50, 100, 500, 2000]) {
    const v = Math.ceil(due / step) * step;
    if (v > due) opts.add(v);
  }
  return [...opts].sort((a, b) => a - b).slice(0, 6);
};

const DENOMS = [500, 200, 100, 50, 20, 10, 5, 2, 1];
/** The fewest notes and coins for the change, e.g. ₹88 → 50 + 20 + 10 + 5 + 2 + 1. */
function changeNotes(change: number) {
  let left = Math.floor(change);
  const out: { d: number; n: number }[] = [];
  for (const d of DENOMS) {
    const n = Math.floor(left / d);
    if (n) out.push({ d, n });
    left -= n * d;
  }
  const paise = Math.round((change - Math.floor(change)) * 100);
  return { notes: out, paise };
}

function UpiQr({ link }: { link: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(link, { margin: 1, width: 240, errorCorrectionLevel: 'M' })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [link]);
  return (
    <div className="grid size-[188px] shrink-0 place-items-center rounded-2xl bg-white p-2.5 shadow-sm ring-1 ring-line">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- data: URL generated on the client
        <img src={src} alt="UPI QR code for this amount" className="size-full" />
      ) : (
        <span className="text-[12px] text-mute">Generating QR…</span>
      )}
    </div>
  );
}

export function PaymentPanel({
  payable,
  billNo,
  upiId,
  payeeName,
  initialMethod,
  onComplete,
  onCancel,
}: {
  payable: number;
  billNo: string;
  upiId: string;
  /** Store name shown to the customer in their UPI app. */
  payeeName: string;
  initialMethod: PayMethod;
  onComplete: (payments: Payment[], change: number) => void;
  onCancel: () => void;
}) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [method, setMethod] = useState<PayMethod>(initialMethod);
  const paid = r2(payments.reduce((s, p) => s + p.amount, 0));
  const due = r2(payable - paid);
  const [amountText, setAmountText] = useState(String(payable));
  const [ref, setRef] = useState('');
  /** True while the amount is the pre-filled suggestion — the first keypad press replaces it. */
  const [fresh, setFresh] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const press = (k: (typeof keypad)[number]) => {
    setAmountText((cur) => {
      if (k === '⌫') return fresh ? '' : cur.slice(0, -1);
      const base = fresh ? '' : cur;
      if (k === '.' && base.includes('.')) return base;
      if (/\.\d{2}$/.test(base)) return base; // max 2 decimals
      return (base === '' && k === '.' ? '0' : base === '0' && k !== '.' ? '' : base) + k;
    });
    setFresh(false);
  };
  const setAmount = (v: string) => {
    setAmountText(v);
    setFresh(true);
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [method, payments.length]);

  const n = Number(amountText);
  const valid = Number.isFinite(n) && n > 0;
  // Only cash can be more than what's due (the rest is change).
  const applied = valid ? r2(Math.min(n, due)) : 0;
  const over = valid && n > due && method !== 'Cash';
  const change = method === 'Cash' && valid ? r2(Math.max(0, n - due)) : 0;
  const tenders = useMemo(() => quickTenders(due), [due]);
  const breakdown = useMemo(() => changeNotes(change), [change]);
  const progress = payable > 0 ? Math.min(100, (paid / payable) * 100) : 0;
  const t = tone[method];

  const switchMethod = (m: PayMethod) => {
    setMethod(m);
    setAmount(String(due));
    setRef('');
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || over || applied <= 0) return;
    const p: Payment = {
      method,
      amount: applied,
      ...(ref.trim() ? { ref: ref.trim() } : {}),
      ...(method === 'Cash' && n > applied ? { tendered: r2(n) } : {}),
    };
    const next = [...payments, p];
    if (r2(due - applied) <= 0) onComplete(next, change);
    else {
      setPayments(next);
      setAmount(String(r2(due - applied)));
      setRef('');
    }
  };

  // F5/F6/F7 switch method while the dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = (Object.keys(methodKey) as PayMethod[]).find((k) => methodKey[k] === e.key);
      if (m) {
        e.preventDefault();
        switchMethod(m);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- switchMethod only reads `due`
  }, [due]);

  const amountField = (label: string) => (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-semibold text-sub">{label}</span>
      <span className="relative block">
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[22px] font-extrabold text-mute">₹</span>
        <input
          ref={inputRef}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={amountText}
          onChange={(e) => {
            setAmountText(e.target.value);
            setFresh(false);
          }}
          className={`${noSpin} h-14 w-full rounded-2xl border border-line bg-surface pl-10 pr-4 text-[24px] font-extrabold tabular-nums text-ink shadow-sm outline-none transition focus:border-blue focus:shadow-[0_0_0_4px_color-mix(in_oklch,var(--blue)_12%,transparent)]`}
        />
      </span>
    </label>
  );

  return (
    <form onSubmit={submit} className="text-[13px]">
      <div className="space-y-4">
        {/* Amount */}
        <div className="relative overflow-hidden rounded-2xl gbv p-4 text-onbrand shadow-lg shadow-blue/20">
          <span aria-hidden className="pointer-events-none absolute -right-10 -top-12 size-40 rounded-full bg-white/10 blur-2xl" />
          <div className="relative flex items-end justify-between gap-3">
            <div>
              <div className="text-[12px] font-semibold text-onbrand/80">{payments.length ? 'Still to pay' : 'Amount payable'}</div>
              <div className="text-[34px] font-extrabold leading-tight tabular-nums tracking-tight">{money(due)}</div>
            </div>
            {payments.length > 0 && (
              <div className="text-right text-[12px] leading-snug text-onbrand/85">
                <div>
                  Paid <b className="tabular-nums text-onbrand">{money(paid)}</b>
                </div>
                <div>of {money(payable)}</div>
              </div>
            )}
          </div>
          {payments.length > 0 && (
            <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-onbrand/20" aria-hidden>
              <div className="h-full rounded-full bg-onbrand transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>

        {/* Split payments taken so far */}
        {payments.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Payments taken">
            {payments.map((p, i) => {
              const I = methodIcon[p.method];
              return (
                <li key={i} className={`flex items-center gap-2 rounded-full py-1 pl-1 pr-2 text-[12px] font-semibold ${tone[p.method].soft}`}>
                  <span className={`grid size-6 place-items-center rounded-full ${tone[p.method].icon}`}>
                    <Check className="size-3.5" />
                  </span>
                  <I className="size-3.5" /> {p.method} <span className="tabular-nums">{money(p.amount)}</span>
                  {p.ref && <span className="font-normal opacity-70">· {p.ref}</span>}
                  <button
                    type="button"
                    aria-label={`Remove ${p.method} payment`}
                    onClick={() => {
                      setPayments((prev) => prev.filter((_, j) => j !== i));
                      setAmount(String(r2(due + p.amount)));
                    }}
                    className="ml-0.5 grid size-5 place-items-center rounded-full opacity-60 hover:bg-coral/15 hover:text-coral hover:opacity-100"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Method */}
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Payment method">
          {payMethods.map((m) => {
            const I = methodIcon[m];
            const on = method === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => switchMethod(m)}
                className={`flex h-[60px] items-center justify-center gap-2.5 rounded-2xl border-2 px-2 font-bold transition ${
                  on ? tone[m].tab : 'border-line bg-surface text-ink hover:border-line hover:bg-bg'
                }`}
              >
                <span className={`grid size-8 place-items-center rounded-xl transition ${on ? tone[m].icon : 'bg-bg text-sub'}`}>
                  <I className="size-[18px]" />
                </span>
                <span className="text-left leading-tight">
                  <span className="block text-[14px]">{m}</span>
                  <span className={`hidden text-[10px] font-semibold sm:block ${on ? 'opacity-70' : 'text-mute'}`}>{methodKey[m]}</span>
                </span>
              </button>
            );
          })}
        </div>

        {/* Cash */}
        {method === 'Cash' && (
          <div className="grid gap-4 sm:grid-cols-[1fr_208px]">
            <div className="space-y-3">
              {amountField('Cash received')}
              <div>
                <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-mute">Customer gave</div>
                <div className="grid grid-cols-3 gap-2">
                  {tenders.map((v) => {
                    const on = Number(amountText) === v;
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => {
                          setAmount(String(v));
                          // Back to the amount box, so Enter completes the sale.
                          inputRef.current?.focus();
                        }}
                        className={`relative h-11 overflow-hidden rounded-xl border font-bold tabular-nums transition active:scale-[0.98] ${
                          on ? 'border-teal bg-teal/10 text-teal' : 'border-line bg-surface hover:border-teal/50'
                        }`}
                      >
                        {v === due ? 'Exact' : rupees(v)}
                        {v !== due && <i aria-hidden className={`absolute inset-y-0 left-0 w-1 ${on ? 'bg-teal' : 'bg-teal/30'}`} />}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div
                className={`rounded-2xl px-4 py-3 transition ${change > 0 ? 'bg-teal/10 ring-1 ring-teal/30' : 'bg-bg'}`}
                aria-live="polite"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-semibold ${change > 0 ? 'text-teal' : 'text-sub'}`}>Change to give back</span>
                  <b className={`text-[28px] leading-none tabular-nums ${change > 0 ? 'text-teal' : 'text-mute'}`}>{money(change)}</b>
                </div>
                {change > 0 && (breakdown.notes.length > 0 || breakdown.paise > 0) && (
                  <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Notes and coins to give">
                    {breakdown.notes.map(({ d, n: count }) => (
                      <span key={d} className="rounded-lg bg-surface px-2 py-0.5 text-[11.5px] font-semibold tabular-nums text-ink ring-1 ring-teal/20">
                        ₹{d}
                        {count > 1 && <span className="text-mute"> × {count}</span>}
                      </span>
                    ))}
                    {breakdown.paise > 0 && (
                      <span className="rounded-lg bg-surface px-2 py-0.5 text-[11.5px] font-semibold text-mute ring-1 ring-teal/20">{breakdown.paise} paise</span>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="hidden grid-cols-3 gap-1.5 self-end rounded-2xl bg-bg p-1.5 sm:grid" aria-label="Number pad">
              {keypad.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => press(k)}
                  aria-label={k === '⌫' ? 'Delete digit' : k}
                  className="grid h-12 place-items-center rounded-xl bg-surface text-[18px] font-bold text-ink shadow-sm transition hover:bg-line/60 active:scale-95"
                >
                  {k === '⌫' ? <Delete className="size-5 text-sub" /> : k}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* UPI */}
        {method === 'UPI' && (
          <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
            <div className="flex flex-col items-center gap-2 rounded-2xl bg-blue/5 p-3 ring-1 ring-blue/15">
              {upiId ? (
                <>
                  <UpiQr link={upiLink(upiId, applied || due, billNo, payeeName)} />
                  <div className="text-center leading-tight">
                    <div className="text-[18px] font-extrabold tabular-nums text-ink">{money(applied || due)}</div>
                    <div className="max-w-[188px] truncate text-[11px] text-sub" title={upiId}>
                      to {payeeName} · {upiId}
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex size-[188px] flex-col items-center justify-center gap-2 px-3 text-center text-[12px] text-sub">
                  <TriangleAlert className="size-6 text-amber" />
                  No UPI ID set for this counter. Add it in POS settings to show a QR code.
                </div>
              )}
            </div>
            <div className="min-w-0 space-y-3">
              <div className="flex items-start gap-2 rounded-xl bg-amber/10 px-3 py-2 text-[12px] text-sub">
                <span className="relative mt-1 flex size-2 shrink-0">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-amber" />
                </span>
                <span>
                  Customer scans with any UPI app. <b className="text-ink">Check the soundbox or your UPI app</b> before confirming — this screen can&apos;t see the
                  payment.
                </span>
              </div>
              {amountField('Amount')}
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-semibold text-sub">
                  UTR / reference <span className="font-normal text-mute">(optional)</span>
                </span>
                <input
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="12-digit UTR from the payment"
                  className="h-11 w-full rounded-xl border border-line bg-surface px-3 shadow-sm outline-none transition focus:border-blue"
                />
              </label>
            </div>
          </div>
        )}

        {/* Card */}
        {method === 'Card' && (
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
            <div className="space-y-3">
              {amountField('Amount')}
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-semibold text-sub">
                  Approval code <span className="font-normal text-mute">(optional)</span>
                </span>
                <input
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="From the card machine slip"
                  className="h-11 w-full rounded-xl border border-line bg-surface px-3 shadow-sm outline-none transition focus:border-vio"
                />
              </label>
            </div>
            <ol className="space-y-2.5 rounded-2xl bg-vio/5 p-4 ring-1 ring-vio/15">
              {[
                { I: Smartphone, text: `Enter ${money(applied || due)} on the card machine` },
                { I: CreditCard, text: 'Customer taps, swipes or inserts the card' },
                { I: Check, text: 'When the machine says approved, confirm here' },
              ].map(({ I, text }, i) => (
                <li key={i} className="flex items-start gap-2.5 text-[12.5px] text-sub">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-vio/15 text-vio">
                    <I className="size-3.5" />
                  </span>
                  <span className="pt-1">
                    <b className="text-ink">{i + 1}.</b> {text}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {over && (
          <p className="flex items-center gap-1.5 rounded-xl bg-coral/10 px-3 py-2 text-[12px] font-medium text-coral">
            <TriangleAlert className="size-4 shrink-0" /> Only {money(due)} is due. Change can only be given for cash.
          </p>
        )}
        {valid && !over && applied < due && (
          <p className="rounded-xl bg-bg px-3 py-2 text-[12px] text-sub">
            <b className="text-ink">Split payment</b> — {money(r2(due - applied))} will be left to pay by another method.
          </p>
        )}
      </div>

      {/* Actions — stay in view while the dialog scrolls */}
      <div className="sticky -bottom-6 -mx-6 mt-5 flex items-center gap-2 border-t border-line bg-surface/95 px-6 pb-1 pt-4 backdrop-blur">
        <button type="button" onClick={onCancel} className="flex h-12 items-center gap-1.5 rounded-xl border border-line px-4 font-semibold text-sub transition hover:text-ink">
          <ArrowLeft className="size-4" /> Back
        </button>
        <button
          type="submit"
          disabled={!valid || over}
          className={`flex h-12 flex-1 items-center justify-center gap-2 rounded-xl px-6 text-[15px] font-extrabold text-onbrand shadow-lg transition hover:brightness-105 active:scale-[0.99] disabled:opacity-50 disabled:shadow-none ${t.button}`}
        >
          {applied < due ? (
            <>Take {money(applied)} by {method}</>
          ) : method === 'Cash' ? (
            <>
              <Check className="size-5" /> Complete sale{change > 0 ? ` · give ${money(change)}` : ''}
            </>
          ) : (
            <>
              <Check className="size-5" /> {method} received · {money(applied)}
            </>
          )}
          <kbd className="ml-1 hidden rounded-md bg-onbrand/20 px-1.5 py-0.5 font-mono text-[10px] sm:inline">Enter</kbd>
        </button>
      </div>
    </form>
  );
}
