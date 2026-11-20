'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleCheck,
  Delete,
  Eye,
  EyeOff,
  KeyRound,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Monitor,
  Pill,
  Settings,
  ShieldCheck,
  Users,
  WifiOff,
  QrCode,
  ReceiptText,
  ScanBarcode,
  Shirt,
  ShoppingBasket,
  ShoppingCart,
  Smartphone,
  Store,
  Tag,
  TriangleAlert,
  UtensilsCrossed,
  Warehouse,
  Wrench,
} from 'lucide-react';
import {
  canOpen,
  clearFailures,
  demoAccounts,
  getCashiers,
  homeFor,
  loginLock,
  recordFailure,
  roleLabel,
  signIn,
  signInWithPin,
  useSession,
  type Session,
  type StoredAccount,
} from '@/lib/auth';
import { useSetup } from '@/lib/setup';
import { bootLive, isLive, livePinSignIn, liveSignIn } from '@/lib/live/session';
import { deviceInfo, getDeviceKey, type DeviceInfo } from '@/lib/offline/device';
import { errorMessage } from '@/lib/api/client';
import '@/lib/live/hydrate';
import { useHydrated } from '@/lib/auth';
import { businessTypes, liveStoreCard, useBusinessProfile, type BusinessType } from '@/lib/business-profile';
import { APP_NAME, BrandBadge, BrandLogo } from '@/components/brand/Brand';
import { apiConfigured } from '@/lib/api/client';

type IconType = ComponentType<{ className?: string | undefined }>;

const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** Only same-site paths are accepted as ?next= (no open redirects). */
const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : null);

/* =====================================================================
   Left: showcase
   ===================================================================== */

const features: { icon: IconType; title: string; body: string }[] = [
  { icon: ScanBarcode, title: 'Scan & bill in seconds', body: 'Barcode scanners, smart search and one-key payments.' },
  { icon: ReceiptText, title: 'GST-ready invoices', body: 'Tax invoices, bills of supply, HSN and credit notes.' },
  { icon: QrCode, title: 'UPI, cash, card & split', body: 'Exact-amount UPI QR and change calculated for you.' },
  { icon: Tag, title: 'Sell near-expiry first', body: 'Automatic markdowns on batches about to expire.' },
  { icon: Laptop, title: 'Works offline', body: 'Install the desktop app; print straight to the counter.' },
];

const marqueeTypes: { icon: IconType; label: string }[] = [
  { icon: ShoppingBasket, label: 'Grocery' },
  { icon: ShoppingCart, label: 'Supermarkets' },
  { icon: Pill, label: 'Pharmacies' },
  { icon: Smartphone, label: 'Mobiles & electronics' },
  { icon: Shirt, label: 'Garments' },
  { icon: Wrench, label: 'Hardware' },
  { icon: Warehouse, label: 'Wholesale' },
  { icon: UtensilsCrossed, label: 'Restaurants' },
];

const demoBill = [
  { name: 'Gehu Gold Atta 5kg', qty: 1, amount: 240 },
  { name: 'Nandini Milk 1L', qty: 2, amount: 132 },
  { name: 'Nandini Curd 400g', qty: 1, amount: 24.5, tag: '−30% near expiry' },
  { name: 'Sudha Detergent 1kg', qty: 1, amount: 95 },
];

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(m.matches);
    const on = () => setReduced(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Smoothly counts to `value` (jumps straight there when motion is reduced). */
function CountUp({ value, instant }: { value: number; instant: boolean }) {
  const [shown, setShown] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    if (instant) {
      current.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const from = current.current; // continue from wherever the last count got to
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / 450);
      current.current = from + (value - from) * (1 - (1 - k) ** 3);
      setShown(current.current);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, instant]);
  return <>{inr(Math.round(shown * 100) / 100)}</>;
}

