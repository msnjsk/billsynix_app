import { z } from 'zod';
import { moneyInput, percentInput, qtyInput } from '../common/decimal.js';
import { optionalText, paginationQuery, text } from '../common/schemas.js';
import { SKU_PATTERN, normaliseCode } from './barcode.js';
import { UQC_CODES } from './defaults.js';

const nonEmpty = <T extends object>(v: T) => Object.keys(v).length > 0;
const NOTHING = 'nothing to update';

/* ---------- tax rates ---------- */

const taxKind = z.enum(['TAXABLE', 'NIL_RATED', 'EXEMPT', 'NON_GST']);

export const createTaxRateSchema = z
  .object({
    name: text(40),
    kind: taxKind.default('TAXABLE'),
    rate: percentInput(100).default(0),
    cessRate: percentInput(400).default(0),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'TAXABLE' && v.rate <= 0)
      ctx.addIssue({
        code: 'custom',
        path: ['rate'],
        message: 'a taxable rate is above 0% — use NIL_RATED for 0%',
      });
    if (v.kind !== 'TAXABLE' && (v.rate !== 0 || v.cessRate !== 0))
      ctx.addIssue({
        code: 'custom',
        path: ['rate'],
        message: `${v.kind} supplies carry no GST or cess`,
      });
  });
export type CreateTaxRateInput = z.infer<typeof createTaxRateSchema>;

/** Kind and rates are checked against the merged row in the service. */
export const updateTaxRateSchema = z
  .object({
    name: text(40),
    kind: taxKind,
    rate: percentInput(100),
    cessRate: percentInput(400),
    isActive: z.boolean(),
  })
  .partial()
  .refine(nonEmpty, NOTHING);
export type UpdateTaxRateInput = z.infer<typeof updateTaxRateSchema>;

/* ---------- units ---------- */

const unitCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{1,8}$/, 'must be 1–8 letters');

export const createUnitSchema = z.object({
  code: unitCode,
  name: text(40),
  decimals: z.number().int().min(0).max(3).default(0),
  uqc: z.enum(UQC_CODES),
});
export type CreateUnitInput = z.infer<typeof createUnitSchema>;

/** The code is printed on issued bills, so it can't change. */
export const updateUnitSchema = z
  .object({
    name: text(40),
    decimals: z.number().int().min(0).max(3),
    uqc: z.enum(UQC_CODES),
    isActive: z.boolean(),
  })
  .partial()
  .refine(nonEmpty, NOTHING);
export type UpdateUnitInput = z.infer<typeof updateUnitSchema>;

/* ---------- categories & brands ---------- */

