'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useFieldArray, useForm, useWatch, type FieldPath } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  CircleCheck,
  CirclePlay,
  ClipboardCheck,
  Clock3,
  Eye,
  EyeOff,
  History,
  Info,
  Landmark,
  LayoutDashboard,
  LoaderCircle,
  LogIn,
  MapPin,
  Monitor,
  PartyPopper,
  Plus,
  Printer,
  Rocket,
  ScanBarcode,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UserPlus,
  Users,
} from 'lucide-react';
import { Field, borderCls, fieldCls } from '@/components/suppliers/SupplierForms';
import { PrintArea, Receipt } from '@/components/pos/Receipt';
import { typeIcon } from '@/components/business/business-icons';
import { profileShape, refineProfile } from '@/lib/profile-schema';
import {
  addressLines,
  businessTypes,
  defaultProfile,
  gstStates,
  gstinProblem,
  moduleInfo,
  presetModules,
  registrationInfo,
  relevantModules,
  licenceFields,
  suggestedLicences,
  type BusinessProfile,
  type BusinessType,
  type ModuleKey,
  type Modules,
  type Registration,
} from '@/lib/business-profile';
import { computeBill, invoiceNo, type CartLine, type Invoice } from '@/lib/pos/billing';
import { connectSerialPrinter, hasSerialPrinter, printEscPos, serialSupported, toEscPos } from '@/lib/pos/escpos';
import { counters as counterNames, type PaperWidth, type PrintMethod } from '@/lib/pos/store';
import { signInAs, useHydrated, useSession, homeFor } from '@/lib/auth';
import { API_URL, apiConfigured, errorMessage } from '@/lib/api/client';
import { liveSignIn } from '@/lib/live/session';
import { saveLocal, defaultSettings } from '@/lib/pos/store';
import { DRAFT_KEY, finishSetup, startDemo, useSetup } from '@/lib/setup';
import type { DesktopPrinter } from '@/types/desktop';
import { APP_NAME, BrandBadge, BrandLogo } from '@/components/brand/Brand';

type IconType = ComponentType<{ className?: string | undefined }>;

/* =====================================================================
   Form
   ===================================================================== */

const MOBILE = /^(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}$/;
const UPI = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

const schema = profileShape
  .extend({
    startingBillNo: z.number({ error: 'Enter the first bill number' }).int('Use a whole number').min(1, 'Start at 1 or more').max(999999, 'Up to 999999'),
    owner: z.object({
      name: z.string().trim().min(2, 'Enter the owner’s name').max(40, 'Keep it under 40 characters'),
      phone: z.string().trim().regex(MOBILE, 'Enter a 10-digit mobile number'),
      email: z.union([z.literal(''), z.email('Enter a valid email')]),
      password: z
        .string()
        .min(8, 'Use at least 8 characters')
        .regex(/[A-Za-z]/, 'Include at least one letter')
        .regex(/\d/, 'Include at least one number'),
      confirm: z.string(),
    }),
    cashiers: z
      .array(
        z.object({
          name: z.string().trim().min(2, 'Enter a name').max(30, 'Keep it short'),
          counter: z.string().trim().min(1, 'Enter a counter').max(20, 'Keep it short'),
          pin: z.string().regex(/^\d{4}$/, '4 digits'),
        })
      )
      .max(20, 'Up to 20 cashiers'),
    counter: z.object({
      counter: z.string().trim().min(1, 'Name this counter').max(20, 'Keep it short'),
      upiId: z.union([z.literal(''), z.string().trim().regex(UPI, 'Looks like name@bank, e.g. store@okaxis')]),
      paperWidth: z.union([z.literal(58), z.literal(80)]),
      printMethod: z.enum(['browser', 'serial', 'desktop']),
      desktopPrinter: z.string(),
      autoPrint: z.boolean(),
      openDrawer: z.boolean(),
    }),
  })
  .superRefine((v, ctx) => {
    refineProfile(v, ctx);
    if (v.owner.confirm !== v.owner.password) ctx.addIssue({ code: 'custom', path: ['owner', 'confirm'], message: 'The passwords don’t match' });
    // Connected: the owner signs in to the server with email + a 10-character password.
    if (apiConfigured) {
      if (!v.owner.email) ctx.addIssue({ code: 'custom', path: ['owner', 'email'], message: 'Enter the owner’s email — it’s used to sign in' });
      if (v.owner.password.length < 10) ctx.addIssue({ code: 'custom', path: ['owner', 'password'], message: 'Use at least 10 characters' });
      if (!/^[A-Z0-9]{2,4}$/.test(v.invoicePrefix.trim().toUpperCase()))
        ctx.addIssue({ code: 'custom', path: ['invoicePrefix'], message: '2–4 letters or digits' });
    }
    const seen = new Set([v.owner.name.trim().toLowerCase()]);
    v.cashiers.forEach((c, i) => {
      const n = c.name.trim().toLowerCase();
      if (n && seen.has(n)) ctx.addIssue({ code: 'custom', path: ['cashiers', i, 'name'], message: 'Each person needs a different name' });
      seen.add(n);
    });
  });

type Values = z.infer<typeof schema>;

const blankValues = (): Values => ({
  businessType: '' as BusinessType, // chosen on the first step
  displayName: '',
  legalName: '',
  ownerName: '',
  phone: '',
  email: '',
  address: { line1: '', line2: '', city: '', pincode: '', stateCode: '' },
  registration: 'regular',
  gstin: '',
  fssai: '',
  drugLicence: '',
  invoicePrefix: '',
  receiptFooter: defaultProfile.receiptFooter,
  modules: presetModules.grocery,
  startingBillNo: 1,
  owner: { name: '', phone: '', email: '', password: '', confirm: '' },
  cashiers: [],
  counter: {
    counter: 'Counter 1',
    upiId: '',
    paperWidth: 80,
    printMethod: typeof window !== 'undefined' && window.posDesktop ? 'desktop' : 'browser',
    desktopPrinter: '',
    autoPrint: false,
    openDrawer: true,
  },
});

const toProfile = (v: Values): BusinessProfile => ({
  businessType: v.businessType || 'grocery',
  displayName: v.displayName.trim(),
  legalName: v.legalName.trim(),
  ownerName: v.owner.name.trim(),
  phone: v.phone.trim(),
  email: v.email.trim(),
  address: v.address,
  registration: v.registration,
  gstin: v.registration === 'unregistered' ? '' : v.gstin.trim().toUpperCase(),
  fssai: v.fssai.trim(),
  drugLicence: v.drugLicence.trim(),
  invoicePrefix: v.invoicePrefix.trim().toUpperCase() || 'INV',
  receiptFooter: v.receiptFooter.trim(),
  // Only features that fit the business type stay on.
  modules: Object.fromEntries(
    (Object.keys(v.modules) as ModuleKey[]).map((k) => [k, !!v.modules[k] && relevantModules[v.businessType || 'grocery'].includes(k)])
  ) as Modules,
  isSample: false,
});

/** "Arogya Medicals" → "AM", "Senthil Fresh Mart" → "SFM". */
const suggestPrefix = (name: string) => {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return (words.length === 1 ? words[0]!.slice(0, 3) : words.map((w) => w[0]).join('').slice(0, 4)).slice(0, 8);
};

