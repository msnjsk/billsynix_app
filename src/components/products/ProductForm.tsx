'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { inr } from '@/lib/store-data';
import { productCategories, supplierNames } from '@/lib/inventory-data';
import { isLive } from '@/lib/live/session';
import { taxOptions } from '@/lib/live/actions';
import { useState } from 'react';

/** The category list's “+ New category…” choice. */
const NEW_CATEGORY = '__new__';

const num = (label: string) => z.number({ error: `Enter the ${label}` });

export const productSchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(60, 'Keep the name under 60 characters'),
    category: z.string().min(1, 'Choose a category'),
    // Connected: optional (the supplier is set by purchases); on this computer: required.
    supplier: z.string().refine((v) => isLive() || v.length > 0, 'Choose a supplier'),
    /** Connected mode: the product's GST classification. */
    taxRateId: z.string().optional(),
    price: num('selling price').positive('Price must be above 0').max(100000, 'Price looks too high'),
    cost: num('cost price').positive('Cost must be above 0'),
    stock: num('opening stock').int('Use a whole number').min(0, 'Stock cannot be negative'),
  })
  .refine((v) => v.cost <= v.price, { path: ['cost'], message: 'Cost is higher than the selling price' });

export type ProductFormValues = z.infer<typeof productSchema>;

export function ProductForm({
  defaults,
  takenNames,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  defaults: ProductFormValues;
  /** Lower-cased names already in the catalogue (excluding the product being edited). */
  takenNames: Set<string>;
  submitLabel: string;
  onSubmit: (values: ProductFormValues) => void;
  onCancel: () => void;
}) {
  const {
    register,
    handleSubmit,
    watch,
    setError,
    setValue,
    formState: { errors },
  } = useForm<ProductFormValues>({ resolver: zodResolver(productSchema), defaultValues: defaults });

  const [newCategory, setNewCategory] = useState('');
  const addingCategory = watch('category') === NEW_CATEGORY;
  const price = watch('price');
  const cost = watch('cost');
  const margin = price > 0 && cost > 0 && cost <= price ? ((price - cost) / price) * 100 : null;

  const submit = handleSubmit((values) => {
    if (takenNames.has(values.name.trim().toLowerCase())) {
      setError('name', { message: 'A product with this name already exists' });
      return;
    }
    let category = values.category;
    if (category === NEW_CATEGORY) {
      const name = newCategory.trim().replace(/\s+/g, ' ');
      if (name.length < 2) {
        setError('category', { message: 'Type the new category’s name' });
        return;
      }
      // Reuse an existing one if the name only differs in case.
      category = productCategories.find((c) => c.toLowerCase() === name.toLowerCase()) ?? name;
      // Connected: saving the product creates the category on the server. Offer it in the list from now on.
      if (!productCategories.includes(category)) productCategories.push(category);
    }
    onSubmit({ ...values, category, name: values.name.trim() });
  });

  const field =
    'h-10 w-full rounded-xl border bg-surface px-3 text-ink outline-none focus:border-blue aria-[invalid=true]:border-coral';
  const border = (bad: boolean) => (bad ? 'border-coral' : 'border-line');

  return (
    <form onSubmit={submit} noValidate className="space-y-4 text-[13px]">
      <Field label="Product name" error={errors.name?.message}>
        <input
          {...register('name')}
          placeholder="e.g. Aashirvaad Atta 10kg"
          aria-invalid={Boolean(errors.name)}
          className={`${field} ${border(Boolean(errors.name))}`}
          autoFocus
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Category" error={errors.category?.message}>
          <select {...register('category')} className={`${field} ${border(Boolean(errors.category))}`}>
            <option value="">Select…</option>
            {productCategories.map((c) => (
              <option key={c}>{c}</option>
            ))}
            <option value={NEW_CATEGORY}>+ New category…</option>
          </select>
          {addingCategory && (
            <div className="mt-1.5 flex gap-1.5">
              <input
                autoFocus
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                maxLength={60}
                placeholder="e.g. Dry fruits"
                aria-label="New category name"
                className={`${field} border-blue`}
              />
              <button
                type="button"
                onClick={() => {
                  setValue('category', '');
                  setNewCategory('');
                }}
                className="shrink-0 rounded-xl px-2 text-[12px] font-semibold text-sub hover:text-ink"
              >
                Cancel
              </button>
            </div>
          )}
        </Field>
        {isLive() && (
          <Field label="GST" error={errors.taxRateId?.message}>
            <select {...register('taxRateId')} className={`${field} ${border(Boolean(errors.taxRateId))}`}>
              {taxOptions().map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Supplier" error={errors.supplier?.message}>
          <select {...register('supplier')} className={`${field} ${border(Boolean(errors.supplier))}`}>
            <option value="">Select…</option>
            {supplierNames.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Selling price (₹)" error={errors.price?.message}>
          <input
            type="number"
            step="0.5"
            min={0}
            {...register('price', { valueAsNumber: true })}
            aria-invalid={Boolean(errors.price)}
            className={`${field} ${border(Boolean(errors.price))}`}
          />
        </Field>
        <Field label="Cost price (₹)" error={errors.cost?.message}>
          <input
            type="number"
            step="0.5"
            min={0}
            {...register('cost', { valueAsNumber: true })}
            aria-invalid={Boolean(errors.cost)}
            className={`${field} ${border(Boolean(errors.cost))}`}
          />
        </Field>
        <Field label="Stock (units)" error={errors.stock?.message}>
          <input
            type="number"
            min={0}
            {...register('stock', { valueAsNumber: true })}
            aria-invalid={Boolean(errors.stock)}
            className={`${field} ${border(Boolean(errors.stock))}`}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between rounded-xl bg-bg px-3 py-2.5">
        <span className="text-sub">Margin per unit</span>
        {margin !== null ? (
          <span className="font-bold tabular-nums text-ink">
            {inr(Math.round((price - cost) * 100) / 100)}{' '}
            <span className={margin < 10 ? 'text-coral' : 'text-teal'}>({margin.toFixed(1)}%)</span>
          </span>
        ) : (
          <span className="text-mute">Enter prices to see the margin</span>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="h-10 rounded-xl card px-4 font-semibold">
          Cancel
        </button>
        <button type="submit" className="h-10 rounded-xl gbv px-5 font-semibold text-onbrand">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function Field({ label, error, children }: { label: string; error?: string | undefined; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-semibold text-ink">{label}</span>
      {children}
      {error && <span className="mt-1 block text-[11px] text-coral">{error}</span>}
    </label>
  );
}