export const createCategorySchema = z.object({
  name: text(60),
  parentId: z.uuid().optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    name: text(60),
    parentId: z.uuid().nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine(nonEmpty, NOTHING);
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const createBrandSchema = z.object({ name: text(60) });
export type CreateBrandInput = z.infer<typeof createBrandSchema>;

export const updateBrandSchema = z
  .object({ name: text(60), isActive: z.boolean() })
  .partial()
  .refine(nonEmpty, NOTHING);
export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;

export const activeFilterQuery = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type ActiveFilterQuery = z.infer<typeof activeFilterQuery>;

/* ---------- products ---------- */

export const sku = z
  .string()
  .trim()
  .toUpperCase()
  .regex(SKU_PATTERN, 'must be 1–40 letters or digits (also - _ . /)');

/** Format is checked in the service (barcodeProblem) so CSV import reports it the same way. */
export const barcodeCode = z.string().min(1).max(64).transform(normaliseCode);

export const hsnCode = z
  .string()
  .trim()
  .regex(/^(\d{4}|\d{6}|\d{8})$/, 'an HSN/SAC code is 4, 6 or 8 digits');

export const barcodeInput = z.object({
  code: barcodeCode,
  packQty: qtyInput
    .refine((q) => Number(q) > 0, 'must be more than 0')
    .default('1.000'),
  label: optionalText(40),
  isPrimary: z.boolean().default(false),
});
export type BarcodeInput = z.infer<typeof barcodeInput>;

const productFields = {
  name: text(120),
  receiptName: optionalText(40),
  description: optionalText(1000),
  categoryId: z.uuid().optional(),
  brandId: z.uuid().optional(),
  unitId: z.uuid(),
  taxRateId: z.uuid(),
  hsnCode: hsnCode.optional(),
  mrp: moneyInput
    .refine((m) => Number(m) > 0, 'must be more than 0')
    .optional(),
  sellingPrice: moneyInput,
  purchaseCost: moneyInput.optional(),
  priceIncludesTax: z.boolean().default(true),
  allowOpenPrice: z.boolean().default(false),
  trackInventory: z.boolean().default(true),
  tracksBatches: z.boolean().default(false),
  parentId: z.uuid().optional(),
  variantLabel: optionalText(40),
};

export const createProductSchema = z.object({
  sku,
  ...productFields,
  barcodes: z.array(barcodeInput).max(20).default([]),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

/** `null` clears an optional field. `version` (if sent) must match — optimistic concurrency. */
export const updateProductSchema = z
  .object({
    sku,
    name: productFields.name,
    receiptName: z.string().trim().max(40).nullable(),
    description: z.string().trim().max(1000).nullable(),
    categoryId: z.uuid().nullable(),
    brandId: z.uuid().nullable(),
    unitId: z.uuid(),
    taxRateId: z.uuid(),
    hsnCode: hsnCode.nullable(),
    mrp: productFields.mrp.unwrap().nullable(),
    sellingPrice: moneyInput,
    purchaseCost: moneyInput.nullable(),
    priceIncludesTax: z.boolean(),
    allowOpenPrice: z.boolean(),
    trackInventory: z.boolean(),
    tracksBatches: z.boolean(),
    parentId: z.uuid().nullable(),
    variantLabel: z.string().trim().max(40).nullable(),
  })
  .partial()
  .extend({ version: z.number().int().min(1).optional() })
  .refine(({ version: _v, ...rest }) => nonEmpty(rest), NOTHING);
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

const csvUuids = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined))
  .pipe(z.array(z.uuid()).max(200).optional());

export const listProductsQuery = paginationQuery.extend({
  /** Words; each must match the name, the start of the SKU, or a whole barcode. */
  q: z.string().trim().max(100).optional(),
  categoryId: z.uuid().optional(),
  brandId: z.uuid().optional(),
  parentId: z.uuid().optional(),
  ids: csvUuids,
  status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE'),
  /** Adds `storePrice`: the price that branch bills at. */
  storeId: z.uuid().optional(),
  sort: z
    .enum(['name', '-name', 'sku', '-sku', 'updatedAt', '-updatedAt'])
    .default('name'),
});
export type ListProductsQuery = z.infer<typeof listProductsQuery>;

export const lookupQuery = z.object({
  code: z.string().trim().min(1).max(64).transform(normaliseCode),
  storeId: z.uuid().optional(),
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type LookupQuery = z.infer<typeof lookupQuery>;

export const importQuery = z.object({
  dryRun: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/* ---------- price lists ---------- */

export const createPriceListSchema = z.object({ name: text(60) });
export type CreatePriceListInput = z.infer<typeof createPriceListSchema>;

export const updatePriceListSchema = z
  .object({ name: text(60), isActive: z.boolean() })
  .partial()
  .refine(nonEmpty, NOTHING);
export type UpdatePriceListInput = z.infer<typeof updatePriceListSchema>;

export const setPricesSchema = z.object({
  items: z
    .array(z.object({ productId: z.uuid(), sellingPrice: moneyInput }))
    .min(1)
    .max(500)
    .refine(
      (items) => new Set(items.map((i) => i.productId)).size === items.length,
      'each product only once',
    ),
});
export type SetPricesInput = z.infer<typeof setPricesSchema>;

export const assignPriceListSchema = z.object({
  priceListId: z.uuid().nullable(),
});
export type AssignPriceListInput = z.infer<typeof assignPriceListSchema>;