/* =====================================================================
   Steps
   ===================================================================== */

type Step = { id: string; title: string; sub: string; icon: IconType; fields: FieldPath<Values>[] };

const steps: Step[] = [
  { id: 'type', title: 'Business type', sub: 'What kind of store is this?', icon: BadgeCheck, fields: ['businessType', 'modules'] },
  { id: 'store', title: 'Store details', sub: 'Name and address printed on every bill', icon: MapPin, fields: ['displayName', 'legalName', 'phone', 'email', 'address'] },
  {
    id: 'gst',
    title: 'GST & billing',
    sub: 'Registration, licences and bill numbers',
    icon: Landmark,
    fields: ['registration', 'gstin', 'fssai', 'drugLicence', 'invoicePrefix', 'startingBillNo', 'receiptFooter', 'address.stateCode'],
  },
  { id: 'staff', title: 'Owner & staff', sub: 'Who signs in to this system', icon: Users, fields: ['owner', 'cashiers'] },
  { id: 'counter', title: 'This counter', sub: 'Counter name, UPI and receipt printer', icon: Monitor, fields: ['counter'] },
  { id: 'review', title: 'Review & finish', sub: 'Check everything, then start billing', icon: ClipboardCheck, fields: [] },
];

type Phase = 'welcome' | number | 'done';

/* =====================================================================
   Small pieces
   ===================================================================== */

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${checked ? 'bg-blue' : 'bg-line'}`}
    >
      <span className={`absolute top-0.5 size-5 rounded-full bg-surface shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

function Choice({
  active,
  onClick,
  children,
  className = '',
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`relative rounded-xl border-2 p-3 text-left transition ${active ? 'border-blue bg-blue/5' : 'border-line hover:border-blue/40'} ${className}`}
    >
      {children}
      {active && (
        <span className="absolute right-2 top-2 grid size-5 place-items-center rounded-full bg-blue text-onbrand">
          <Check className="size-3.5" />
        </span>
      )}
    </button>
  );
}