/** A bill that fills itself in: items are "scanned", the total counts up, then it's paid by UPI. */
function LiveBill() {
  const reduced = usePrefersReducedMotion();
  const [step, setStep] = useState(0);
  const PAID = demoBill.length + 1;
  const LOOP = demoBill.length + 4;

  useEffect(() => {
    if (reduced) return;
    const t = window.setInterval(() => setStep((s) => (s + 1) % LOOP), 1200);
    return () => window.clearInterval(t);
  }, [reduced, LOOP]);

  const shown = reduced ? demoBill.length : Math.min(step, demoBill.length);
  const paid = reduced || step >= PAID;
  const total = demoBill.slice(0, shown).reduce((s, i) => s + i.amount, 0);

  return (
    <div className="relative w-full max-w-[300px] overflow-hidden rounded-2xl border border-white/15 bg-white/[0.08] p-4 text-white shadow-2xl shadow-black/30 backdrop-blur-xl">
      {/* scanning beam */}
      {!paid && <div className="login-scan pointer-events-none absolute inset-x-0 h-12 bg-gradient-to-b from-transparent via-cyan-300/25 to-transparent" />}
      <div className="flex items-center justify-between text-[11px] text-white/60">
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-emerald-400" /> Counter 1
        </span>
        <span className="font-mono">Bill #04822</span>
      </div>
      <ul className="mt-3 min-h-[156px] space-y-2">
        {demoBill.slice(0, shown).map((i) => (
          <li key={i.name} className="login-rise flex items-start justify-between gap-3 text-[12.5px]">
            <span className="min-w-0">
              <span className="block truncate font-semibold">{i.name}</span>
              <span className="flex items-center gap-1.5 text-[11px] text-white/55">
                × {i.qty}
                {i.tag && <span className="rounded-full bg-amber-400/20 px-1.5 font-semibold text-amber-300">{i.tag}</span>}
              </span>
            </span>
            <span className="font-semibold tabular-nums">{inr(i.amount)}</span>
          </li>
        ))}
        {shown === 0 && (
          <li className="flex h-[150px] flex-col items-center justify-center gap-2 text-[12px] text-white/50">
            <ScanBarcode className="size-7" /> Scan an item…
          </li>
        )}
      </ul>
      <div className="mt-3 flex items-end justify-between border-t border-dashed border-white/20 pt-3">
        <span className="text-[11px] text-white/60">To pay</span>
        <span className="text-[24px] font-extrabold tabular-nums leading-none">
          <CountUp value={total} instant={reduced} />
        </span>
      </div>
      <div
        className={`mt-3 flex h-9 items-center justify-center gap-2 rounded-xl text-[12.5px] font-bold transition-all duration-500 ${
          paid ? 'bg-emerald-400 text-emerald-950' : 'bg-white/10 text-white/70'
        }`}
      >
        {paid ? (
          <>
            <CircleCheck className="size-4" /> Paid via UPI · receipt printed
          </>
        ) : (
          <>
            <QrCode className="size-4" /> Waiting for payment
          </>
        )}
      </div>
    </div>
  );
}

function FloatingChip({ className, delay, children }: { className: string; delay: string; children: ReactNode }) {
  return (
    <div
      className={`login-float absolute flex items-center gap-2 rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-[12px] font-semibold text-white shadow-xl shadow-black/20 backdrop-blur-xl ${className}`}
      style={{ animationDelay: delay }}
    >
      {children}
    </div>
  );
}

