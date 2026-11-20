import { z } from 'zod';
import { Decimal, decimalInput, qtyInput } from '../common/decimal.js';
import { optionalText, paginationQuery, text } from '../common/schemas.js';

/** A quantity that may be negative ("-2.500"), up to 3 decimals, never 0. */
export const signedQtyInput = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const s =
      typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v.trim();
    if (!/^-?\d{1,9}(\.\d{1,3})?$/.test(s) || new Decimal(s).isZero()) {
      ctx.addIssue({
        code: 'custom',
        message:
          'must be a non-zero quantity with at most 3 decimal places (negative takes stock out)',
      });
      return z.NEVER;
    }
    return new Decimal(s).toFixed(3);
  });

export const positiveQty = qtyInput.refine(
  (q) => Number(q) > 0,
  'must be more than 0',
);
/** Cost per unit, 4 decimals (weighted averages need them). */
export const costInput = decimalInput(4, 10);
const isoDate = z.iso.date();
const batchNo = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[0-9A-Z][0-9A-Z\-_./]{0,39}$/,
    'must be 1–40 letters or digits (also - _ . /)',
  );

const boolQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

/* ---------- stock views ---------- */

export const stockListQuery = paginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  categoryId: z.uuid().optional(),
  /** LOW: at or below the reorder level; OUT: nothing left; IN_STOCK: something left. */
  status: z.enum(['ALL', 'IN_STOCK', 'LOW', 'OUT']).default('ALL'),
});
export type StockListQuery = z.infer<typeof stockListQuery>;

export const movementsQuery = z.object({
  productId: z.uuid().optional(),
  type: z
    .enum([
      'OPENING',
      'PURCHASE_RECEIPT',
      'PURCHASE_RETURN',
      'SALE',
      'SALE_RETURN',
      'ADJUSTMENT',
      'COUNT_ADJUSTMENT',
      'WRITE_OFF',
      'TRANSFER_OUT',
      'TRANSFER_IN',
      'TRANSFER_LOSS',
    ])
    .optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** `meta.nextCursor` of the previous page. */
  cursor: z
    .string()
    .regex(/^\d{1,19}$/, 'invalid cursor')
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type MovementsQuery = z.infer<typeof movementsQuery>;

export const reorderSchema = z
  .object({
    reorderLevel: qtyInput.nullable(),
    reorderQty: positiveQty.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type ReorderInput = z.infer<typeof reorderSchema>;

export const alertsQuery = z.object({
  storeId: z.uuid().optional(),
  /** Expiry alerts: batches expiring within this many days (already expired ones are included). */
  days: z.coerce.number().int().min(0).max(365).default(30),
});
export type AlertsQuery = z.infer<typeof alertsQuery>;

export const createBatchSchema = z.object({
  batchNo,
  expiryDate: isoDate.optional(),
  mfgDate: isoDate.optional(),
});
export type CreateBatchInput = z.infer<typeof createBatchSchema>;

/* ---------- adjustments ---------- */

export const ADJUSTMENT_REASONS = [
  'OPENING',
  'DAMAGE',
  'EXPIRY',
  'WASTAGE',
  'THEFT',
  'FOUND',
  'COUNT_CORRECTION',
  'OTHER',
] as const;
export type AdjustmentReasonKey = (typeof ADJUSTMENT_REASONS)[number];

const adjustmentItem = z.object({
  productId: z.uuid(),
  qty: signedQtyInput,
  /** Cost per unit of stock coming in (required for OPENING). */
  unitCost: costInput.optional(),
  /** Batch-tracked products: an existing batch, or a batch number (created if new). */
  batchId: z.uuid().optional(),
  batchNo: batchNo.optional(),
  expiryDate: isoDate.optional(),
});
export type AdjustmentItemInput = z.infer<typeof adjustmentItem>;

export const createAdjustmentSchema = z.object({
  reason: z.enum(ADJUSTMENT_REASONS),
  note: optionalText(500),
  items: z.array(adjustmentItem).min(1).max(200),
});
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;

export const rejectSchema = z.object({ reason: text(500) });
export type RejectInput = z.infer<typeof rejectSchema>;

export const listAdjustmentsQuery = paginationQuery.extend({
  storeId: z.uuid().optional(),
  status: z
    .enum(['PENDING_APPROVAL', 'POSTED', 'REJECTED', 'CANCELLED'])
    .optional(),
});
export type ListAdjustmentsQuery = z.infer<typeof listAdjustmentsQuery>;

/* ---------- counts ---------- */

export const createCountSchema = z.object({
  name: text(80),
  /** Count only this category (and its subcategories)… */
  categoryId: z.uuid().optional(),
  /** …or only these products. Neither: every stocked product. */
  productIds: z.array(z.uuid()).min(1).max(5000).optional(),
});
export type CreateCountInput = z.infer<typeof createCountSchema>;

export const recordCountSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.uuid(),
        batchId: z.uuid().optional(),
        countedQty: qtyInput,
      }),
    )
    .min(1)
    .max(500),
});
export type RecordCountInput = z.infer<typeof recordCountSchema>;

export const listCountsQuery = paginationQuery.extend({
  storeId: z.uuid().optional(),
  status: z.enum(['OPEN', 'SUBMITTED', 'POSTED', 'CANCELLED']).optional(),
});
export type ListCountsQuery = z.infer<typeof listCountsQuery>;

export const countDetailQuery = z.object({ onlyDifferences: boolQuery });

/* ---------- transfers ---------- */

export const createTransferSchema = z
  .object({
    fromStoreId: z.uuid(),
    toStoreId: z.uuid(),
    note: optionalText(500),
    items: z
      .array(z.object({ productId: z.uuid(), qty: positiveQty }))
      .min(1)
      .max(200)
      .refine(
        (i) => new Set(i.map((x) => x.productId)).size === i.length,
        'each product only once',
      ),
  })
  .refine((v) => v.fromStoreId !== v.toStoreId, {
    message: 'a transfer goes between two different branches',
    path: ['toStoreId'],
  });
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

/** Omit `items` to send what was requested. Batch-tracked items go earliest expiry first unless batches are named. */
export const dispatchSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.uuid(),
        qty: qtyInput,
        batches: z
          .array(z.object({ batchId: z.uuid(), qty: positiveQty }))
          .min(1)
          .max(20)
          .optional(),
      }),
    )
    .max(200)
    .optional(),
});
export type DispatchInput = z.infer<typeof dispatchSchema>;

/** Omit `items` when everything arrived. A shortfall is booked as TRANSFER_LOSS. */
export const receiveSchema = z.object({
  items: z
    .array(z.object({ itemId: z.uuid(), receivedQty: qtyInput }))
    .max(400)
    .optional(),
});
export type ReceiveInput = z.infer<typeof receiveSchema>;

export const listTransfersQuery = paginationQuery.extend({
  storeId: z.uuid().optional(),
  direction: z.enum(['IN', 'OUT', 'BOTH']).default('BOTH'),
  status: z
    .enum(['REQUESTED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'])
    .optional(),
});
export type ListTransfersQuery = z.infer<typeof listTransfersQuery>;
