'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { inr } from '@/lib/store-data';
import { paymentMethods, type PaymentMethod, type PoLine, type Supplier } from '@/lib/suppliers-data';

/* ---------- shared bits ---------- */

export const fieldCls =
  'h-10 w-full rounded-xl border bg-surface px-3 text-ink outline-none focus:border-blue';
export const borderCls = (bad: boolean) => (bad ? 'border-coral' : 'border-line');

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | undefined; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-semibold text-ink">
        {label} {hint && <span className="font-normal text-mute">{hint}</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-[11px] text-coral">{error}</span>}
    </label>
  );
}

export function Actions({ onCancel, submitLabel, disabled }: { onCancel: () => void; submitLabel: string; disabled?: boolean }) {
  return (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onCancel} className="h-10 rounded-xl card px-4 font-semibold">
        Cancel
      </button>
      <button
        type="submit"
        disabled={disabled}
        className="h-10 rounded-xl gbv px-5 font-semibold text-onbrand disabled:opacity-50"
      >
        {submitLabel}
      </button>
    </div>
  );
}

/* ---------- add supplier ---------- */

const PHONE = /^(\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}$/;
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const supplierSchema = z.object({
  name: z.string().trim().min(2, 'Enter the business name'),
  contact: z.string().trim().min(2, 'Enter a contact person'),
  phone: z.string().trim().regex(PHONE, 'Enter a 10-digit Indian mobile number'),
  email: z.union([z.literal(''), z.email('Enter a valid email')]),
  gstin: z
    .string()
    .trim()
    .refine((v) => v === '' || GSTIN.test(v.toUpperCase()), 'GSTIN should be 15 characters, e.g. 33AAGFS5678K1Z2'),
  supplies: z.string().trim().min(2, 'List what they supply'),
  creditDays: z.number({ error: 'Enter credit days' }).int('Use whole days').min(0).max(90, 'Max 90 days'),
});
export type SupplierFormValues = z.infer<typeof supplierSchema>;

export function SupplierForm({
  takenNames,
  onSubmit,
  onCancel,
}: {
  takenNames: Set<string>;
  onSubmit: (v: SupplierFormValues) => void;
  onCancel: () => void;
}) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<SupplierFormValues>({
    resolver: zodResolver(supplierSchema),
    defaultValues: { name: '', contact: '', phone: '', email: '', gstin: '', supplies: '', creditDays: 7 },
  });

  const submit = handleSubmit((v) => {
    if (takenNames.has(v.name.trim().toLowerCase())) {
      setError('name', { message: 'This supplier already exists' });
      return;
    }
    onSubmit({ ...v, gstin: v.gstin.toUpperCase() });
  });

  return (
    <form onSubmit={submit} noValidate className="space-y-4 text-[13px]">
      <Field label="Business name" error={errors.name?.message}>
        <input {...register('name')} autoFocus className={`${fieldCls} ${borderCls(!!errors.name)}`} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Contact person" error={errors.contact?.message}>
          <input {...register('contact')} className={`${fieldCls} ${borderCls(!!errors.contact)}`} />
        </Field>
        <Field label="Phone" error={errors.phone?.message}>
          <input
            {...register('phone')}
            inputMode="tel"
            placeholder="+91 98400 12345"
            className={`${fieldCls} ${borderCls(!!errors.phone)}`}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Email" hint="(optional)" error={errors.email?.message}>
          <input {...register('email')} type="email" className={`${fieldCls} ${borderCls(!!errors.email)}`} />
        </Field>
        <Field label="GSTIN" hint="(optional)" error={errors.gstin?.message}>
          <input {...register('gstin')} className={`${fieldCls} uppercase ${borderCls(!!errors.gstin)}`} />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <Field label="Supplies" error={errors.supplies?.message}>
            <input
              {...register('supplies')}
              placeholder="e.g. Vegetables, Fruits"
              className={`${fieldCls} ${borderCls(!!errors.supplies)}`}
            />
          </Field>
        </div>
        <Field label="Credit (days)" error={errors.creditDays?.message}>
          <input
            type="number"
            min={0}
            {...register('creditDays', { valueAsNumber: true })}
            className={`${fieldCls} ${borderCls(!!errors.creditDays)}`}
          />
        </Field>
      </div>
      <Actions onCancel={onCancel} submitLabel="Add supplier" />
    </form>
  );
}

/* ---------- record payment ---------- */

