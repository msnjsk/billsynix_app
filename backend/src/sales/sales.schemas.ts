import { z } from 'zod';
import { moneyInput, qtyInput } from '../common/decimal.js';
import {
  optionalText,
  paginationQuery,
  phone,
  text,
} from '../common/schemas.js';

export const positiveQty = qtyInput.refine(
  (q) => Number(q) > 0,
  'must be more than 0',
);
const positiveMoney = moneyInput.refine(
  (m) => Number(m) > 0,
  'must be more than 0',
);

export const discount = z
  .object({ kind: z.enum(['PCT', 'AMT']), value: moneyInput })
  .refine(
    (d) => d.kind !== 'PCT' || Number(d.value) <= 100,
    'a percentage is at most 100',
  );

export const approval = z.object({
  userId: z.uuid(),
  pin: z.string().regex(/^\d{4}$/, 'must be 4 digits'),
});

export const saleLine = z.object({
  productId: z.uuid(),
  qty: positiveQty,
  /** Only for open-price items (loose goods, services); otherwise the server's price is used. */
  unitPrice: moneyInput.optional(),
  /** Sell from this batch (e.g. a near-expiry markdown); otherwise earliest expiry first. */
  batchId: z.uuid().optional(),
  discount: discount.optional(),
});
export type SaleLineInput = z.infer<typeof saleLine>;

export const buyer = z.object({
  name: optionalText(100),
  phone: phone.optional(),
  /** A business buyer's GSTIN makes it a B2B invoice (and IGST if from another state). */
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export const tender = z.object({
  /** CREDIT puts it on the sale's customer's account (khata), within their credit limit. */
  method: z.enum(['CASH', 'UPI', 'CARD', 'CREDIT']),
  /** Applied to the bill. */
  amount: positiveMoney,
  /** Cash handed over (change = tendered − amount). */
  tendered: moneyInput.optional(),
  /** UPI UTR / card approval code. */
  reference: optionalText(60),
});

const cart = {
  /** Password sessions name the counter; PIN sessions use their device's counter. */
  counterId: z.uuid().optional(),
  lines: z.array(saleLine).min(1).max(200),
  billDiscount: discount.optional(),
  buyer: buyer.optional(),
  approval: approval.optional(),
  /** A registered customer: needed for a CREDIT tender; fills the buyer details if not given. */
  customerId: z.uuid().optional(),
};

export const quoteSchema = z.object(cart);
export type QuoteInput = z.infer<typeof quoteSchema>;

export const createSaleSchema = z.object({
  ...cart,
  payments: z.array(tender).max(6).default([]),
  /** The payable the POS showed; if the server's differs (a price changed), the sale is refused. */
  expectedPayable: moneyInput.optional(),
  /** The POS's own id for this bill. */
  clientRef: z.string().trim().min(1).max(64).optional(),
  /** A delivery / pickup order this bill is for: it's marked billed and paid. */
  customerOrderId: z.uuid().optional(),
});
export type CreateSaleInput = z.infer<typeof createSaleSchema>;

export const listSalesQuery = paginationQuery.extend({
  storeId: z.uuid().optional(),
  counterId: z.uuid().optional(),
  cashierId: z.uuid().optional(),
  date: z.iso.date().optional(),
  /** Invoice number (exact or start). */
  q: z.string().trim().max(20).optional(),
  status: z.enum(['COMPLETED', 'VOIDED']).optional(),
  paymentStatus: z.enum(['PAID', 'PENDING', 'DUE', 'REFUNDED']).optional(),
});
export type ListSalesQuery = z.infer<typeof listSalesQuery>;

export const approversQuery = z.object({
  permission: z.enum(['sales:void', 'discount:override']),
  /** The branch (or, on a registered till, its counter decides). */
  storeId: z.uuid().optional(),
  counterId: z.uuid().optional(),
});
export type ApproversQuery = z.infer<typeof approversQuery>;

export const voidSchema = z.object({
  reason: text(200),
  approval: approval.optional(),
});
export type VoidInput = z.infer<typeof voidSchema>;

export const paymentDecisionSchema = z.object({
  reference: optionalText(60),
  note: optionalText(200),
});
export type PaymentDecisionInput = z.infer<typeof paymentDecisionSchema>;

/* ---------- returns ---------- */

export const RETURN_REASONS = [
  'CHANGED_MIND',
  'WRONG_ITEM',
  'DAMAGED',
  'EXPIRED',
  'QUALITY',
  'OTHER',
] as const;

export const createReturnSchema = z.object({
  counterId: z.uuid().optional(),
  reason: z.enum(RETURN_REASONS),
  note: optionalText(300),
  items: z
    .array(
      z.object({
        saleItemId: z.uuid(),
        qty: positiveQty,
        /** Back on the shelf? Defaults to no for DAMAGED / EXPIRED, yes otherwise. */
        resaleable: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(200)
    .refine(
      (i) => new Set(i.map((x) => x.saleItemId)).size === i.length,
      'each line only once',
    ),
  /** CREDIT: back onto the customer's account (sales with a customer only). */
  refundMethod: z.enum(['CASH', 'UPI', 'CARD', 'CREDIT']).default('CASH'),
  refundReference: optionalText(60),
  approval: approval.optional(),
});
export type CreateReturnInput = z.infer<typeof createReturnSchema>;

/* ---------- cash sessions ---------- */

export const openSessionSchema = z.object({
  counterId: z.uuid().optional(),
  openingFloat: moneyInput,
});
export type OpenSessionInput = z.infer<typeof openSessionSchema>;

export const cashMovementSchema = z.object({
  type: z.enum(['PAY_IN', 'PAY_OUT']),
  amount: positiveMoney,
  reason: text(120),
});
export type CashMovementInput = z.infer<typeof cashMovementSchema>;

export const closeSessionSchema = z.object({
  countedCash: moneyInput,
  denominations: z
    .record(
      z.string().regex(/^\d+(\.\d+)?$/),
      z.number().int().min(0).max(100_000),
    )
    .optional(),
  note: optionalText(300),
});
export type CloseSessionInput = z.infer<typeof closeSessionSchema>;

export const reviewSessionSchema = z.object({ note: text(300) });

export const listSessionsQuery = paginationQuery.extend({
  storeId: z.uuid().optional(),
  userId: z.uuid().optional(),
  status: z.enum(['OPEN', 'PENDING_REVIEW', 'CLOSED']).optional(),
  date: z.iso.date().optional(),
});
export type ListSessionsQuery = z.infer<typeof listSessionsQuery>;

export const cashierReportQuery = z.object({
  date: z.iso.date().optional(),
  storeId: z.uuid().optional(),
});
export type CashierReportQuery = z.infer<typeof cashierReportQuery>;
