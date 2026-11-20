'use client';

import { useState, type FormEvent } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Actions, Field, borderCls, fieldCls } from '@/components/suppliers/SupplierForms';
import { inr } from '@/lib/store-data';
import type { PayMethod } from '@/lib/sales-data';
import type { Customer } from '@/lib/customers-data';

const PHONE = /^(\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}$/;
const round2 = (n: number) => Math.round(n * 100) / 100;

/* ---------- add / edit customer ---------- */

export const customerSchema = z.object({
  name: z.string().trim().min(2, 'Enter the customer name'),
  phone: z.string().trim().regex(PHONE, 'Enter a 10-digit Indian mobile number'),
  email: z.union([z.literal(''), z.email('Enter a valid email')]),
  area: z.string().trim(),
  creditLimit: z
    .number({ error: 'Enter a credit limit (0 for none)' })
    .int('Use whole rupees')
    .min(0, 'Cannot be negative')
    .max(50000, 'Max ₹50,000'),
  notes: z.string().trim().max(200, 'Keep notes under 200 characters'),
});
export type CustomerFormValues = z.infer<typeof customerSchema>;

const normalisePhone = (p: string) => p.replace(/\D/g, '').slice(-10);

export function CustomerForm({
  initial,
  existing,
  onSubmit,
  onCancel,
}: {
  /** Pass a customer to edit; omit to add a new one. */
  initial?: Customer;
  /** All customers, used to block duplicate names and phone numbers. */
  existing: Customer[];
  onSubmit: (v: CustomerFormValues) => void;
  onCancel: () => void;
}) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<CustomerFormValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: initial
      ? {
          name: initial.name,
          phone: initial.phone,
          email: initial.email,
          area: initial.area,
          creditLimit: initial.creditLimit,
          notes: initial.notes,
        }
      : { name: '', phone: '', email: '', area: '', creditLimit: 0, notes: '' },
  });

  const submit = handleSubmit((v) => {
    const others = existing.filter((c) => c.id !== initial?.id);
    if (others.some((c) => c.name.toLowerCase() === v.name.trim().toLowerCase())) {
      setError('name', { message: 'A customer with this name already exists' });
      return;
    }
    const match = others.find((c) => normalisePhone(c.phone) === normalisePhone(v.phone));
    if (match) {
      setError('phone', { message: `Already saved for ${match.name}` });
      return;
    }
    onSubmit(v);
  });

  return (
    <form onSubmit={submit} noValidate className="space-y-4 text-[13px]">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" error={errors.name?.message}>
          <input {...register('name')} autoFocus className={`${fieldCls} ${borderCls(!!errors.name)}`} />
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
        <Field label="Area" hint="(optional)" error={errors.area?.message}>
          <input {...register('area')} placeholder="e.g. Anna Nagar West" className={`${fieldCls} border-line`} />
        </Field>
      </div>
      <Field label="Khata credit limit (₹)" hint="(0 = cash only)" error={errors.creditLimit?.message}>
        <input
          type="number"
          min={0}
          step={100}
          {...register('creditLimit', { valueAsNumber: true })}
          className={`${fieldCls} ${borderCls(!!errors.creditLimit)}`}
        />
      </Field>
      <Field label="Notes" hint="(optional)" error={errors.notes?.message}>
        <textarea
          {...register('notes')}
          rows={2}
          className={`w-full rounded-xl border bg-surface px-3 py-2 text-ink outline-none focus:border-blue ${borderCls(!!errors.notes)}`}
        />
      </Field>
      <Actions onCancel={onCancel} submitLabel={initial ? 'Save changes' : 'Add customer'} />
    </form>
  );
}

/* ---------- collect khata payment ---------- */

const payMethods: PayMethod[] = ['UPI', 'Cash', 'Card'];

export function CollectPaymentForm({
  customer,
  onSubmit,
  onCancel,
}: {
  customer: Customer;
  onSubmit: (amount: number, method: PayMethod, ref: string) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(String(customer.balance));
  const [method, setMethod] = useState<PayMethod>('UPI');
  const [ref, setRef] = useState('');
  const n = Number(amount);
  const error =
    !Number.isFinite(n) || n <= 0
      ? 'Enter an amount above 0.'
      : n > customer.balance
        ? `Only ${inr(customer.balance)} is owed.`
        : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!error) onSubmit(round2(n), method, ref.trim());
  };

  return (
    <form onSubmit={submit} className="space-y-4 text-[13px]">
      <div className="flex items-center justify-between rounded-xl bg-bg px-3 py-2.5">
        <span className="text-sub">Khata balance</span>
        <b className="tabular-nums text-ink">{inr(customer.balance)}</b>
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
            onChange={(e) => setMethod(e.target.value as PayMethod)}
            className={`${fieldCls} border-line`}
          >
            {payMethods.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Reference" hint="(UPI ref, receipt no.)">
        <input value={ref} onChange={(e) => setRef(e.target.value)} className={`${fieldCls} border-line`} />
      </Field>
      {!error && n < customer.balance && (
        <p className="text-[12px] text-sub">
          Part payment: {inr(round2(customer.balance - n))} will remain on the khata.
        </p>
      )}
      <Actions onCancel={onCancel} submitLabel="Record payment" disabled={!!error} />
    </form>
  );
}

/* ---------- add a credit purchase to the khata ---------- */

export function CreditSaleForm({
  customer,
  onSubmit,
  onCancel,
}: {
  customer: Customer;
  onSubmit: (amount: number, ref: string) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const n = Number(amount);
  const after = round2(customer.balance + (Number.isFinite(n) ? n : 0));
  const headroom = customer.creditLimit - customer.balance;
  const error = !Number.isFinite(n) || n <= 0 ? 'Enter an amount above 0.' : null;
  const overLimit = !error && after > customer.creditLimit;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!error && !overLimit) onSubmit(round2(n), ref.trim());
  };

  return (
    <form onSubmit={submit} className="space-y-4 text-[13px]">
      <div className="grid grid-cols-3 gap-2 rounded-xl bg-bg p-3 text-[12px]">
        <div>
          <div className="text-mute">Balance</div>
          <div className="font-semibold tabular-nums text-ink">{inr(customer.balance)}</div>
        </div>
        <div>
          <div className="text-mute">Limit</div>
          <div className="font-semibold tabular-nums text-ink">{inr(customer.creditLimit)}</div>
        </div>
        <div>
          <div className="text-mute">Available</div>
          <div className={`font-semibold tabular-nums ${headroom > 0 ? 'text-teal' : 'text-coral'}`}>
            {inr(Math.max(0, headroom))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Bill amount (₹)" error={amount ? (error ?? undefined) : undefined}>
          <input
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`${fieldCls} ${borderCls(!!(amount && (error || overLimit)))}`}
            autoFocus
          />
        </Field>
        <Field label="Bill / reference" hint="(optional)">
          <input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="e.g. Bill #4822"
            className={`${fieldCls} border-line`}
          />
        </Field>
      </div>
      {overLimit && (
        <p className="rounded-xl bg-coral/10 px-3 py-2 text-[12px] text-coral">
          This takes the khata to {inr(after)}, above the {inr(customer.creditLimit)} limit. Collect a payment or
          raise the limit first.
        </p>
      )}
      <Actions onCancel={onCancel} submitLabel="Add to khata" disabled={!!error || overLimit} />
    </form>
  );
}
