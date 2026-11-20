'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  BadgeCheck,
  Check,
  Landmark,
  Lock,
  MapPin,
  Puzzle,
  Receipt as ReceiptIcon,
  RotateCcw,
  Save,
  TriangleAlert,
} from 'lucide-react';
import { PageHead } from '@/components/AppShell';
import { Field, borderCls, fieldCls } from '@/components/suppliers/SupplierForms';
import { Receipt } from '@/components/pos/Receipt';
import {
  businessTypes,
  defaultProfile,
  gstStates,
  gstinProblem,
  moduleInfo,
  presetModules,
  relevantModules,
  registrationInfo,
  resetBusinessProfile,
  saveBusinessProfile,
  licenceFields,
  suggestedLicences,
  useBusinessProfile,
  type BusinessProfile,
  type BusinessType,

  type Registration,
} from '@/lib/business-profile';
import { FIRST_POS_SEQ, computeBill, invoiceNo, type CartLine, type Invoice } from '@/lib/pos/billing';
import type { PaperWidth } from '@/lib/pos/store';
import { profileFormSchema, toProfileForm, type ProfileFormValues } from '@/lib/profile-schema';
import { typeIcon } from '@/components/business/business-icons';
import { ShopLogoSection } from '@/components/business/ShopLogoSection';

/* ---------- config ---------- */

type IconType = ComponentType<{ className?: string | undefined }>;




/** Two typical lines per business type, so the preview looks like the store's own receipt. */
const sampleLines: Record<BusinessType, CartLine[]> = {
  grocery: [line('Gehu Gold Atta 5kg', '1101', 5, 240, 1), line('Nandini Milk 1L', '0401', 0, 66, 2)],
  supermarket: [line('Basmati Rice 1kg', '1006', 5, 140, 2), line('Dishwash Bar', '3401', 18, 25, 3)],
  pharmacy: [line('Paracetamol 650 (strip of 15)', '3004', 5, 32, 2), line('ORS Sachet 21g', '3004', 5, 22, 3)],
  electronics: [line('USB-C Fast Charger 25W', '8504', 18, 899, 1), line('Tempered Glass', '3919', 18, 199, 1)],
  garments: [line('Cotton Kurta (M, Blue)', '6211', 5, 799, 1), line('Silk Saree', '5007', 5, 2450, 1)],
  hardware: [line('PVC Pipe 1 in. (3 m)', '3917', 18, 180, 4), line('LED Bulb 9W', '8539', 18, 99, 2)],
  wholesale: [line('Sugar 50 kg bag', '1701', 5, 2150, 2), line('Sunflower Oil 15 L tin', '1512', 5, 2380, 1)],
  restaurant: [line('Masala Dosa', '9963', 5, 90, 2), line('Filter Coffee', '9963', 5, 30, 2)],
};
function line(name: string, hsn: string, gst: 0 | 5 | 18, price: number, qty: number): CartLine {
  return { key: name, sku: null, name, hsn, gst, price, qty, discount: null };
}

/* ---------- form ---------- */

const schema = profileFormSchema;
type FormValues = ProfileFormValues;
const toForm = toProfileForm;

/* ---------- small pieces ---------- */