function Showcase({ storeName }: { storeName: string | null }) {
  return (
    <section
      aria-label={`About ${APP_NAME}`}
      className="relative hidden overflow-hidden bg-[#151a3a] bg-cover bg-center text-white lg:flex lg:flex-col"
      style={{ backgroundImage: 'url(/login-bg.svg)' }}
    >
      <div className="relative z-10 flex h-full flex-col px-10 py-9 xl:px-14 xl:py-11">
        {/* brand */}
        <div className="login-in flex items-center gap-3">
          <BrandLogo className="h-16 xl:h-20" />
          {storeName && (
            <span className="ml-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold text-white/80 backdrop-blur">
              {storeName}
            </span>
          )}
        </div>

        <div className="my-auto py-6">
          {/* pitch — full width so the headline breaks cleanly */}
          <div className="login-in max-w-[600px]" style={{ animationDelay: '120ms' }}>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white/80">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" /> Billing · Inventory · GST
            </span>
            <h1 className="mt-4 text-[32px] font-extrabold leading-[1.1] tracking-tight xl:text-[40px]">
              Bill faster.{' '}
              <span className="bg-gradient-to-r from-cyan-300 via-violet-300 to-fuchsia-300 bg-clip-text text-transparent">Stay GST-ready.</span>
              <br />
              Know your store.
            </h1>
            <p className="mt-3 max-w-[500px] text-[14.5px] leading-relaxed text-white/70">
              One system for the counter and the back office — billing, stock, suppliers, customers and khata, built for Indian retail.
            </p>
          </div>

          <div className="mt-7 grid items-center gap-8 xl:grid-cols-[minmax(0,1fr)_280px]">
            <ul className="space-y-3">
              {features.map(({ icon: I, title, body }, i) => (
                <li key={title} className="login-in flex items-start gap-3" style={{ animationDelay: `${220 + i * 90}ms` }}>
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/15 bg-white/10 text-cyan-200">
                    <I className="size-[18px]" />
                  </span>
                  <span className="pt-0.5">
                    <span className="block text-[14px] font-bold leading-tight">{title}</span>
                    <span className="login-short-hide block text-[12.5px] text-white/60">{body}</span>
                  </span>
                </li>
              ))}
            </ul>

          {/* live demo */}
          <div className="login-in relative hidden justify-center py-8 xl:flex" style={{ animationDelay: '300ms' }}>
            <LiveBill />
            <FloatingChip className="-left-10 top-0" delay="0s">
              <span className="grid size-6 place-items-center rounded-lg bg-emerald-400/20 text-emerald-300">
                <Check className="size-3.5" />
              </span>
              GST invoice ready
            </FloatingChip>
            <FloatingChip className="-right-6 bottom-0" delay="1.4s">
              <span className="text-white/60">Today</span>
              <span className="tabular-nums">₹1,28,450</span>
              <span className="rounded-md bg-emerald-400/20 px-1.5 text-[10px] text-emerald-300">▲ 18.6%</span>
            </FloatingChip>
          </div>
          </div>
        </div>

        {/* business types marquee */}
        <div className="login-in login-short-hide" style={{ animationDelay: '500ms' }}>
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-white/50">Built for every kind of counter</p>
          <div className="relative overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]">
            <div className="login-marquee flex w-max gap-2">
              {[...marqueeTypes, ...marqueeTypes].map(({ icon: I, label }, i) => (
                <span
                  key={i}
                  aria-hidden={i >= marqueeTypes.length}
                  className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.07] px-3.5 py-1.5 text-[12px] font-medium text-white/80"
                >
                  <I className="size-3.5 text-violet-300" />
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* =====================================================================
   Right: sign in
   ===================================================================== */

const passwordSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, 'Enter your mobile number or email')
    .refine((v) => /^\S+@\S+\.\S+$/.test(v) || /^(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}$/.test(v), 'Enter a 10-digit mobile number or an email'),
  password: z.string().min(1, 'Enter your password'),
  remember: z.boolean(),
});
type PasswordValues = z.infer<typeof passwordSchema>;

function useLockCountdown() {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setUntil(loginLock().lockedUntil), []);
  useEffect(() => {
    if (until <= Date.now()) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [until]);
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  const lock = useCallback((s: number) => {
    setNow(Date.now());
    setUntil(Date.now() + s * 1000);
  }, []);
  return { seconds, lock };
}

function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl border border-coral/30 bg-coral/10 px-3 py-2.5 text-[12.5px] font-medium text-coral animate-in fade-in slide-in-from-top-1">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function PasswordForm({ onSuccess, prefill }: { onSuccess: (s: Session) => void; prefill: { id: string; n: number } | null }) {
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  // Connected: a person in several businesses picks one.
  const [choices, setChoices] = useState<{ id: string; displayName: string }[] | null>(null);
  const [creds, setCreds] = useState<{ email: string; password: string } | null>(null);
  const { seconds, lock } = useLockCountdown();
  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    formState: { errors },
  } = useForm<PasswordValues>({ resolver: zodResolver(passwordSchema), defaultValues: { identifier: '', password: '', remember: true } });

  useEffect(() => {
    if (!prefill) return;
    const a = demoAccounts.find((x) => x.id === prefill.id);
    if (!a) return;
    setValue('identifier', a.phone, { shouldValidate: true });
    setValue('password', a.password, { shouldValidate: true });
    setError(null);
    setFocus('password');
  }, [prefill, setValue, setFocus]);

  const liveSubmit = async (email: string, password: string, tenantId?: string) => {
    setBusy(true);
    setError(null);
    const res = await liveSignIn(email, password, tenantId);
    setBusy(false);
    if (res.ok) return onSuccess(res.session);
    if ('chooseBusiness' in res) {
      setCreds({ email, password });
      setChoices(res.chooseBusiness);
      return;
    }
    setError(res.error);
  };

  const submit = handleSubmit(async (v) => {
    if (seconds > 0) return;
    if (isLive()) {
      if (!v.identifier.includes('@')) return setError('Sign in with your email address.');
      return liveSubmit(v.identifier, v.password);
    }
    setBusy(true);
    setError(null);
    await new Promise((r) => setTimeout(r, 450)); // feels like a real request; replace with the auth API
    const res = signIn(v.identifier, v.password, v.remember);
    setBusy(false);
    if (res.ok) {
      clearFailures();
      onSuccess(res.session);
      return;
    }
    const locked = recordFailure();
    if (locked) lock(locked);
    setError(locked ? `Too many attempts. Try again in ${locked} seconds.` : res.error);
  });

  const inputCls = (bad: boolean) =>
    `h-12 w-full rounded-xl border bg-surface pl-11 pr-3 text-[14.5px] text-ink outline-none transition placeholder:text-mute focus:border-blue focus:shadow-[0_0_0_4px_color-mix(in_oklch,var(--blue)_12%,transparent)] ${
      bad ? 'border-coral' : 'border-line'
    }`;

  if (choices && creds)
    return (
      <div className="space-y-3">
        <p className="text-[13px] font-semibold text-ink">Which business?</p>
        {choices.map((c) => (
          <button
            key={c.id}
            disabled={busy}
            onClick={() => void liveSubmit(creds.email, creds.password, c.id)}
            className="flex h-12 w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 text-left text-[14px] font-semibold text-ink hover:border-blue disabled:opacity-60"
          >
            <Store className="size-4 text-blue" /> {c.displayName}
          </button>
        ))}
        {error && <ErrorBox>{error}</ErrorBox>}
        <button onClick={() => setChoices(null)} className="text-[13px] font-semibold text-blue">
          Back
        </button>
      </div>
    );

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-[13px] font-semibold text-ink">{isLive() ? 'Email' : 'Mobile number or email'}</span>
        <span className="relative block">
          {isLive() ? (
            <Mail className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-mute" />
          ) : (
            <Smartphone className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-mute" />
          )}
          <input
            {...register('identifier')}
            autoComplete="username"
            inputMode="email"
            placeholder={isLive() ? 'you@yourstore.in' : '98400 12345 or you@yourstore.in'}
            aria-invalid={!!errors.identifier}
            className={inputCls(!!errors.identifier)}
          />
        </span>
        {errors.identifier && <span className="mt-1 block text-[11.5px] text-coral">{errors.identifier.message}</span>}
      </label>

      <label className="block">
        <span className="mb-1.5 flex items-center justify-between text-[13px] font-semibold text-ink">
          Password
          <button type="button" onClick={() => setForgot((f) => !f)} className="text-[12px] font-semibold text-blue hover:underline">
            Forgot password?
          </button>
        </span>
        <span className="relative block">
          <LockKeyhole className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-mute" />
          <input
            {...register('password')}
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="••••••••"
            aria-invalid={!!errors.password}
            className={`${inputCls(!!errors.password)} pr-11`}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? 'Hide password' : 'Show password'}
            className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-mute hover:bg-bg hover:text-ink"
          >
            {show ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
          </button>
        </span>
        {errors.password && <span className="mt-1 block text-[11.5px] text-coral">{errors.password.message}</span>}
      </label>

      {forgot && (
        <p className="rounded-xl bg-bg px-3 py-2.5 text-[12.5px] text-sub animate-in fade-in">
          Staff: ask the store owner to reset your password. Owners: contact {APP_NAME} support. Reset by SMS OTP will be available once the
          server is connected.
        </p>
      )}

      <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-sub">
        <input type="checkbox" {...register('remember')} className="size-4 accent-[var(--blue)]" />
        Keep me signed in on this computer
      </label>

      {seconds > 0 ? <ErrorBox>Too many attempts. Try again in {seconds} s.</ErrorBox> : error && <ErrorBox>{error}</ErrorBox>}

      <button
        type="submit"
        disabled={busy || seconds > 0}
        className="group flex h-12 w-full items-center justify-center gap-2 rounded-xl gbv text-[15px] font-bold text-onbrand shadow-lg shadow-blue/25 transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
      >
        {busy ? (
          <>
            <LoaderCircle className="size-[18px] animate-spin" /> Signing in…
          </>
        ) : (
          <>
            Sign in <ArrowRight className="size-[18px] transition group-hover:translate-x-0.5" />
          </>
        )}
      </button>
    </form>
  );
}