export function PaymentForm({
  supplier,
  onSubmit,
  onCancel,
}: {
  supplier: Supplier;
  onSubmit: (amount: number, method: PaymentMethod, ref: string) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(String(supplier.due));
  const [method, setMethod] = useState<PaymentMethod>('Bank transfer');
  const [ref, setRef] = useState('');
  const n = Number(amount);
  const error =
    !Number.isFinite(n) || n <= 0
      ? 'Enter an amount above 0.'
      : n > supplier.due
        ? `Only ${inr(supplier.due)} is outstanding.`
        : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!error) onSubmit(Math.round(n * 100) / 100, method, ref.trim());
  };

  return (
    <form onSubmit={submit} className="space-y-4 text-[13px]">
      <div className="flex items-center justify-between rounded-xl bg-bg px-3 py-2.5">
        <span className="text-sub">Outstanding</span>
        <b className="tabular-nums text-ink">{inr(supplier.due)}</b>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount (₹)" error={amount ? (error ?? undefined) : undefined}>
          <input
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`${fieldCls} ${borderCls(!!(amount && error))}`}
            autoFocus
          />
        </Field>
        <Field label="Method">
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as PaymentMethod)}
            className={`${fieldCls} border-line`}
          >
            {paymentMethods.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Reference" hint="(UTR, cheque no., receipt)">
        <input value={ref} onChange={(e) => setRef(e.target.value)} className={`${fieldCls} border-line`} />
      </Field>
      {!error && n < supplier.due && (
        <p className="text-[12px] text-sub">
          Part payment: {inr(Math.round((supplier.due - n) * 100) / 100)} will remain outstanding.
        </p>
      )}
      <Actions onCancel={onCancel} submitLabel="Record payment" disabled={!!error} />
    </form>
  );
}

/* ---------- purchase order ---------- */

export function PurchaseOrderForm({
  supplier,
  suggested,
  onSubmit,
  onCancel,
}: {
  supplier: Supplier;
  /** Pre-filled lines (e.g. low-stock items with suggested quantities). */
  suggested: PoLine[];
  onSubmit: (lines: PoLine[]) => void;
  onCancel: () => void;
}) {
  const [lines, setLines] = useState(suggested.map((l) => ({ ...l, qtyText: String(l.qty) })));
  const parsed = lines.map((l) => ({ ...l, qty: Number(l.qtyText) }));
  const valid = parsed.filter((l) => Number.isInteger(l.qty) && l.qty > 0);
  const invalid = parsed.some((l) => l.qtyText !== '' && !(Number.isInteger(l.qty) && l.qty >= 0));
  const total = valid.reduce((s, l) => s + l.qty * l.cost, 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!invalid && valid.length) onSubmit(valid.map(({ name, qty, cost }) => ({ name, qty, cost })));
  };

  return (
    <form onSubmit={submit} className="space-y-4 text-[13px]">
      {lines.length === 0 ? (
        <p className="rounded-xl bg-bg p-4 text-center text-sub">
          Nothing from {supplier.name} is running low right now.
        </p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
              <th className="pb-2 !pl-0 font-medium">Item</th>
              <th className="pb-2 font-medium text-right">Cost</th>
              <th className="pb-2 font-medium text-right">Qty</th>
              <th className="pb-2 font-medium text-right">Amount</th>
              <th className="pb-2 !pr-0" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const q = Number(l.qtyText);
              return (
                <tr key={l.name} className="h-11 border-t border-line">
                  <td className="!pl-0 text-ink">{l.name}</td>
                  <td className="text-right tabular-nums text-sub">{inr(l.cost)}</td>
                  <td className="text-right">
                    <input
                      type="number"
                      min={0}
                      value={l.qtyText}
                      aria-label={`Quantity of ${l.name}`}
                      onChange={(e) =>
                        setLines((prev) => prev.map((x, j) => (j === i ? { ...x, qtyText: e.target.value } : x)))
                      }
                      className="h-8 w-16 rounded-lg border border-line bg-surface px-2 text-right tabular-nums outline-none focus:border-blue"
                    />
                  </td>
                  <td className="text-right font-semibold tabular-nums text-ink">
                    {Number.isFinite(q) && q > 0 ? inr(q * l.cost) : '—'}
                  </td>
                  <td className="!pr-0 text-right">
                    <button
                      type="button"
                      aria-label={`Remove ${l.name}`}
                      onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                      className="text-mute hover:text-coral"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="flex items-center justify-between rounded-xl bg-bg px-3 py-2.5">
        <span className="text-sub">
          Order total · payable {supplier.creditDays} days after delivery
        </span>
        <b className="tabular-nums text-ink">{inr(total)}</b>
      </div>
      {invalid && <p className="text-[12px] text-coral">Quantities must be whole numbers.</p>}
      <Actions onCancel={onCancel} submitLabel="Place order" disabled={invalid || valid.length === 0} />
    </form>
  );
}