function Section({ icon: I, title, sub, children }: { icon: IconType; title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-blue/10 text-blue">
          <I className="size-[18px]" />
        </span>
        <div>
          <h2 className="text-[15px] font-bold text-ink">{title}</h2>
          {sub && <p className="mt-0.5 text-[12px] text-sub">{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
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

/* ---------- main view ---------- */

export function BusinessProfileView() {
  const saved = useBusinessProfile();
  const [mounted, setMounted] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [paper, setPaper] = useState<PaperWidth>(80);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    control,
    formState: { errors, isDirty, isSubmitted },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: toForm(defaultProfile), mode: 'onTouched' });

  // The saved profile is only readable in the browser — load it after mount (and after each save).
  useEffect(() => {
    reset(toForm(saved));
    setMounted(true);
  }, [saved, reset]);

  const v = useWatch({ control }) as FormValues;
  const businessType = v.businessType ?? 'grocery';
  const registration = v.registration ?? 'regular';
  const modules = v.modules ?? defaultProfile.modules;
  const licences = suggestedLicences[businessType];
  // Only the licences this type of business has (or one already filled in).
  const showFssai = licenceFields[businessType].includes('fssai') || !!(v.fssai ?? '').trim();
  const showDrug = licenceFields[businessType].includes('drugLicence') || !!(v.drugLicence ?? '').trim();

  /** The unsaved form as a profile, for the live receipt preview. */
  const previewProfile: BusinessProfile = useMemo(
    () => ({
      ...defaultProfile,
      ...v,
      address: { ...defaultProfile.address, ...v.address },
      modules: { ...defaultProfile.modules, ...v.modules },
      gstin: (v.gstin ?? '').toUpperCase(),
      invoicePrefix: (v.invoicePrefix ?? '').toUpperCase() || 'INV',
      isSample: false,
    }),
    [v]
  );

  const previewDoc: Invoice = useMemo(() => {
    const now = new Date();
    const bos = registration !== 'regular';
    const lines = sampleLines[businessType];
    const totals = computeBill(bos ? lines.map((l) => ({ ...l, gst: 0 as const })) : lines, null);
    return {
      kind: 'invoice',
      no: invoiceNo(previewProfile.invoicePrefix, now, FIRST_POS_SEQ),
      issuedAt: now.toISOString(),
      cashier: 'Cashier',
      counter: 'Counter 1',
      buyer: null,
      interState: false,
      lines,
      billDiscount: null,
      totals,
      payments: [{ method: 'UPI', amount: totals.payable }],
      change: 0,
      returned: {},
      refunded: 0,
      billOfSupply: bos,
    };
  }, [businessType, registration, previewProfile.invoicePrefix]);

  // Typing a valid GSTIN fills in the state it is registered in.
  const gstinField = register('gstin', {
    onChange: (e: { target: { value: string } }) => {
      const g = e.target.value.trim().toUpperCase();
      if (!gstinProblem(g) && gstStates[g.slice(0, 2)]) setValue('address.stateCode', g.slice(0, 2), { shouldValidate: true, shouldDirty: true });
    },
  });

  const onSave = handleSubmit((values) => {
    saveBusinessProfile({
      ...values,
      gstin: values.registration === 'unregistered' ? '' : values.gstin.toUpperCase(),
      invoicePrefix: values.invoicePrefix.toUpperCase(),
      isSample: false,
    });
    setSavedAt(Date.now());
  });

  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(null), 3000);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const prefixChanged =
    !saved.isSample && (v.invoicePrefix ?? '').toUpperCase() !== saved.invoicePrefix && (v.invoicePrefix ?? '').length > 0;
  const missingLicence =
    (licences.includes('fssai') && !(v.fssai ?? '').trim()) || (licences.includes('drugLicence') && !(v.drugLicence ?? '').trim());
  const errorCount = Object.keys(errors).length + (errors.address ? Object.keys(errors.address).length - 1 : 0);

  return (
    <form onSubmit={onSave} noValidate className="space-y-4 p-5 pb-28 lg:p-6 lg:pb-28">
      <PageHead title="Business profile" sub="Printed on every bill and used by POS, receipts and messages · saved on this computer" />

      {mounted && saved.isSample && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber/40 bg-amber/10 px-4 py-3 text-[13px]">
          <TriangleAlert className="size-5 shrink-0 text-amber" />
          <div className="min-w-0 flex-1">
            <b className="text-ink">These are demo store details.</b>{' '}
            <span className="text-sub">Replace them with your store&apos;s name, address and GSTIN before printing real bills.</span>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          <ShopLogoSection />

          {/* Business type — chosen during setup; it can't be changed here */}
          <Section icon={BadgeCheck} title="Type of business" sub="Chosen when the store was set up. It decides the suggested features and the licence numbers your bills need.">
            {(() => {
              const I = typeIcon[businessType];
              return (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-blue/40 bg-blue/5 p-3">
                  <span className="grid size-11 shrink-0 place-items-center rounded-xl gbv text-onbrand">
                    <I className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-bold text-ink">{businessTypes[businessType].label}</span>
                    <span className="mt-0.5 block text-[12px] text-mute">{businessTypes[businessType].blurb}</span>
                  </span>
                  <span className="flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-[11.5px] font-semibold text-sub ring-1 ring-line">
                    <Lock className="size-3.5" /> Set at setup
                  </span>
                </div>
              );
            })()}
            <p className="mt-2 text-[11.5px] text-mute">To change the type of business, contact BillSynix support.</p>
          </Section>

          {/* Store details */}
          <Section icon={MapPin} title="Store details" sub="The name and address customers see at the top of the bill.">
            <div className="space-y-3 text-[13px]">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Store name" hint="(printed large)" error={errors.displayName?.message}>
                  <input {...register('displayName')} className={`${fieldCls} ${borderCls(!!errors.displayName)}`} />
                </Field>
                <Field label="Registered legal name" hint="(if different)" error={errors.legalName?.message}>
                  <input {...register('legalName')} placeholder="e.g. Senthil Traders Pvt Ltd" className={`${fieldCls} ${borderCls(!!errors.legalName)}`} />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Owner / manager" error={errors.ownerName?.message}>
                  <input {...register('ownerName')} className={`${fieldCls} ${borderCls(!!errors.ownerName)}`} />
                </Field>
                <Field label="Phone" error={errors.phone?.message}>
                  <input {...register('phone')} inputMode="tel" className={`${fieldCls} ${borderCls(!!errors.phone)}`} />
                </Field>
                <Field label="Email" hint="(optional)" error={errors.email?.message}>
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
                    {Object.entries(gstStates)
                      .sort((a, b) => a[1].localeCompare(b[1]))
                      .map(([code, name]) => (
                        <option key={code} value={code}>
                          {name} ({code})
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="PIN code" error={errors.address?.pincode?.message}>
                  <input {...register('address.pincode')} inputMode="numeric" maxLength={6} className={`${fieldCls} ${borderCls(!!errors.address?.pincode)}`} />
                </Field>
              </div>
            </div>
          </Section>

          {/* GST & licences */}
          <Section icon={Landmark} title="GST & licences" sub="Decides whether bills charge GST, and the numbers the law requires on them.">
            <div className="space-y-4 text-[13px]">
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="GST registration">
                {(Object.keys(registrationInfo) as Registration[]).map((r) => {
                  const active = registration === r;
                  return (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setValue('registration', r, { shouldDirty: true, shouldValidate: isSubmitted })}
                      className={`rounded-xl border-2 p-3 text-left transition ${active ? 'border-blue bg-blue/5' : 'border-line hover:border-blue/40'}`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-bold text-ink">{registrationInfo[r].label}</span>
                        {active && <Check className="size-4 text-blue" />}
                      </span>
                      <span className="mt-1 block text-[11px] leading-snug text-sub">{registrationInfo[r].desc}</span>
                    </button>
                  );
                })}
              </div>

              {registration !== 'unregistered' && (
                <Field label="GSTIN" hint="(15 characters — fills in the state)" error={errors.gstin?.message}>
                  <input {...gstinField} maxLength={15} spellCheck={false} className={`${fieldCls} font-mono uppercase tracking-wider ${borderCls(!!errors.gstin)}`} />
                </Field>
              )}
              {registration === 'composition' && (
                <p className="rounded-lg bg-bg px-3 py-2 text-[12px] text-sub">
                  Bills will be titled <b className="text-ink">Bill of Supply</b>, show no GST and carry the declaration &ldquo;Composition taxable
                  person, not eligible to collect tax on supplies&rdquo;.
                </p>
              )}

              {(showFssai || showDrug) && (
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
                  <input {...register('drugLicence')} placeholder="e.g. TN-01-20B-12345, TN-01-21B-12345" className={`${fieldCls} ${borderCls(!!errors.drugLicence)}`} />
                </Field>
                )}
              </div>
              )}
              {missingLicence && (
                <p className="flex items-start gap-2 rounded-lg bg-amber/10 px-3 py-2 text-[12px] text-amber">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  {businessTypes[businessType].label} bills should show the{' '}
                  {licences.includes('drugLicence') ? 'drug licence number' : 'FSSAI licence number'}. You can still save without it.
                </p>
              )}
            </div>
          </Section>

          {/* Receipt */}
          <Section icon={ReceiptIcon} title="Bills & receipts">
            <div className="space-y-3 text-[13px]">
              <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
                <Field label="Invoice prefix" error={errors.invoicePrefix?.message}>
                  <input {...register('invoicePrefix')} maxLength={8} className={`${fieldCls} font-mono uppercase ${borderCls(!!errors.invoicePrefix)}`} />
                </Field>
                <div className="self-end pb-2.5 text-[12px] text-sub">
                  Next bill looks like <b className="font-mono text-ink">{previewDoc.no}</b> — the series restarts each financial year.
                </div>
              </div>
              {prefixChanged && (
                <p className="flex items-start gap-2 rounded-lg bg-amber/10 px-3 py-2 text-[12px] text-amber">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  A new prefix starts a new bill series. GST expects one continuous series per year, so change it only at the start of a financial
                  year (1 April).
                </p>
              )}
              <Field label="Message at the bottom of the bill" hint="(return policy, thank-you note)" error={errors.receiptFooter?.message}>
                <textarea
                  {...register('receiptFooter')}
                  rows={2}
                  className={`w-full rounded-xl border bg-surface px-3 py-2 text-ink outline-none focus:border-blue ${borderCls(!!errors.receiptFooter)}`}
                />
              </Field>
            </div>
          </Section>

          {/* Features */}
          <Section icon={Puzzle} title="Features" sub="Switch on what your business uses. Planned features are listed so you know what is coming.">
            <ul className="divide-y divide-line">
              {relevantModules[businessType].map((k) => {
                const m = moduleInfo[k];
                const recommended = presetModules[businessType][k];
                return (
                  <li key={k} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-ink">{m.label}</span>
                        {!m.available && <span className="rounded-full bg-bg px-2 py-0.5 text-[10px] font-semibold text-mute">Planned</span>}
                        {recommended && (
                          <span
                            className="rounded-full bg-blue/10 px-2 py-0.5 text-[10px] font-semibold text-blue"
                            title={`Suggested for ${businessTypes[businessType].label}`}
                          >
                            Recommended
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[12px] text-sub">{m.desc}</p>
                    </div>
                    <Switch
                      label={m.label}
                      checked={m.available ? !!modules[k] : false}
                      disabled={!m.available}
                      onChange={(on) => setValue(`modules.${k}`, on, { shouldDirty: true })}
                    />
                  </li>
                );
              })}
            </ul>
          </Section>
        </div>

        {/* Live preview */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="card p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-[15px] font-bold text-ink">Receipt preview</h2>
                <p className="text-[12px] text-sub">Updates as you type</p>
              </div>
              <div className="flex rounded-lg bg-bg p-0.5" role="radiogroup" aria-label="Paper width">
                {([58, 80] as PaperWidth[]).map((w) => (
                  <button
                    key={w}
                    type="button"
                    role="radio"
                    aria-checked={paper === w}
                    onClick={() => setPaper(w)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-semibold ${paper === w ? 'bg-surface text-ink shadow-sm' : 'text-sub'}`}
                  >
                    {w} mm
                  </button>
                ))}
              </div>
            </div>
            <div className="flex max-h-[calc(100dvh-220px)] justify-center overflow-auto rounded-xl bg-bg p-3">
              <div className="shadow-md">
                <Receipt doc={previewDoc} width={paper} profile={previewProfile} />
              </div>
            </div>
            <p className="mt-3 text-[11px] text-mute">
              Sample items for a {businessTypes[businessType].label.toLowerCase()}. The POS prints the same layout.{' '}
              <Link href="/pos" className="font-semibold text-blue">
                Open POS
              </Link>
            </p>
          </div>
        </aside>
      </div>

      {/* Save bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur lg:left-[232px]">
        <div className="flex items-center gap-3 px-5 py-3 lg:px-6">
          <span className="mr-auto text-[12px] text-sub">
            {savedAt ? (
              <span className="flex items-center gap-1.5 font-semibold text-teal">
                <Check className="size-4" /> Saved — POS and receipts now use these details
              </span>
            ) : isSubmitted && errorCount > 0 ? (
              <span className="flex items-center gap-1.5 font-semibold text-coral">
                <TriangleAlert className="size-4" /> Fix {errorCount === 1 ? 'the highlighted field' : `${errorCount} highlighted fields`} to save
              </span>
            ) : isDirty ? (
              'You have unsaved changes'
            ) : (
              'Saved on this computer · used by every counter on it'
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Reset to the demo store details? Your saved business profile will be removed from this computer.')) {
                // Demo details again — but the type of business stays what was chosen at setup.
                resetBusinessProfile(saved.businessType);
              }
            }}
            className="flex h-10 items-center gap-1.5 rounded-xl px-3 font-semibold text-sub hover:text-coral"
          >
            <RotateCcw className="size-4" /> Reset
          </button>
          <button
            type="button"
            disabled={!isDirty}
            onClick={() => {
              reset(toForm(saved));
            }}
            className="h-10 rounded-xl card px-4 font-semibold disabled:opacity-40"
          >
            Discard changes
          </button>
          <button
            type="submit"
            disabled={!isDirty && !saved.isSample}
            className="flex h-10 items-center gap-1.5 rounded-xl gbv px-5 font-semibold text-onbrand shadow-lg shadow-blue/25 disabled:opacity-50 disabled:shadow-none"
          >
            <Save className="size-4" /> Save profile
          </button>
        </div>
      </div>
    </form>
  );
}