const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'] as const;

function PinForm({ onSuccess }: { onSuccess: (s: Session) => void }) {
  const [cashiers, setCashiers] = useState<StoredAccount[]>([]);
  const [who, setWho] = useState('');
  useEffect(() => {
    const list = getCashiers();
    setCashiers(list);
    setWho((w) => w || list[0]?.id || '');
  }, []);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const { seconds, lock } = useLockCountdown();
  const account = cashiers.find((a) => a.id === who);

  const press = useCallback(
    (k: (typeof keys)[number]) => {
      if (seconds > 0) return;
      setError(null);
      if (k === 'clear') return setPin('');
      if (k === 'del') return setPin((p) => p.slice(0, -1));
      setPin((p) => (p.length < 4 ? p + k : p));
    },
    [seconds]
  );

  // Four digits entered → check straight away.
  useEffect(() => {
    if (pin.length !== 4) return;
    const t = window.setTimeout(() => {
      const res = signInWithPin(who, pin);
      if (res.ok) {
        clearFailures();
        onSuccess(res.session);
        return;
      }
      const locked = recordFailure();
      if (locked) lock(locked);
      setError(locked ? `Too many attempts. Try again in ${locked} seconds.` : res.error);
      setShake((n) => n + 1);
      setPin('');
    }, 180);
    return () => window.clearTimeout(t);
  }, [pin, who, onSuccess, lock]);

  // Number keys on a keyboard work too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (/^\d$/.test(e.key)) press(e.key as (typeof keys)[number]);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Escape') press('clear');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  if (!cashiers.length)
    return (
      <p className="rounded-xl bg-bg px-4 py-6 text-center text-[13px] text-sub">
        No cashier PINs on this computer yet. Sign in with a password — cashiers are added during store setup.
      </p>
    );

  return (
    <div className="space-y-5">
      <div>
        <span className="mb-2 block text-[13px] font-semibold text-ink">Who&apos;s at the counter?</span>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Cashier">
          {cashiers.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={who === a.id}
              onClick={() => {
                setWho(a.id);
                setPin('');
                setError(null);
              }}
              className={`flex flex-col items-center gap-1.5 rounded-xl border-2 px-2 py-3 transition ${
                who === a.id ? 'border-blue bg-blue/5' : 'border-line hover:border-blue/40'
              }`}
            >
              <span className={`grid size-10 place-items-center rounded-full text-[13px] font-bold ${who === a.id ? 'gbv text-onbrand' : 'bg-vio/15 text-vio'}`}>
                {initials(a.name)}
              </span>
              <span className="text-[12.5px] font-semibold text-ink">{a.name}</span>
              <span className="text-[10.5px] text-mute">{a.counter}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="mb-2 block text-center text-[13px] font-semibold text-ink">Enter {account?.name.split(' ')[0]}&apos;s 4-digit PIN</span>
        <div key={shake} className={`flex justify-center gap-3 ${shake ? 'login-shake' : ''}`} aria-live="polite" aria-label={`${pin.length} of 4 digits entered`}>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={`size-3.5 rounded-full transition-all duration-150 ${i < pin.length ? 'scale-110 bg-blue' : 'bg-line'} ${error ? 'bg-coral/60' : ''}`}
            />
          ))}
        </div>
      </div>

      <div className="mx-auto grid max-w-[280px] grid-cols-3 gap-2">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            disabled={seconds > 0}
            aria-label={k === 'del' ? 'Delete digit' : k === 'clear' ? 'Clear PIN' : k}
            className={`grid h-14 place-items-center rounded-2xl text-[20px] font-bold transition active:scale-95 disabled:opacity-40 ${
              k === 'clear' || k === 'del' ? 'text-[13px] font-semibold text-sub hover:bg-bg' : 'bg-bg text-ink hover:bg-line'
            }`}
          >
            {k === 'del' ? <Delete className="size-5" /> : k === 'clear' ? 'Clear' : k}
          </button>
        ))}
      </div>

      {seconds > 0 ? <ErrorBox>Too many attempts. Try again in {seconds} s.</ErrorBox> : error && <ErrorBox>{error}</ErrorBox>}
      <p className="text-center text-[12px] text-mute">PIN sign-in opens the POS only. Your bills are recorded under your name.</p>
    </div>
  );
}

const liveKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'] as const;

/**
 * Connected mode on a computer registered as a counter: the cashiers who may bill here (from the
 * server), and their PIN, checked by the server (5 wrong PINs lock it for 15 minutes).
 */
function LivePinForm({ onSuccess, onNotRegistered }: { onSuccess: (s: Session) => void; onNotRegistered: () => void }) {
  const [info, setInfo] = useState<DeviceInfo | null | 'loading'>('loading');
  const [who, setWho] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  useEffect(() => {
    deviceInfo()
      .then((d) => {
        // The server doesn't know this computer as a counter any more: offer to register it.
        if (!d) return onNotRegistered();
        setInfo(d);
        setWho((w) => w || d?.cashiers[0]?.membershipId || '');
      })
      .catch((e: unknown) => {
        setInfo(null);
        setError(errorMessage(e));
      });
  }, []);

  const submit = useCallback(async () => {
    if (pin.length !== 4 || !who || busy) return;
    setBusy(true);
    const r = await livePinSignIn(who, pin);
    setBusy(false);
    // Clear on success too, or the auto-submit below would sign in a second time.
    if (r.ok) {
      setPin('');
      return onSuccess(r.session);
    }
    setError('error' in r ? r.error : 'Could not sign in.');
    setShake((n) => n + 1);
    setPin('');
  }, [pin, who, busy, onSuccess]);

  const press = useCallback(
    (k: (typeof liveKeys)[number]) => {
      if (busy) return;
      setError(null);
      if (k === 'clear') return setPin('');
      if (k === 'del') return setPin((p) => p.slice(0, -1));
      setPin((p) => (p.length < 4 ? p + k : p));
    },
    [busy]
  );
  // Four digits entered → check straight away.
  useEffect(() => {
    if (pin.length !== 4) return;
    const t = window.setTimeout(() => void submit(), 180);
    return () => window.clearTimeout(t);
  }, [pin, submit]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (/^\d$/.test(e.key)) press(e.key as (typeof liveKeys)[number]);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Escape') press('clear');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  if (info === 'loading') return <LoaderCircle className="mx-auto size-5 animate-spin text-blue" />;
  if (!info?.cashiers.length)
    return (
      <p className="rounded-xl bg-bg px-4 py-6 text-center text-[13px] text-sub">
        {error ?? 'No cashier on this counter has a PIN yet. A manager sets PINs on the Staff screen.'}
      </p>
    );
  const name = info.cashiers.find((c) => c.membershipId === who)?.name ?? '';
  return (
    <div className="space-y-5">
      <p className="text-center text-[12px] text-mute">
        {info.store.name} · {info.counter.name}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Cashier">
        {info.cashiers.map((c) => (
          <button
            key={c.membershipId}
            type="button"
            role="radio"
            aria-checked={who === c.membershipId}
            onClick={() => {
              setWho(c.membershipId);
              setPin('');
              setError(null);
            }}
            className={`flex flex-col items-center gap-1.5 rounded-xl border-2 px-2 py-3 transition ${who === c.membershipId ? 'border-blue bg-blue/5' : 'border-line hover:border-blue/40'}`}
          >
            <span className={`grid size-10 place-items-center rounded-full text-[13px] font-bold ${who === c.membershipId ? 'gbv text-onbrand' : 'bg-vio/15 text-vio'}`}>{initials(c.name)}</span>
            <span className="text-[12.5px] font-semibold text-ink">{c.name}</span>
          </button>
        ))}
      </div>
      <div>
        <span className="mb-2 block text-center text-[13px] font-semibold text-ink">Enter {name.split(' ')[0]}&apos;s 4-digit PIN</span>
        <div key={shake} className={`flex justify-center gap-3 ${shake ? 'login-shake' : ''}`} aria-live="polite" aria-label={`${pin.length} of 4 digits entered`}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`size-3.5 rounded-full transition-all duration-150 ${i < pin.length ? 'scale-110 bg-blue' : 'bg-line'} ${error ? 'bg-coral/60' : ''}`} />
          ))}
        </div>
      </div>
      <div className="mx-auto grid max-w-[280px] grid-cols-3 gap-2">
        {liveKeys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            disabled={busy}
            aria-label={k === 'del' ? 'Delete digit' : k === 'clear' ? 'Clear PIN' : k}
            className={`grid h-14 place-items-center rounded-2xl text-[20px] font-bold transition active:scale-95 disabled:opacity-40 ${
              k === 'clear' || k === 'del' ? 'text-[13px] font-semibold text-sub hover:bg-bg' : 'bg-bg text-ink hover:bg-line'
            }`}
          >
            {k === 'del' ? <Delete className="size-5" /> : k === 'clear' ? 'Clear' : k}
          </button>
        ))}
      </div>
      {busy && (
        <p className="flex items-center justify-center gap-2 text-[12.5px] text-sub">
          <LoaderCircle className="size-4 animate-spin text-blue" /> Checking…
        </p>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      <p className="text-center text-[12px] text-mute">PIN sign-in opens the POS on this counter. Your bills are recorded under your name.</p>
    </div>
  );
}

