import { z } from 'zod';
import { moneyInput } from '../common/decimal.js';
import {
  optionalText,
  paginationQuery,
  phone,
  pincode,
  text,
} from '../common/schemas.js';

const positiveMoney = moneyInput.refine(
  (m) => Number(m) > 0,
  'must be more than 0',
);
const gstinField = z
  .string()
  .trim()
  .toUpperCase()
  .optional()
  .transform((v) => (v ? v : undefined));

/* ---------- customers ---------- */

export const createCustomerSchema = z.object({
  name: text(100),
  phone: phone.optional(),
  email: z.email().optional(),
  gstin: gstinField,
  addressLine1: optionalText(200),
  city: optionalText(80),
  pincode: pincode.optional(),
  /** Most they may owe on account (0 = no credit). */
  creditLimit: moneyInput.default('0.00'),
  /** What they already owe from before (posted as OPENING). */
  openingBalance: moneyInput.optional(),
  notes: optionalText(500),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    name: text(100),
    phone: phone.nullable(),
    email: z.email().nullable(),
    gstin: z.string().trim().toUpperCase().nullable(),
    addressLine1: z.string().trim().max(200).nullable(),
    city: z.string().trim().max(80).nullable(),
    pincode: pincode.nullable(),
    creditLimit: moneyInput,
    notes: z.string().trim().max(500).nullable(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const listCustomersQuery = paginationQuery.extend({
  /** Name or phone. */
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE'),
  /** Only those who owe something. */
  owing: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type ListCustomersQuery = z.infer<typeof listCustomersQuery>;

export const receiptSchema = z.object({
  amount: positiveMoney,
  method: z.enum(['CASH', 'UPI', 'CARD']),
  reference: optionalText(60),
  /** Where it was received; defaults to the caller's counter / only branch. */
  storeId: z.uuid().optional(),
  note: optionalText(300),
});
export type ReceiptInput = z.infer<typeof receiptSchema>;

/* ---------- expenses ---------- */

export const expenseCategorySchema = z.object({ name: text(60) });
export const updateExpenseCategorySchema = z
  .object({ name: text(60), isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');

export const createExpenseSchema = z
  .object({
    storeId: z.uuid(),
    categoryId: z.uuid(),
    spentOn: z.iso.date().optional(),
    amount: positiveMoney,
    gstAmount: moneyInput.default('0.00'),
    mode: z.enum(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE']),
    payee: optionalText(100),
    reference: optionalText(60),
    note: optionalText(300),
    /** Cash paid from your open drawer (recorded as a pay-out of it). */
    fromDrawer: z.boolean().default(false),
  })
  .refine((e) => Number(e.gstAmount) <= Number(e.amount), {
    message: 'GST cannot be more than the amount',
    path: ['gstAmount'],
  })
  .refine((e) => !e.fromDrawer || e.mode === 'CASH', {
    message: 'only cash comes from the drawer',
    path: ['fromDrawer'],
  });
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const listExpensesQuery = paginationQuery.extend({
  storeId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: z.enum(['RECORDED', 'VOIDED']).optional(),
});
export type ListExpensesQuery = z.infer<typeof listExpensesQuery>;

export const voidExpenseSchema = z.object({ reason: text(200) });
