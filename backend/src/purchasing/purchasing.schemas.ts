import { z } from 'zod';
import { moneyInput, percentInput, qtyInput } from '../common/decimal.js';
import { STATE_CODES } from '../common/gst.js';
import {
  optionalText,
  paginationQuery,
  phone,
  pincode,
  text,
} from '../common/schemas.js';

const isoDate = z.iso.date();
const positiveQty = qtyInput.refine(
  (q) => Number(q) > 0,
  'must be more than 0',
);
const positiveMoney = moneyInput.refine(
  (m) => Number(m) > 0,
  'must be more than 0',
);
const batchNo = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[0-9A-Z][0-9A-Z\-_./]{0,39}$/,
    'must be 1–40 letters or digits (also - _ . /)',
  );
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .optional()
  .transform((v) => (v ? v : undefined));

/* ---------- suppliers ---------- */

const supplierFields = {
  name: text(120),
  contactName: optionalText(80),
  phone: phone.optional(),
  email: z.email().optional(),
  /** Registered suppliers: the state comes from the GSTIN. */
  gstin,
  /** Required for unregistered suppliers (decides intra/inter-state). */
  stateCode: z.enum(STATE_CODES).optional(),
  addressLine1: optionalText(160),
  city: optionalText(80),
  pincode: pincode.optional(),
  supplies: optionalText(200),
  creditDays: z.number().int().min(0).max(365).default(7),
};

export const createSupplierSchema = z.object({
  ...supplierFields,
  /** What we already owe them when they're set up (posted as OPENING). */
  openingBalance: moneyInput.optional(),
  openingDate: isoDate.optional(),
});
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = z
  .object({
    name: supplierFields.name,
    contactName: z.string().trim().max(80).nullable(),
    phone: phone.nullable(),
    email: z.email().nullable(),
    gstin: z.string().trim().toUpperCase().nullable(),
    stateCode: z.enum(STATE_CODES),
    addressLine1: z.string().trim().max(160).nullable(),
    city: z.string().trim().max(80).nullable(),
    pincode: pincode.nullable(),
    supplies: z.string().trim().max(200).nullable(),
    creditDays: z.number().int().min(0).max(365),
    status: z.enum(['ACTIVE', 'INACTIVE']),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

export const listSuppliersQuery = paginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE'),
});
export type ListSuppliersQuery = z.infer<typeof listSuppliersQuery>;

export const supplierPricesSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.uuid(),
        cost: moneyInput,
        supplierSku: z.string().trim().max(40).nullable().optional(),
      }),
    )
    .min(1)
    .max(500)
    .refine(
      (i) => new Set(i.map((x) => x.productId)).size === i.length,
      'each product only once',
    ),
});
export type SupplierPricesInput = z.infer<typeof supplierPricesSchema>;

export const statementQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type StatementQuery = z.infer<typeof statementQuery>;

/* ---------- lines ---------- */

/** Price terms of a line; GST/cess default to the product's tax rate. */
const priced = {
  rate: moneyInput.optional(),
  discountPct: percentInput(100).optional(),
  gstRate: percentInput(100).optional(),
  cessRate: percentInput(400).optional(),
};

/* ---------- purchase orders ---------- */

export const poItemInput = z.object({
  productId: z.uuid(),
  qty: positiveQty,
  ...priced,
});
export type PoItemInput = z.infer<typeof poItemInput>;

export const createPoSchema = z.object({
  supplierId: z.uuid(),
  storeId: z.uuid(),
  orderDate: isoDate.optional(),
  expectedDate: isoDate.optional(),
  notes: optionalText(1000),
  items: z
    .array(poItemInput)
    .min(1)
    .max(300)
    .refine(
      (i) => new Set(i.map((x) => x.productId)).size === i.length,
      'each product only once',
    ),
});
export type CreatePoInput = z.infer<typeof createPoSchema>;