/**
 * Connected mode on a computer that isn't a counter yet: PIN sign-in needs a registered counter
 * (the server only accepts a PIN together with the counter's device key), so say how to get one.
 */
function NotACounter({ onUsePassword }: { onUsePassword: () => void }) {
  const steps: { icon: IconType; title: ReactNode; body: ReactNode }[] = [
    { icon: KeyRound, title: 'Sign in with a password', body: 'As the owner or a branch manager.' },
    {
      icon: Settings,
      title: (
        <>
          Open <b>POS → Settings</b>
        </>
      ),
      body: 'The gear icon, then “Offline billing, sync and registering this computer as a counter”.',
    },
    {
      icon: Monitor,
      title: (
        <>
          Press <b>Register as counter</b>
        </>
      ),
      body: 'Pick which counter this computer is, then sign out.',
    },
    { icon: Users, title: 'Give cashiers a PIN', body: 'On the Staff screen — 4 to 6 digits each.' },
  ];
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-2xl border border-amber/30 bg-amber/10 p-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-amber/20 text-amber">
          <Monitor className="size-[18px]" />
        </span>
        <div className="text-[12.5px]">
          <p className="font-bold text-ink">This computer isn&apos;t a billing counter yet</p>
          <p className="mt-0.5 text-sub">Cashier PINs only work on a registered counter. A manager sets it up once:</p>
        </div>
      </div>
      <ol className="relative space-y-3 pl-1">
        <span aria-hidden className="absolute bottom-4 left-[19px] top-4 w-px bg-line" />
        {steps.map(({ icon: I, title, body }, i) => (
          <li key={i} className="relative flex gap-3">
            <span className="relative z-10 grid size-[30px] shrink-0 place-items-center rounded-full border-2 border-blue/25 bg-surface text-blue">
              <I className="size-3.5" />
            </span>
            <div className="pt-0.5 text-[12.5px]">
              <p className="font-semibold text-ink [&_b]:font-bold">
                <span className="text-mute">{i + 1}.</span> {title}
              </p>
              <p className="text-[11.5px] leading-snug text-sub">{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="rounded-xl bg-bg px-3 py-2 text-center text-[12px] text-sub">After that, cashiers pick their name here and type their PIN.</p>
      <button
        type="button"
        onClick={onUsePassword}
        className="group flex h-11 w-full items-center justify-center gap-2 rounded-xl gbv font-semibold text-onbrand shadow-lg shadow-blue/25"
      >
        Sign in with password <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
      </button>
    </div>
  );
}

/* =====================================================================
   Page
   ===================================================================== */

export function LoginView() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const session = useSession();
  const setup = useSetup();
  const hydrated = useHydrated();
  const profile = useBusinessProfile();

  // Connected: continue an existing session (refresh cookie) without asking again.
  useEffect(() => {
    void bootLive();
  }, []);

  // A computer that hasn't been set up goes to the setup wizard first.
  useEffect(() => {
    if (hydrated && !setup) router.replace('/setup');
  }, [hydrated, setup, router]);
  const [tab, setTab] = useState<'password' | 'pin'>(next?.startsWith('/pos') ? 'pin' : 'password');
  // Connected mode: cashier PINs work only on a computer registered as a counter.
  const [isCounter, setIsCounter] = useState(false);
  useEffect(() => {
    if (isLive()) void getDeviceKey().then((k) => setIsCounter(!!k), () => setIsCounter(false));
  }, []);
  const [prefill, setPrefill] = useState<{ id: string; n: number } | null>(null);
  const [welcome, setWelcome] = useState<Session | null>(null);

  const go = useCallback(
    (s: Session) => router.replace(next && canOpen(s.role, next) ? next : homeFor(s.role)),
    [router, next]
  );

  // Already signed in (e.g. opened /login from a bookmark) → straight through.
  useEffect(() => {
    if (session && !welcome) go(session);
  }, [session, welcome, go]);

  const onSuccess = useCallback(
    (s: Session) => {
      setWelcome(s);
      window.setTimeout(() => go(s), 650);
    },
    [go]
  );

  // Connected: show the store saved on this computer only once a real sign-in has saved it — never the sample store's.
  const [card, setCard] = useState<{ displayName: string; businessType: BusinessType } | null>(null);
  useEffect(() => setCard(apiConfigured ? liveStoreCard() : { displayName: profile.displayName, businessType: profile.businessType }), [profile.displayName, profile.businessType]);
  const knownStore = !!card;
  const storeName = card?.displayName ?? APP_NAME;
  const typeLabel = card ? businessTypes[card.businessType].label : 'Sign in to your store';
  // Set after mount so the server render and the first client render match.
  const [greeting, setGreeting] = useState('');
  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening');
  }, []);

  return (
    <div className="grid min-h-dvh bg-surface lg:h-dvh lg:grid-cols-[minmax(0,1.15fr)_minmax(440px,1fr)]">
      <style>{`
        @keyframes login-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
        @keyframes login-rise { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
        @keyframes login-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        @keyframes login-scan { 0% { top: -48px; } 100% { top: 100%; } }
        @keyframes login-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        @keyframes login-shake { 0%,100% { transform: translateX(0); } 20%,60% { transform: translateX(-7px); } 40%,80% { transform: translateX(7px); } }
        .login-in { animation: login-in .7s cubic-bezier(.2,.7,.2,1) both; }
        .login-rise { animation: login-rise .35s ease-out both; }
        .login-float { animation: login-float 5s ease-in-out infinite; }
        .login-scan { animation: login-scan 2.2s linear infinite; }
        .login-marquee { animation: login-marquee 28s linear infinite; }
        .login-shake { animation: login-shake .4s ease-in-out; }
        @media (max-height: 780px) { .login-short-hide { display: none !important; } }
        @media (prefers-reduced-motion: reduce) {
          .login-in, .login-rise, .login-float, .login-scan, .login-marquee, .login-shake { animation: none !important; }
        }
      `}</style>

      <Showcase storeName={knownStore ? storeName : null} />

      <main className="relative flex min-h-dvh flex-col overflow-y-auto bg-bg px-5 py-6 sm:px-10 lg:min-h-0">
        {/* soft brand glow + dot grid behind the card */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -right-24 -top-24 size-[360px] rounded-full bg-blue/10 blur-3xl" />
          <div className="absolute -bottom-32 -left-20 size-[320px] rounded-full bg-vio/10 blur-3xl" />
          <div className="absolute inset-0 [background-image:radial-gradient(color-mix(in_oklch,var(--line)_80%,transparent)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_center,#000_30%,transparent_75%)]" />
        </div>

        {/* top bar: compact brand on phones, connection status everywhere */}
        <div className="relative z-10 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 lg:invisible">
            <BrandBadge className="h-10" />
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
              isLive() ? 'border-teal/30 bg-teal/10 text-teal' : setup?.mode === 'demo' ? 'border-amber/30 bg-amber/10 text-amber' : 'border-line bg-surface text-sub'
            }`}
          >
            <span className={`size-1.5 rounded-full ${isLive() ? 'animate-pulse bg-teal' : setup?.mode === 'demo' ? 'bg-amber' : 'bg-mute'}`} />
            {isLive() ? (isCounter ? 'Connected · billing counter' : 'Connected to server') : setup?.mode === 'demo' ? 'Demo store' : 'This computer only'}
          </span>
        </div>

        <div className="relative z-10 mx-auto my-auto w-full max-w-[440px] py-6">
          <div className="login-in rounded-3xl border border-line bg-surface p-6 shadow-[0_24px_60px_-24px_color-mix(in_oklch,var(--ink)_25%,transparent)] sm:p-8">
          {welcome ? (
            <div className="flex flex-col items-center py-16 text-center animate-in fade-in zoom-in-95">
              <span className="grid size-16 place-items-center rounded-full bg-teal/15 text-teal">
                <CircleCheck className="size-9" />
              </span>
              <h2 className="mt-4 text-[22px] font-extrabold text-ink">Welcome, {welcome.name.split(' ')[0]}!</h2>
              <p className="mt-1 text-sub">{welcome.role === 'cashier' ? `Opening the POS on ${welcome.counter ?? 'your counter'}…` : 'Opening your dashboard…'}</p>
              <LoaderCircle className="mt-5 size-5 animate-spin text-blue" />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-blue/10 text-blue">
                  <Store className="size-6" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-bold text-ink">{storeName}</p>
                  <p className="text-[12px] text-mute">{typeLabel}</p>
                </div>
              </div>
              <h2 className="mt-6 text-[26px] font-extrabold leading-tight tracking-tight text-ink sm:text-[28px]">
                {greeting || 'Welcome back'}
              </h2>
              <p className="mt-1 text-[14px] text-sub">
                {tab === 'pin' ? 'Cashiers: pick your name and enter your PIN.' : 'Sign in to start billing or manage your store.'}
              </p>

              <div className="relative mt-6 grid grid-cols-2 rounded-2xl bg-bg p-1" role="tablist" aria-label="Sign-in method">
                <span
                  aria-hidden
                  className={`absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-xl bg-surface shadow-sm transition-transform duration-300 ease-out ${tab === 'pin' ? 'translate-x-full' : ''}`}
                />
                {(
                  [
                    ['password', KeyRound, 'Password', 'Owners & managers'],
                    ['pin', ScanBarcode, 'Cashier PIN', 'At the counter'],
                  ] as const
                ).map(([k, I, label, hint]) => (
                  <button
                    key={k}
                    role="tab"
                    aria-selected={tab === k}
                    onClick={() => setTab(k)}
                    className={`relative z-10 flex flex-col items-center justify-center rounded-xl py-2 transition ${tab === k ? 'text-ink' : 'text-sub hover:text-ink'}`}
                  >
                    <span className="flex items-center gap-2 text-[13px] font-semibold">
                      <I className={`size-4 ${tab === k ? 'text-blue' : ''}`} /> {label}
                    </span>
                    <span className="text-[10.5px] text-mute">{hint}</span>
                  </button>
                ))}
              </div>

              <div className="mt-6" role="tabpanel">
                {tab === 'password' ? (
                  <PasswordForm onSuccess={onSuccess} prefill={prefill} />
                ) : isLive() ? (
                  isCounter ? (
                    <LivePinForm onSuccess={onSuccess} onNotRegistered={() => setIsCounter(false)} />
                  ) : (
                    <NotACounter onUsePassword={() => setTab('password')} />
                  )
                ) : (
                  <PinForm onSuccess={onSuccess} />
                )}
              </div>

              {/* demo accounts (demo mode only) */}
              {setup?.mode === 'demo' && (
              <details className="group mt-6 rounded-xl border border-dashed border-line">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3.5 py-2.5 text-[12.5px] font-semibold text-sub">
                  Demo accounts
                  <ChevronDown className="size-4 transition group-open:rotate-180" />
                </summary>
                <ul className="divide-y divide-line border-t border-line text-[12.5px]">
                  {demoAccounts.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 px-3.5 py-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-vio/15 text-[11px] font-bold text-vio">{initials(a.name)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-ink">
                          {a.name} <span className="font-normal text-mute">· {roleLabel[a.role]}</span>
                        </span>
                        <span className="block font-mono text-[11px] text-mute">
                          {a.phone} / {a.password}
                          {a.pin && ` · PIN ${a.pin}`}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setTab('password');
                          setPrefill((p) => ({ id: a.id, n: (p?.n ?? 0) + 1 }));
                        }}
                        className="h-7 rounded-lg border border-line px-2.5 text-[11.5px] font-semibold text-ink hover:border-blue"
                      >
                        Use
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
              )}
            </>
          )}
          </div>

          {/* trust row */}
          {!welcome && (
            <ul className="mt-5 grid grid-cols-3 gap-2 text-[11px] text-sub">
              {(
                [
                  [ShieldCheck, isLive() ? 'Encrypted sign-in' : 'Stays on this PC'],
                  [WifiOff, 'Bills even offline'],
                  [LockKeyhole, 'Locks after 5 wrong tries'],
                ] as const
              ).map(([I, label]) => (
                <li key={label} className="flex flex-col items-center gap-1.5 rounded-xl border border-line bg-surface/70 px-2 py-2.5 text-center backdrop-blur">
                  <I className="size-4 text-blue" />
                  <span className="leading-tight">{label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {isLive() && !welcome && (
          <p className="relative z-10 mx-auto mb-3 max-w-[440px] text-center text-[12.5px] text-sub">
            New to {APP_NAME}?{' '}
            <a href="/setup" className="font-semibold text-blue hover:underline">
              Set up a new business
            </a>
          </p>
        )}
        <p className="relative z-10 mx-auto max-w-[440px] text-center text-[11.5px] text-mute">
          {isLive() ? 'Signed in securely with your store’s server.' : setup?.mode === 'demo' ? 'Demo mode: sample store and staff accounts.' : 'Staff accounts are stored on this computer.'} © {APP_NAME}
        </p>
      </main>
    </div>
  );
}
