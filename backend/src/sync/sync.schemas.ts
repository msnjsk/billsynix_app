import { z } from 'zod';
import { moneyInput, percentInput } from '../common/decimal.js';
import { optionalText, paginationQuery, text } from '../common/schemas.js';
import {
  buyer,
  discount,
  positiveQty,
  tender,
} from '../sales/sales.schemas.js';

const instant = z.iso.datetime({ offset: true });

/* ---------- transactions a device sends (validated one by one) ---------- */

/** A cash drawer opened on the device while offline. Its id becomes the drawer's id. */
export const cashSessionOpenTxn = z.object({
  id: z.uuid(),
  type: z.literal('CASH_SESSION_OPEN'),
  occurredAt: instant,
  cashierUserId: z.uuid(),
  openingFloat: moneyInput,
});
export type CashSessionOpenTxn = z.infer<typeof cashSessionOpenTxn>;

/** A line as it was billed on the device: its cached price and tax, which the customer paid. */
export const offlineLine = z.object({
  productId: z.uuid(),
  qty: positiveQty,
  /** Per unit, tax inclusive. */
  unitPrice: moneyInput,
  mrp: moneyInput.optional(),
  gstRate: percentInput(),
  cessRate: percentInput().default(0),
  priceSource: z
    .enum(['PRICE_LIST', 'PRODUCT', 'OPEN_PRICE'])
    .default('PRODUCT'),
  batchId: z.uuid().optional(),
  discount: discount.optional(),
});

/** A bill made on the device while offline, numbered from the device's reserved block. */
export const offlineSaleTxn = z.object({
  id: z.uuid(),
  type: z.literal('SALE'),
  occurredAt: instant,
  cashierUserId: z.uuid(),
  /** The drawer the cash went into; else the cashier's open drawer on the counter. */
  cashSessionId: z.uuid().optional(),
  invoiceNo: z.string().trim().min(1).max(16),
  documentType: z.enum(['TAX_INVOICE', 'BILL_OF_SUPPLY']),
  lines: z.array(offlineLine).min(1).max(200),
  billDiscount: discount.optional(),
  buyer: buyer.optional(),
  // Credit needs the customer's current balance and limit: online only.
  payments: z
    .array(
      tender.refine((p) => p.method !== 'CREDIT', 'credit sales need a connection'),
    )
    .max(6)
    .default([]),
  /** What the device charged; the server recomputes the bill from the lines and must agree. */
  payable: moneyInput,
  /** Catalogue cursor the device had when billing (for price-change context). */
  catalogueAt: instant.optional(),
});
export type OfflineSaleTxn = z.infer<typeof offlineSaleTxn>;

export const syncTransaction = z.discriminatedUnion('type', [
  cashSessionOpenTxn,
  offlineSaleTxn,
]);
export type SyncTransaction = z.infer<typeof syncTransaction>;

/**
 * The batch envelope. Each transaction is only checked for an id here and validated on its own
 * later, so one malformed transaction fails alone instead of blocking the device's whole queue.
 */
export const batchSchema = z.object({
  /** Device clock when sending (clock-skew monitoring). */
  deviceTime: instant.optional(),
  appVersion: z.string().trim().max(40).optional(),
  /** The device's queue right now, for monitoring. */
  queue: z
    .object({
      pending: z.number().int().min(0).max(1_000_000),
      failed: z.number().int().min(0).max(1_000_000).default(0),
      oldestAt: instant.optional(),
    })
    .optional(),
  transactions: z
    .array(z.looseObject({ id: z.uuid(), type: z.string().max(40) }))
    .max(100)
    .default([])
    .refine(
      (t) => new Set(t.map((x) => x.id)).size === t.length,
      'each transaction only once per batch',
    ),
});
export type BatchInput = z.infer<typeof batchSchema>;

/* ---------- catalogue cache, number blocks ---------- */

export const catalogueQuery = z.object({
  /** From the previous response; omit for a full download. */
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
});
export type CatalogueQuery = z.infer<typeof catalogueQuery>;

export const reserveBlockSchema = z.object({
  size: z.number().int().min(10).max(1000).optional(),
});
export type ReserveBlockInput = z.infer<typeof reserveBlockSchema>;

/* ---------- review ---------- */

export const listIssuesQuery = paginationQuery.extend({
  storeId: z.uuid().optional(),
  deviceId: z.uuid().optional(),
  status: z.enum(['ACCEPTED', 'FAILED', 'DISCARDED']).optional(),
  /** Only what still needs a manager (default), or everything. */
  open: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});
export type ListIssuesQuery = z.infer<typeof listIssuesQuery>;

export const retrySchema = z.object({
  /**
   * Record it under the counter's next invoice number instead of the one the device printed
   * (when that number is taken or wasn't reserved).
   */
  renumber: z.boolean().default(false),
  note: optionalText(300),
});
export type RetryInput = z.infer<typeof retrySchema>;

export const discardSchema = z.object({ note: text(300) });
export const acknowledgeSchema = z.object({ note: optionalText(300) });

export const storeQuery = z.object({ storeId: z.uuid().optional() });
export type StoreQuery = z.infer<typeof storeQuery>;