export const updatePoSchema = z
  .object({
    expectedDate: isoDate.nullable(),
    notes: z.string().trim().max(1000).nullable(),
    items: createPoSchema.shape.items,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdatePoInput = z.infer<typeof updatePoSchema>;

export const listPoQuery = paginationQuery.extend({
  supplierId: z.uuid().optional(),
  storeId: z.uuid().optional(),
  status: z
    .enum([
      'DRAFT',
      'PENDING_APPROVAL',
      'SENT',
      'PARTIAL',
      'RECEIVED',
      'CLOSED',
      'CANCELLED',
      'OPEN',
    ])
    .optional(),
});
export type ListPoQuery = z.infer<typeof listPoQuery>;

/* ---------- goods receipts ---------- */

export const grnItemInput = z.object({
  productId: z.uuid(),
  /** The PO line this delivers against (matched by product when omitted). */
  poItemId: z.uuid().optional(),
  receivedQty: positiveQty,
  damagedQty: qtyInput.default('0.000'),
  ...priced,
  batchNo: batchNo.optional(),
  expiryDate: isoDate.optional(),
  mfgDate: isoDate.optional(),
});
export type GrnItemInput = z.infer<typeof grnItemInput>;

export const createGrnSchema = z.object({
  supplierId: z.uuid(),
  storeId: z.uuid(),
  poId: z.uuid().optional(),
  receivedDate: isoDate.optional(),
  supplierInvoiceNo: optionalText(40),
  supplierInvoiceDate: isoDate.optional(),
  /** Defaults to invoice (or receipt) date + the supplier's credit days. */
  dueDate: isoDate.optional(),
  notes: optionalText(1000),
  items: z.array(grnItemInput).min(1).max(300),
});
export type CreateGrnInput = z.infer<typeof createGrnSchema>;

export const listGrnQuery = paginationQuery.extend({
  supplierId: z.uuid().optional(),
  storeId: z.uuid().optional(),
  poId: z.uuid().optional(),
  /** Only receipts with something still to pay. */
  unpaid: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type ListGrnQuery = z.infer<typeof listGrnQuery>;

/* ---------- purchase returns ---------- */

export const RETURN_REASONS = [
  'DAMAGED',
  'EXPIRED',
  'SHORT_EXPIRY',
  'WRONG_ITEM',
  'EXCESS',
  'QUALITY',
] as const;

export const returnItemInput = z.object({
  productId: z.uuid(),
  qty: positiveQty,
  /** Return against a receipt line: price terms and batch default to that line. */
  grnItemId: z.uuid().optional(),
  /** Goods that arrived damaged (never entered stock). Needs grnItemId. */
  fromDamaged: z.boolean().default(false),
  batchId: z.uuid().optional(),
  ...priced,
});
export type ReturnItemInput = z.infer<typeof returnItemInput>;

export const createReturnSchema = z.object({
  supplierId: z.uuid(),
  storeId: z.uuid(),
  grnId: z.uuid().optional(),
  returnDate: isoDate.optional(),
  reason: z.enum(RETURN_REASONS),
  notes: optionalText(1000),
  items: z.array(returnItemInput).min(1).max(300),
});
export type CreateReturnInput = z.infer<typeof createReturnSchema>;

export const listReturnsQuery = paginationQuery.extend({
  supplierId: z.uuid().optional(),
  storeId: z.uuid().optional(),
});
export type ListReturnsQuery = z.infer<typeof listReturnsQuery>;

/* ---------- payments ---------- */

export const createPaymentSchema = z.object({
  supplierId: z.uuid(),
  direction: z.enum(['OUT', 'IN']).default('OUT'),
  amount: positiveMoney,
  mode: z.enum(['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH']),
  reference: optionalText(60),
  paidOn: isoDate.optional(),
  notes: optionalText(500),
  /** Bills (receipts) this settles. Omitted: oldest due first. [] keeps it all as an advance. */
  allocations: z
    .array(z.object({ grnId: z.uuid(), amount: positiveMoney }))
    .max(200)
    .refine(
      (a) => new Set(a.map((x) => x.grnId)).size === a.length,
      'each receipt only once',
    )
    .optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const listPaymentsQuery = paginationQuery.extend({
  supplierId: z.uuid().optional(),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuery>;

export const payablesQuery = z.object({
  /** Include suppliers we owe nothing. */
  all: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