function Note({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: ReactNode }) {
  return (
    <p
      className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-[12.5px] ${
        tone === 'warn' ? 'bg-amber/10 text-amber' : 'bg-blue/5 text-sub'
      }`}
    >
      {tone === 'warn' ? <TriangleAlert className="mt-0.5 size-4 shrink-0" /> : <Info className="mt-0.5 size-4 shrink-0 text-blue" />}
      <span>{children}</span>
    </p>
  );
}

function SummaryCard({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-bold text-ink">{title}</h3>
        <button type="button" onClick={onEdit} className="text-[12px] font-semibold text-blue hover:underline">
          Edit
        </button>
      </div>
      <dl className="space-y-1 text-[12.5px]">{children}</dl>
    </div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-mute">{k}</dt>
      <dd className="min-w-0 font-medium text-ink">{v || '—'}</dd>
    </div>
  );
}

const passwordStrength = (p: string) => {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return Math.min(4, s);
};
const strengthMeta = [
  { label: 'Too short', cls: 'bg-coral' },
  { label: 'Weak', cls: 'bg-coral' },
  { label: 'Fair', cls: 'bg-amber' },
  { label: 'Good', cls: 'bg-teal' },
  { label: 'Strong', cls: 'bg-teal' },
];

const sampleLines: CartLine[] = [
  { key: 'a', sku: null, name: 'Sample item A', hsn: '1006', gst: 5, price: 240, qty: 1, discount: null },
  { key: 'b', sku: null, name: 'Sample item B', hsn: '3402', gst: 18, price: 95, qty: 2, discount: null },
];

const sampleInvoice = (p: BusinessProfile, startNo: number): Invoice => {
  const bos = p.registration !== 'regular';
  const totals = computeBill(bos ? sampleLines.map((l) => ({ ...l, gst: 0 as const })) : sampleLines, null);
  return {
    kind: 'invoice',
    no: invoiceNo(p.invoicePrefix, new Date(), startNo),
    issuedAt: new Date().toISOString(),
    cashier: p.ownerName || 'Owner',
    counter: '',
    buyer: null,
    interState: false,
    lines: sampleLines,
    billDiscount: null,
    totals,
    payments: [{ method: 'Cash', amount: totals.payable }],
    change: 0,
    returned: {},
    refunded: 0,
    billOfSupply: bos,
  };
};

/* =====================================================================
   Wizard
   ===================================================================== */

export function SetupWizard() {
  const router = useRouter();
  const hydrated = useHydrated();
  const setup = useSetup();
  const session = useSession();
  const [phase, setPhase] = useState<Phase>('welcome');
  const [restored, setRestored] = useState(false);
  /** Step they had reached before closing the app. */
  const [resumeAt, setResumeAt] = useState(0);
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [printers, setPrinters] = useState<DesktopPrinter[]>([]);
  const [printDoc, setPrintDoc] = useState<Invoice | null>(null);
  const [printMsg, setPrintMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [prefixTouched, setPrefixTouched] = useState(false);
  const finishing = useRef(false);
  const mainRef = useRef<HTMLDivElement>(null);
  const desktop = typeof window !== 'undefined' ? window.posDesktop : undefined;

  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: blankValues(), mode: 'onTouched' });
  const {
    register,
    control,
    setValue,
    getValues,
    trigger,
    reset,
    handleSubmit,
    formState: { errors },
  } = form;
  const cashiers = useFieldArray({ control, name: 'cashiers' });
  const v = useWatch({ control }) as Values;

  // Already set up (e.g. someone opens /setup again) → leave. Connected, the business lives on the
  // server, so /setup is for registering a new one: only someone signed in is sent on.
  const done = apiConfigured ? !!session : !!setup;
  useEffect(() => {
    if (hydrated && done && !finishing.current) router.replace(session ? homeFor(session.role) : '/login');
  }, [hydrated, done, session, router]);
  const [error, setError] = useState<string | null>(null);

  // Restore an unfinished setup (passwords and PINs are never saved in the draft).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as { values: Partial<Values>; phase: Phase };
      const base = blankValues();
      reset({
        ...base,
        ...d.values,
        address: { ...base.address, ...d.values.address },
        counter: { ...base.counter, ...d.values.counter },
        owner: { ...base.owner, ...d.values.owner, password: '', confirm: '' },
        cashiers: (d.values.cashiers ?? []).map((c) => ({ ...c, pin: '' })),
      });
      if (typeof d.phase === 'number') setResumeAt(Math.min(d.phase, steps.length - 1));
      if (d.values.invoicePrefix) setPrefixTouched(true);
      setRestored(true);
    } catch {
      /* ignore a broken draft */
    }
  }, [reset]);

  /** Saves progress (never the password or PINs) so a reload or crash doesn't lose the answers. */
  const saveDraft = useCallback(
    (at: Phase) => {
      if (typeof at !== 'number' || finishing.current) return;
      const values = getValues();
      const safe = {
        ...values,
        owner: { ...values.owner, password: '', confirm: '' },
        cashiers: values.cashiers.map((c) => ({ ...c, pin: '' })),
      };
      try {
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ values: safe, phase: at }));
      } catch {
        /* storage full or blocked — setup still works, it just can't resume */
      }
    },
    [getValues]
  );

  // Save shortly after typing stops. The form's own change events drive this, so ordinary
  // re-renders can't keep postponing it.
  useEffect(() => {
    if (typeof phase !== 'number') return;
    let t = 0;
    const sub = form.watch(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => saveDraft(phase), 300);
    });
    return () => {
      sub.unsubscribe();
      window.clearTimeout(t);
    };
  }, [form, phase, saveDraft]);

  useEffect(() => {
    desktop
      ?.getPrinters()
      .then(setPrinters)
      .catch(() => setPrinters([]));
  }, [desktop]);

  // Suggest an invoice prefix from the store name — but never overwrite one they typed or one
  // restored from a saved draft (only replace it while it's empty or still our own last suggestion).
  const lastSuggestion = useRef('');
  useEffect(() => {
    const current = getValues('invoicePrefix');
    if (prefixTouched || (current && current !== lastSuggestion.current)) return;
    const suggestion = suggestPrefix(v.displayName ?? '').slice(0, apiConfigured ? 4 : 8);
    lastSuggestion.current = suggestion;
    if (suggestion !== current) setValue('invoicePrefix', suggestion);
  }, [v.displayName, prefixTouched, setValue, getValues]);

  const profile = useMemo(() => toProfile({ ...blankValues(), ...v } as Values), [v]);
  const previewDoc = useMemo(() => sampleInvoice(profile, Number(v.startingBillNo) || 1), [profile, v.startingBillNo]);

  const stepIndex = typeof phase === 'number' ? phase : -1;
  const step = steps[stepIndex];
  const businessType = (v.businessType || '') as BusinessType | '';
  const registration = (v.registration ?? 'regular') as Registration;
  const licences = businessType ? suggestedLicences[businessType] : [];
  // Only the licences this type of business has (or one already filled in).
  const offered = businessType ? licenceFields[businessType] : [];
  const showFssai = offered.includes('fssai') || !!v.fssai;
  const showDrug = offered.includes('drugLicence') || !!v.drugLicence;

  const goTo = useCallback(
    (p: Phase) => {
      saveDraft(p); // every step change is saved straight away
      setPhase(p);
      mainRef.current?.scrollTo({ top: 0 });
    },
    [saveDraft]
  );

  const next = async () => {
    if (!step) return;
    if (step.id === 'type' && !getValues('businessType')) {
      form.setError('businessType', { message: 'Choose the type of business to continue' });
      return;
    }
    const ok = step.fields.length ? await trigger(step.fields, { shouldFocus: true }) : true;
    if (ok) goTo(stepIndex + 1);
  };

  /** Connected: registers the business, its owner and head-office branch on the server, then signs in. */
  const finishLive = async (values: Values) => {
    const p = toProfile(values);
    const opt = <T extends string>(k: string, s: T) => (s.trim() ? { [k]: s.trim() } : {});
    setBusy(true);
    setError(null);
    finishing.current = true;
    try {
      const res = await fetch(`${API_URL}/tenants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          business: {
            displayName: p.displayName,
            ...opt('legalName', p.legalName),
            businessType: p.businessType,
            registration: p.registration.toUpperCase(),
            ...opt('gstin', p.gstin),
            stateCode: p.address.stateCode,
            ...opt('phone', p.phone),
            ...opt('email', p.email),
            address: { line1: p.address.line1.trim(), ...opt('line2', p.address.line2), city: p.address.city.trim(), pincode: p.address.pincode.trim() },
          },
          owner: { name: values.owner.name.trim(), email: values.owner.email.trim(), password: values.owner.password },
          hq: { code: p.invoicePrefix.slice(0, 4) },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string; details?: { field?: string; issue?: string }[] } } | null;
        const issues = (body?.error?.details ?? []).map((d) => `${d.field ? `${d.field}: ` : ''}${d.issue ?? ''}`);
        throw new Error(issues.length ? `Please fix: ${issues.join('; ')}` : (body?.error?.message ?? `Could not create the business (${res.status}).`));
      }
      const signed = await liveSignIn(values.owner.email.trim(), values.owner.password);
      if (!signed.ok) throw new Error('The business was created, but signing in failed — sign in on the login page.');
      // This computer's counter settings (printer, UPI) stay on this computer.
      saveLocal('settings', { ...defaultSettings, ...values.counter, printMethod: values.counter.printMethod as PrintMethod, cashier: values.owner.name.trim() });
      try {
        window.localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      goTo('done');
    } catch (e) {
      finishing.current = false;
      setError(e instanceof Error ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = handleSubmit(
    (values) => {
      if (apiConfigured) return void finishLive(values);
      setBusy(true);
      finishing.current = true;
      window.setTimeout(() => {
        const ownerId = finishSetup({
          profile: toProfile(values),
          owner: values.owner,
          cashiers: values.cashiers,
          counter: { ...values.counter, printMethod: values.counter.printMethod as PrintMethod },
          startingBillNo: values.startingBillNo,
        });
        signInAs(ownerId);
        setBusy(false);
        goTo('done');
      }, 500);
    },
    (errs) => {
      // Jump to the first step that still has a problem.
      const keys = Object.keys(errs);
      const i = steps.findIndex((s) => s.fields.some((f) => keys.includes(f.split('.')[0]!)));
      if (i >= 0) goTo(i);
    }
  );

  const chooseType = (t: BusinessType) => {
    setValue('businessType', t, { shouldDirty: true, shouldValidate: true });
    setValue('modules', presetModules[t]);
  };

  const gstinField = register('gstin', {
    onChange: (e: { target: { value: string } }) => {
      const g = e.target.value.trim().toUpperCase();
      if (!gstinProblem(g) && gstStates[g.slice(0, 2)]) setValue('address.stateCode', g.slice(0, 2), { shouldValidate: true });
    },
  });

  const testPrint = async () => {
    setPrintMsg(null);
    const c = getValues('counter');
    const doc = sampleInvoice(profile, Number(getValues('startingBillNo')) || 1);
    try {
      if (c.printMethod === 'serial') {
        if (!(await hasSerialPrinter())) await connectSerialPrinter();
        await printEscPos(toEscPos(doc, c.paperWidth, { profile, kickDrawer: c.openDrawer }), 9600);
        setPrintMsg({ ok: true, text: 'Sent to the printer. Check the receipt and the cash drawer.' });
        return;
      }
      setPrintDoc(doc);
      await new Promise((r) => window.setTimeout(r, 80));
      if (c.printMethod === 'desktop' && desktop) {
        const res = await desktop.print(c.desktopPrinter ? { deviceName: c.desktopPrinter } : {});
        setPrintMsg(res.ok ? { ok: true, text: 'Printed. Check the receipt looks right.' } : { ok: false, text: res.reason ?? 'Could not print' });
      } else {
        window.print();
        setPrintMsg({ ok: true, text: 'Print dialog opened — pick the receipt printer and set margins to none.' });
      }
    } catch (e) {
      setPrintMsg({ ok: false, text: e instanceof Error && e.name !== 'NotFoundError' ? e.message : 'No printer selected.' });
    }
  };

  if (!hydrated || (done && phase !== 'done' && !finishing.current)) return <div className="min-h-dvh bg-bg" />;

  /* ---------- welcome ---------- */
  if (phase === 'welcome')
    return (
      <div className="grid min-h-dvh bg-surface lg:grid-cols-[minmax(0,1fr)_minmax(460px,1fr)]">
        <SetupStyles />
        <section
          className="relative hidden flex-col justify-between overflow-hidden bg-[#151a3a] bg-cover bg-center p-12 text-white lg:flex"
          style={{ backgroundImage: 'url(/login-bg.svg)' }}
        >
          <div className="setup-in flex items-center gap-3">
            <BrandLogo className="h-16" />
          </div>
          <div className="setup-in max-w-[520px]" style={{ animationDelay: '120ms' }}>
            <h1 className="text-[40px] font-extrabold leading-[1.1] tracking-tight">
              Let&apos;s set up <span className="bg-gradient-to-r from-cyan-300 to-violet-300 bg-clip-text text-transparent">your store.</span>
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-white/70">
              A few questions and this computer is ready to bill — with your store&apos;s name, GSTIN and staff on every receipt.
            </p>
            <ol className="mt-8 space-y-3">
              {steps.map((s, i) => (
                <li key={s.id} className="setup-in flex items-center gap-3" style={{ animationDelay: `${200 + i * 80}ms` }}>
                  <span className="grid size-8 place-items-center rounded-lg border border-white/15 bg-white/10 text-[12px] font-bold">{i + 1}</span>
                  <span className="text-[14px] font-semibold">{s.title}</span>
                  <span className="text-[12.5px] text-white/50">— {s.sub}</span>
                </li>
              ))}
            </ol>
          </div>
          <p className="setup-in flex items-center gap-2 text-[12.5px] text-white/60" style={{ animationDelay: '700ms' }}>
            <Clock3 className="size-4" /> About 5 minutes · progress is saved as you go
          </p>
        </section>

        <main className="flex flex-col justify-center px-6 py-10 sm:px-12">
          <div className="mx-auto w-full max-w-[460px]">
            <div className="mb-8 flex items-center gap-2.5 lg:hidden">
              <BrandBadge className="h-10" />
            </div>
            <span className="inline-flex items-center gap-2 rounded-full bg-teal/15 px-3 py-1 text-[12px] font-semibold text-teal">
              <CircleCheck className="size-3.5" /> {apiConfigured ? 'Connected to your server' : 'Installed on this computer'}
            </span>
            <h2 className="mt-4 text-[28px] font-extrabold tracking-tight text-ink">Welcome to {APP_NAME}</h2>
            <p className="mt-1 text-[14px] text-sub">How would you like to start?</p>

            {restored && (
              <div className="mt-5">
                <Note>
                  <span className="flex items-center gap-1.5">
                    <History className="size-4" /> You started setting up earlier — your answers are saved.
                  </span>
                </Note>
              </div>
            )}

            <div className="mt-6 space-y-3">
              <button
                type="button"
                onClick={() => goTo(restored ? resumeAt : 0)}
                className="group flex w-full items-center gap-4 rounded-2xl border-2 border-blue bg-blue/5 p-4 text-left transition hover:bg-blue/10"
              >
                <span className="grid size-12 shrink-0 place-items-center rounded-xl gbv text-onbrand shadow-lg shadow-blue/25">
                  <Rocket className="size-6" />
                </span>
                <span className="flex-1">
                  <span className="block text-[15px] font-bold text-ink">{restored ? 'Continue setting up' : 'Set up my store'}</span>
                  <span className="block text-[12.5px] text-sub">Business type, store &amp; GST details, staff and printer.</span>
                </span>
                <ArrowRight className="size-5 text-blue transition group-hover:translate-x-0.5" />
              </button>
              {apiConfigured ? (
                <button
                  type="button"
                  onClick={() => router.replace('/login')}
                  className="group flex w-full items-center gap-4 rounded-2xl border-2 border-line p-4 text-left transition hover:border-blue/40"
                >
                  <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-bg text-sub">
                    <LogIn className="size-6" />
                  </span>
                  <span className="flex-1">
                    <span className="block text-[15px] font-bold text-ink">My business is already set up</span>
                    <span className="block text-[12.5px] text-sub">Sign in with your email and password, or a cashier PIN.</span>
                  </span>
                  <ArrowRight className="size-5 text-mute transition group-hover:translate-x-0.5" />
                </button>
              ) : (
              <button
                type="button"
                onClick={() => {
                  startDemo();
                  router.replace('/login');
                }}
                className="group flex w-full items-center gap-4 rounded-2xl border-2 border-line p-4 text-left transition hover:border-blue/40"
              >
                <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-bg text-sub">
                  <CirclePlay className="size-6" />
                </span>
                <span className="flex-1">
                  <span className="block text-[15px] font-bold text-ink">Explore with demo data</span>
                  <span className="block text-[12.5px] text-sub">A sample grocery store with demo staff — for training or a quick look.</span>
                </span>
                <ArrowRight className="size-5 text-mute transition group-hover:translate-x-0.5" />
              </button>
              )}
            </div>

            <div className="mt-8 rounded-2xl bg-bg p-4">
              <h3 className="flex items-center gap-2 text-[13px] font-bold text-ink">
                <ClipboardCheck className="size-4 text-blue" /> Installing for a customer? Keep these handy
              </h3>
              <ul className="mt-2 grid gap-1.5 text-[12.5px] text-sub sm:grid-cols-2">
                {['GSTIN certificate', 'FSSAI / drug licence no.', "Owner's mobile number", 'Store UPI ID', 'Last bill number used', 'Receipt printer connected'].map(
                  (t) => (
                    <li key={t} className="flex items-center gap-2">
                      <Check className="size-3.5 text-teal" /> {t}
                    </li>
                  )
                )}
              </ul>
            </div>
          </div>
        </main>
      </div>
    );

  /* ---------- done ---------- */
  if (phase === 'done')
    return (
      <div className="grid min-h-dvh place-items-center bg-bg px-5 py-10">
        <SetupStyles />
        <div className="setup-pop w-full max-w-[520px] rounded-3xl bg-surface p-8 text-center shadow-xl">
          <span className="mx-auto grid size-16 place-items-center rounded-full bg-teal/15 text-teal">
            <PartyPopper className="size-8" />
          </span>
          <h1 className="mt-4 text-[26px] font-extrabold text-ink">{profile.displayName} is ready!</h1>
          <p className="mt-1 text-sub">You&apos;re signed in as {profile.ownerName} (owner).</p>
          <ul className="mt-6 space-y-2 rounded-2xl bg-bg p-4 text-left text-[13px]">
            {!apiConfigured && (
              <li className="flex items-center gap-2">
                <Check className="size-4 text-teal" /> First bill: <b className="font-mono text-ink">{previewDoc.no}</b>
              </li>
            )}
            <li className="flex items-center gap-2">
              <Check className="size-4 text-teal" /> {registrationInfo[profile.registration].label}
              {profile.gstin && <span className="font-mono text-sub">· {profile.gstin}</span>}
            </li>
            <li className="flex items-center gap-2">
              <Check className="size-4 text-teal" /> {1 + (v.cashiers?.length ?? 0)} staff account{v.cashiers?.length ? 's' : ''} ·{' '}
              {v.counter?.counter}
            </li>
          </ul>
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => router.replace('/pos')}
              className="flex h-12 items-center justify-center gap-2 rounded-xl gbv font-bold text-onbrand shadow-lg shadow-blue/25"
            >
              <ScanBarcode className="size-5" /> Start billing
            </button>
            <button
              type="button"
              onClick={() => router.replace('/dashboard')}
              className="flex h-12 items-center justify-center gap-2 rounded-xl border border-line font-bold text-ink hover:border-blue"
            >
              <LayoutDashboard className="size-5" /> Open dashboard
            </button>
          </div>
          <p className="mt-5 text-[12px] text-mute">Change any of this later in Business profile and POS settings.</p>
        </div>
      </div>
    );

  /* ---------- steps ---------- */
  return (
    <div className="grid min-h-dvh bg-bg lg:h-dvh lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)]">
      <SetupStyles />
      {/* Stepper */}
      <aside
        className="relative hidden flex-col overflow-hidden bg-[#151a3a] bg-cover bg-center p-8 text-white lg:flex"
        style={{ backgroundImage: 'url(/login-bg.svg)' }}
      >
        <div className="flex items-center gap-3">
          <BrandLogo className="h-16" />
        </div>
        <ol className="mt-10 space-y-1">
          {steps.map((s, i) => {
            const done = i < stepIndex;
            const current = i === stepIndex;
            const I = s.icon;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => i < stepIndex && goTo(i)}
                  disabled={i > stepIndex}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${current ? 'bg-white/10' : done ? 'hover:bg-white/5' : 'opacity-50'}`}
                >
                  <span
                    className={`grid size-8 shrink-0 place-items-center rounded-full border-2 text-[12px] font-bold ${
                      done ? 'border-emerald-400 bg-emerald-400 text-emerald-950' : current ? 'border-white bg-white text-[#1f1b4d]' : 'border-white/30'
                    }`}
                  >
                    {done ? <Check className="size-4" /> : <I className="size-4" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold">{s.title}</span>
                    <span className="block truncate text-[11.5px] text-white/55">{s.sub}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="mt-auto space-y-2 text-[12px] text-white/55">
          <p className="flex items-center gap-2">
            <ShieldCheck className="size-4" /> Passwords and PINs are never saved in the draft.
          </p>
          <p className="flex items-center gap-2">
            <History className="size-4" /> Progress is saved — you can close and come back.
          </p>
        </div>
      </aside>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (step?.id === 'review') void finish();
          else void next();
        }}
        noValidate
        className="flex min-h-0 flex-col"
      >
        {/* progress (all sizes) */}
        <div className="h-1 bg-line">
          <div className="h-full bg-blue transition-all duration-500" style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }} />
        </div>

        <div ref={mainRef} className="min-h-0 flex-1 overflow-y-auto">
          <div key={stepIndex} className="setup-in mx-auto w-full max-w-[760px] px-5 py-8 sm:px-8">
            <p className="text-[12px] font-semibold uppercase tracking-wider text-blue">
              Step {stepIndex + 1} of {steps.length}
            </p>
            <h1 className="mt-1 text-[26px] font-extrabold tracking-tight text-ink">{step?.title}</h1>
            <p className="mt-1 text-[14px] text-sub">{step?.sub}</p>

            <div className="mt-6 space-y-5 text-[13px]">
              {/* ---------- 1. business type ---------- */}
              {step?.id === 'type' && (
                <>
                  <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4" role="radiogroup" aria-label="Type of business">
                    {(Object.keys(businessTypes) as BusinessType[]).map((t) => {
                      const I = typeIcon[t];
                      const active = businessType === t;
                      return (
                        <Choice key={t} active={active} onClick={() => chooseType(t)} className="flex flex-col gap-2">
                          <span className={`grid size-10 place-items-center rounded-xl ${active ? 'gbv text-onbrand' : 'bg-bg text-sub'}`}>
                            <I className="size-5" />
                          </span>
                          <span className="block pr-5 text-[13px] font-bold leading-tight text-ink">{businessTypes[t].label}</span>
                          <span className="block text-[11px] leading-snug text-mute">{businessTypes[t].blurb}</span>
                        </Choice>
                      );
                    })}
                  </div>
                  {errors.businessType && <p className="text-[12px] font-semibold text-coral">{errors.businessType.message}</p>}
                  {!businessType && (
                    <p className="rounded-2xl border border-dashed border-line px-4 py-5 text-center text-[12.5px] text-sub">
                      Pick your type of business — we&apos;ll show the features that fit it.
                    </p>
                  )}
                  {businessType && (
                    <div key={businessType} className="setup-in rounded-2xl border border-line bg-surface p-4">
                      <h2 className="font-bold text-ink">Features for {businessTypes[businessType].label.toLowerCase()}</h2>
                      <p className="mt-0.5 text-[12px] text-sub">We switched on what usually suits this business. You can change these any time.</p>
                      <ul className="mt-3 divide-y divide-line">
                        {relevantModules[businessType].map((k) => (
                          <li key={k} className="flex items-center gap-3 py-2.5">
                            <div className="min-w-0 flex-1">
                              <span className="font-semibold text-ink">{moduleInfo[k].label}</span>
                              {!moduleInfo[k].available && (
                                <span className="ml-1.5 rounded-full bg-bg px-2 py-0.5 text-[10px] font-semibold text-mute">Coming soon</span>
                              )}
                              <p className="text-[12px] text-sub">{moduleInfo[k].desc}</p>
                            </div>
                            <Toggle
                              label={moduleInfo[k].label}
                              disabled={!moduleInfo[k].available}
                              checked={moduleInfo[k].available ? !!v.modules?.[k] : false}
                              onChange={(on) => setValue(`modules.${k}`, on)}
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}

              {/* ---------- 2. store ---------- */}
              {step?.id === 'store' && (
                <div className="space-y-4 rounded-2xl border border-line bg-surface p-5">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Store name" hint="(printed large on bills)" error={errors.displayName?.message}>
                      <input {...register('displayName')} autoFocus placeholder="e.g. Senthil Fresh Mart" className={`${fieldCls} ${borderCls(!!errors.displayName)}`} />
                    </Field>
                    <Field label="Registered legal name" hint="(if different)" error={errors.legalName?.message}>
                      <input {...register('legalName')} placeholder="As on the GST certificate" className={`${fieldCls} ${borderCls(!!errors.legalName)}`} />
                    </Field>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Store phone" error={errors.phone?.message}>
                      <input {...register('phone')} inputMode="tel" placeholder="+91 44 2626 1234" className={`${fieldCls} ${borderCls(!!errors.phone)}`} />
                    </Field>
                    <Field label="Store email" hint="(optional)" error={errors.email?.message}>
                      <input {...register('email')} type="email" className={`${fieldCls} ${borderCls(!!errors.email)}`} />
                    </Field>
                  </div>
                  <Field label="Address" error={errors.address?.line1?.message}>
                    <input {...register('address.line1')} placeholder="Door no., street, area" className={`${fieldCls} ${borderCls(!!errors.address?.line1)}`} />
                  </Field>
                  <input {...register('address.line2')} placeholder="Landmark (optional)" aria-label="Address line 2" className={`${fieldCls} border-line`} />
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="City" error={errors.address?.city?.message}>
                      <input {...register('address.city')} className={`${fieldCls} ${borderCls(!!errors.address?.city)}`} />
                    </Field>
                    <Field label="State" error={errors.address?.stateCode?.message}>
                      <select {...register('address.stateCode')} className={`${fieldCls} ${borderCls(!!errors.address?.stateCode)}`}>
                        <option value="">Choose…</option>
                        {Object.entries(gstStates)
                          .sort((a, b) => a[1].localeCompare(b[1]))
                          .map(([code, name]) => (
                            <option key={code} value={code}>
                              {name}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <Field label="PIN code" error={errors.address?.pincode?.message}>
                      <input {...register('address.pincode')} inputMode="numeric" maxLength={6} className={`${fieldCls} ${borderCls(!!errors.address?.pincode)}`} />
                    </Field>
                  </div>
                </div>
              )}

              {/* ---------- 3. GST & billing ---------- */}
              {step?.id === 'gst' && (
                <>
                  <div className="space-y-4 rounded-2xl border border-line bg-surface p-5">
                    <h2 className="font-bold text-ink">GST registration</h2>
                    <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="GST registration">
                      {(Object.keys(registrationInfo) as Registration[]).map((r) => (
                        <Choice key={r} active={registration === r} onClick={() => setValue('registration', r, { shouldValidate: !!errors.gstin })}>
                          <span className="block pr-5 font-bold text-ink">{registrationInfo[r].label}</span>
                          <span className="mt-1 block text-[11.5px] leading-snug text-sub">{registrationInfo[r].desc}</span>
                        </Choice>
                      ))}
                    </div>
                    {registration !== 'unregistered' && (
                      <Field label="GSTIN" hint="(15 characters, from the GST certificate)" error={errors.gstin?.message ?? errors.address?.stateCode?.message}>
                        <input
                          {...gstinField}
                          maxLength={15}
                          spellCheck={false}
                          placeholder="33ABCDE1234F1Z5"
                          className={`${fieldCls} font-mono uppercase tracking-wider ${borderCls(!!errors.gstin)}`}
                        />
                      </Field>
                    )}
                    {registration !== 'unregistered' && !errors.gstin && v.gstin && !gstinProblem(v.gstin) && (
                      <Note>
                        GSTIN checks out — registered in <b className="text-ink">{gstStates[v.gstin.toUpperCase().slice(0, 2)]}</b>. The store&apos;s state has been
                        set to match.
                      </Note>
                    )}
                    {registration === 'composition' && (
                      <Note>Bills will be titled Bill of Supply, show no GST, and carry the composition declaration.</Note>
                    )}
                  </div>

                  {(showFssai || showDrug) && (
                  <div className="space-y-4 rounded-2xl border border-line bg-surface p-5">
                    <h2 className="font-bold text-ink">Licences on the bill</h2>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {showFssai && (
                      <Field
                        label="FSSAI licence no."
                        hint={licences.includes('fssai') ? '(required for food businesses)' : '(if you sell food)'}
                        error={errors.fssai?.message}
                      >
                        <input {...register('fssai')} inputMode="numeric" maxLength={14} className={`${fieldCls} font-mono ${borderCls(!!errors.fssai)}`} />
                      </Field>
                      )}
                      {showDrug && (
                      <Field
                        label="Drug licence no(s)."
                        hint={licences.includes('drugLicence') ? '(required for pharmacies)' : '(pharmacies only)'}
                        error={errors.drugLicence?.message}
                      >
                        <input {...register('drugLicence')} placeholder="e.g. TN-01-20B-12345" className={`${fieldCls} ${borderCls(!!errors.drugLicence)}`} />
                      </Field>
                      )}
                    </div>
                    {licences.length > 0 &&
                      ((licences.includes('fssai') && !v.fssai) || (licences.includes('drugLicence') && !v.drugLicence)) && (
                        <Note tone="warn">
                          {licences.includes('drugLicence') ? 'Pharmacy bills must show the drug licence number.' : 'Food business bills must show the FSSAI licence number.'}{' '}
                          You can add it later in Business profile.
                        </Note>
                      )}
                  </div>
                  )}

                  <div className="space-y-4 rounded-2xl border border-line bg-surface p-5">
                    <h2 className="font-bold text-ink">Bill numbers</h2>
                    <div className="grid gap-3 sm:grid-cols-[160px_160px_1fr]">
                      <Field label={apiConfigured ? 'Branch code' : 'Invoice prefix'} error={errors.invoicePrefix?.message}>
                        <input
                          {...register('invoicePrefix', { onChange: () => setPrefixTouched(true) })}
                          maxLength={apiConfigured ? 4 : 8}
                          className={`${fieldCls} font-mono uppercase ${borderCls(!!errors.invoicePrefix)}`}
                        />
                      </Field>
                      {apiConfigured ? (
                        <p className="self-end pb-2.5 text-[12px] text-sub sm:col-span-2">
                          2–4 letters, e.g. <b className="font-mono text-ink">{(v.invoicePrefix || 'SFM').toUpperCase()}</b>. Bills are numbered per branch and financial year by the server.
                        </p>
                      ) : (
                      <>
                      <Field label="First bill number" error={errors.startingBillNo?.message}>
                        <input
                          type="number"
                          min={1}
                          {...register('startingBillNo', { valueAsNumber: true })}
                          className={`${fieldCls} tabular-nums ${borderCls(!!errors.startingBillNo)}`}
                        />
                      </Field>
                      <div className="self-end pb-2.5 text-[12px] text-sub">
                        First bill: <b className="font-mono text-ink">{previewDoc.no}</b>
                      </div>
                      </>
                      )}
                    </div>
                    {!apiConfigured && (
                      <Note>
                        Moving from another billing system? Enter the next number after the last bill you issued this financial year, so the GST bill series
                        continues without a gap.
                      </Note>
                    )}
                    <Field label="Message at the bottom of the bill" hint="(return policy, thank-you note)" error={errors.receiptFooter?.message}>
                      <input {...register('receiptFooter')} className={`${fieldCls} ${borderCls(!!errors.receiptFooter)}`} />
                    </Field>
                  </div>
                </>
              )}

              {/* ---------- 4. staff ---------- */}
              {step?.id === 'staff' && (
                <>
                  <div className="space-y-4 rounded-2xl border border-line bg-surface p-5">
                    <div>
                      <h2 className="font-bold text-ink">Owner account</h2>
                      <p className="text-[12px] text-sub">
                        Signs in with {apiConfigured ? 'email' : 'mobile number'} + password. Sees everything, including reports and settings.
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Owner name" error={errors.owner?.name?.message}>
                        <input {...register('owner.name')} autoFocus className={`${fieldCls} ${borderCls(!!errors.owner?.name)}`} />
                      </Field>
                      <Field label="Mobile number" hint={apiConfigured ? '' : '(used to sign in)'} error={errors.owner?.phone?.message}>
                        <input {...register('owner.phone')} inputMode="tel" placeholder="98400 12345" className={`${fieldCls} ${borderCls(!!errors.owner?.phone)}`} />
                      </Field>
                    </div>
                    <Field
                      label="Email"
                      hint={apiConfigured ? '(used to sign in)' : '(optional, can also be used to sign in)'}
                      error={errors.owner?.email?.message}
                    >
                      <input {...register('owner.email')} type="email" className={`${fieldCls} ${borderCls(!!errors.owner?.email)}`} />
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Password" error={errors.owner?.password?.message}>
                        <span className="relative block">
                          <input
                            {...register('owner.password')}
                            type={showPw ? 'text' : 'password'}
                            autoComplete="new-password"
                            className={`${fieldCls} pr-10 ${borderCls(!!errors.owner?.password)}`}
                          />
                          <button
                            type="button"
                            onClick={() => setShowPw((s) => !s)}
                            aria-label={showPw ? 'Hide password' : 'Show password'}
                            className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-mute hover:text-ink"
                          >
                            {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                          </button>
                        </span>
                      </Field>
                      <Field label="Confirm password" error={errors.owner?.confirm?.message}>
                        <input
                          {...register('owner.confirm')}
                          type={showPw ? 'text' : 'password'}
                          autoComplete="new-password"
                          className={`${fieldCls} ${borderCls(!!errors.owner?.confirm)}`}
                        />
                      </Field>
                    </div>
                    {!!v.owner?.password && (
                      <div className="flex items-center gap-3">
                        <div className="flex flex-1 gap-1">
                          {[0, 1, 2, 3].map((i) => (
                            <span
                              key={i}
                              className={`h-1.5 flex-1 rounded-full ${i < passwordStrength(v.owner.password) ? strengthMeta[passwordStrength(v.owner.password)]!.cls : 'bg-line'}`}
                            />
                          ))}
                        </div>
                        <span className="w-16 text-right text-[11.5px] font-semibold text-sub">{strengthMeta[passwordStrength(v.owner.password)]!.label}</span>
                      </div>
                    )}
                  </div>

                  {apiConfigured ? (
                    <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-5">
                      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-blue/10 text-blue">
                        <UserPlus className="size-5" />
                      </span>
                      <div className="text-[12.5px]">
                        <h2 className="text-[14px] font-bold text-ink">Cashiers</h2>
                        <p className="mt-0.5 text-sub">
                          Add them after setup on the <b className="text-ink">Staff</b> screen — each gets their own sign-in and a 4-digit counter PIN. The owner can
                          bill straight away.
                        </p>
                      </div>
                    </div>
                  ) : (
                  <div className="space-y-3 rounded-2xl border border-line bg-surface p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2 className="font-bold text-ink">Cashiers</h2>
                        <p className="text-[12px] text-sub">Sign in at the counter with a 4-digit PIN. They can only bill — no reports or settings.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => cashiers.append({ name: '', counter: v.counter?.counter || counterNames[0]!, pin: '' })}
                        className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 font-semibold text-ink hover:border-blue"
                      >
                        <UserPlus className="size-4" /> Add cashier
                      </button>
                    </div>
                    {cashiers.fields.length === 0 ? (
                      <p className="rounded-xl bg-bg px-4 py-5 text-center text-[12.5px] text-sub">
                        No cashiers yet — the owner can bill too. Add cashiers now or later.
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {cashiers.fields.map((f, i) => (
                          <li key={f.id} className="grid grid-cols-[minmax(0,1fr)_120px_96px_36px] items-start gap-2">
                            <Field label={i === 0 ? 'Name' : ''} error={errors.cashiers?.[i]?.name?.message}>
                              <input {...register(`cashiers.${i}.name`)} placeholder="Cashier name" className={`${fieldCls} ${borderCls(!!errors.cashiers?.[i]?.name)}`} />
                            </Field>
                            <Field label={i === 0 ? 'Counter' : ''} error={errors.cashiers?.[i]?.counter?.message}>
                              <input
                                {...register(`cashiers.${i}.counter`)}
                                list="setup-counters"
                                className={`${fieldCls} ${borderCls(!!errors.cashiers?.[i]?.counter)}`}
                              />
                            </Field>
                            <Field label={i === 0 ? 'PIN' : ''} error={errors.cashiers?.[i]?.pin?.message}>
                              <input
                                {...register(`cashiers.${i}.pin`)}
                                type="password"
                                inputMode="numeric"
                                maxLength={4}
                                autoComplete="off"
                                placeholder="••••"
                                className={`${fieldCls} text-center font-mono tracking-[0.3em] ${borderCls(!!errors.cashiers?.[i]?.pin)}`}
                              />
                            </Field>
                            <button
                              type="button"
                              onClick={() => cashiers.remove(i)}
                              aria-label="Remove cashier"
                              className={`grid size-10 place-items-center rounded-lg text-mute hover:bg-coral/10 hover:text-coral ${i === 0 ? 'mt-[26px]' : ''}`}
                            >
                              <Trash2 className="size-4" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <datalist id="setup-counters">
                      {counterNames.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  </div>
                  )}
                </>
              )}

              {/* ---------- 5. counter ---------- */}
              {step?.id === 'counter' && (
                <>
                  <div className="space-y-4 rounded-2xl border border-line bg-surface p-5">
                    <h2 className="font-bold text-ink">This computer</h2>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Counter name" hint="(printed as the billing counter)" error={errors.counter?.counter?.message}>
                        <input {...register('counter.counter')} list="setup-counters" className={`${fieldCls} ${borderCls(!!errors.counter?.counter)}`} />
                      </Field>
                      <Field label="Store UPI ID" hint="(for the payment QR)" error={errors.counter?.upiId?.message}>
                        <input
                          {...register('counter.upiId')}
                          placeholder="store@okaxis"
                          autoCapitalize="none"
                          spellCheck={false}
                          className={`${fieldCls} ${borderCls(!!errors.counter?.upiId)}`}
                        />
                      </Field>
                    </div>
                    {!v.counter?.upiId && <Note>Without a UPI ID the POS can still take UPI, but can&apos;t show a QR with the exact amount.</Note>}
                  </div>

                  <div className="space-y-4 rounded-2xl border border-line bg-surface p-5">
                    <h2 className="flex items-center gap-2 font-bold text-ink">
                      <Printer className="size-4 text-blue" /> Receipt printer
                    </h2>
                    <div className="grid gap-3 sm:grid-cols-[170px_1fr]">
                      <Field label="Paper roll">
                        <div className="flex h-10 rounded-xl bg-bg p-1" role="radiogroup" aria-label="Paper width">
                          {([58, 80] as PaperWidth[]).map((w) => (
                            <button
                              key={w}
                              type="button"
                              role="radio"
                              aria-checked={v.counter?.paperWidth === w}
                              onClick={() => setValue('counter.paperWidth', w)}
                              className={`flex-1 rounded-lg text-[12px] ${v.counter?.paperWidth === w ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-sub'}`}
                            >
                              {w} mm
                            </button>
                          ))}
                        </div>
                      </Field>
                      <Field label="Print using">
                        <div className="flex h-10 rounded-xl bg-bg p-1" role="radiogroup" aria-label="Print method">
                          {(
                            [
                              ...(desktop ? [['desktop', 'Desktop printer', false] as const] : []),
                              ['browser', 'Print dialog', false] as const,
                              ['serial', 'Direct ESC/POS', !serialSupported()] as const,
                            ] as const
                          ).map(([m, label, disabled]) => (
                            <button
                              key={m}
                              type="button"
                              role="radio"
                              aria-checked={v.counter?.printMethod === m}
                              disabled={disabled}
                              onClick={() => setValue('counter.printMethod', m)}
                              className={`flex-1 rounded-lg text-[12px] disabled:opacity-40 ${
                                v.counter?.printMethod === m ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-sub'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </Field>
                    </div>
                    {v.counter?.printMethod === 'desktop' && desktop && (
                      <Field label="Printer">
                        <select {...register('counter.desktopPrinter')} className={`${fieldCls} border-line`}>
                          <option value="">System default printer</option>
                          {printers.map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.displayName}
                              {p.isDefault ? ' (default)' : ''}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                    {v.counter?.printMethod === 'serial' && (
                      <label className="flex items-center gap-3">
                        <Toggle label="Open cash drawer" checked={!!v.counter?.openDrawer} onChange={(on) => setValue('counter.openDrawer', on)} />
                        <span>Open the cash drawer on cash sales</span>
                      </label>
                    )}
                    <label className="flex items-center gap-3">
                      <Toggle label="Print automatically" checked={!!v.counter?.autoPrint} onChange={(on) => setValue('counter.autoPrint', on)} />
                      <span>Print the receipt automatically after each payment</span>
                    </label>
                    <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
                      <button
                        type="button"
                        onClick={() => void testPrint()}
                        className="flex h-10 items-center gap-2 rounded-xl border border-line px-4 font-semibold text-ink hover:border-blue"
                      >
                        <Printer className="size-4" /> Print a test receipt
                      </button>
                      {printMsg && (
                        <span className={`flex items-center gap-1.5 text-[12.5px] font-medium ${printMsg.ok ? 'text-teal' : 'text-coral'}`}>
                          {printMsg.ok ? <CircleCheck className="size-4" /> : <TriangleAlert className="size-4" />}
                          {printMsg.text}
                        </span>
                      )}
                    </div>
                  </div>
                </>
              )}

              {/* ---------- 6. review ---------- */}
              {step?.id === 'review' && (
                <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="space-y-3">
                    <SummaryCard title="Business" onEdit={() => goTo(0)}>
                      <Row k="Type" v={businessType ? businessTypes[businessType].label : ''} />
                      <Row
                        k="Features"
                        v={(businessType ? relevantModules[businessType] : [])
                          .filter((k) => moduleInfo[k].available && v.modules?.[k])
                          .map((k) => moduleInfo[k].label)
                          .join(', ')}
                      />
                    </SummaryCard>
                    <SummaryCard title="Store" onEdit={() => goTo(1)}>
                      <Row k="Name" v={profile.displayName} />
                      {profile.legalName && <Row k="Legal name" v={profile.legalName} />}
                      <Row k="Address" v={addressLines(profile).join(', ')} />
                      <Row k="Phone" v={profile.phone} />
                    </SummaryCard>
                    <SummaryCard title="GST & billing" onEdit={() => goTo(2)}>
                      <Row k="Registration" v={registrationInfo[profile.registration].label} />
                      {profile.gstin && <Row k="GSTIN" v={<span className="font-mono">{profile.gstin}</span>} />}
                      {profile.fssai && <Row k="FSSAI" v={profile.fssai} />}
                      {profile.drugLicence && <Row k="Drug licence" v={profile.drugLicence} />}
                      <Row k="First bill" v={<span className="font-mono">{previewDoc.no}</span>} />
                    </SummaryCard>
                    <SummaryCard title="Staff" onEdit={() => goTo(3)}>
                      <Row k="Owner" v={`${v.owner?.name ?? ''} · ${v.owner?.phone ?? ''}`} />
                      <Row
                        k="Cashiers"
                        v={v.cashiers?.length ? v.cashiers.map((c) => `${c.name} (${c.counter})`).join(', ') : 'None yet'}
                      />
                    </SummaryCard>
                    <SummaryCard title="This counter" onEdit={() => goTo(4)}>
                      <Row k="Counter" v={v.counter?.counter} />
                      <Row k="UPI ID" v={v.counter?.upiId || 'Not set'} />
                      <Row
                        k="Printer"
                        v={`${v.counter?.paperWidth} mm · ${
                          v.counter?.printMethod === 'desktop' ? v.counter.desktopPrinter || 'Default printer' : v.counter?.printMethod === 'serial' ? 'Direct ESC/POS' : 'Print dialog'
                        }`}
                      />
                    </SummaryCard>
                    <Note>
                      This replaces any demo data on this computer. Products, stock and customers can be added after setup.
                    </Note>
                  </div>
                  <div className="hidden xl:block">
                    <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-mute">Your receipt</p>
                    <div className="rounded-2xl bg-surface p-3 shadow-sm">
                      <Receipt doc={previewDoc} width={v.counter?.paperWidth ?? 80} profile={profile} />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer navigation */}
        <div className="border-t border-line bg-surface">
          {error && step?.id === 'review' && (
            <div role="alert" className="mx-auto w-full max-w-[760px] px-5 pt-3 sm:px-8">
              <p className="rounded-xl border border-coral/30 bg-coral/10 px-3 py-2 text-[12.5px] font-medium text-coral">{error}</p>
            </div>
          )}
          <div className="mx-auto flex w-full max-w-[760px] items-center gap-3 px-5 py-3 sm:px-8">
            <button
              type="button"
              onClick={() => goTo(stepIndex > 0 ? stepIndex - 1 : 'welcome')}
              className="flex h-11 items-center gap-1.5 rounded-xl px-3 font-semibold text-sub hover:text-ink"
            >
              <ArrowLeft className="size-4" /> Back
            </button>
            <span className="mr-auto text-[12px] text-mute">Progress saved</span>
            <button
              type="submit"
              disabled={busy}
              className="flex h-11 min-w-[150px] items-center justify-center gap-2 rounded-xl gbv px-5 font-bold text-onbrand shadow-lg shadow-blue/25 disabled:opacity-60"
            >
              {busy ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" /> Setting up…
                </>
              ) : step?.id === 'review' ? (
                <>
                  <Rocket className="size-4" /> Finish setup
                </>
              ) : (
                <>
                  Continue <ArrowRight className="size-4" />
                </>
              )}
            </button>
          </div>
        </div>
      </form>

      <PrintArea doc={printDoc} width={v.counter?.paperWidth ?? 80} profile={profile} />
    </div>
  );
}

function SetupStyles() {
  return (
    <style>{`
      @keyframes setup-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
      @keyframes setup-pop { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: none; } }
      .setup-in { animation: setup-in .55s cubic-bezier(.2,.7,.2,1) both; }
      .setup-pop { animation: setup-pop .45s cubic-bezier(.2,.8,.2,1.2) both; }
      @media (prefers-reduced-motion: reduce) { .setup-in, .setup-pop { animation: none !important; } }
    `}</style>
  );
}
