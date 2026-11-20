import type { Tx } from '../database/prisma.service.js';
import { Decimal } from '../common/decimal.js';
import type {
  Product,
  Store,
  Supplier,
  TaxRate,
  Unit,
} from '../generated/prisma/client.js';
import { unprocessable } from './purchasing.common.js';

export type GstContext = {
  /** The supplier charges GST (is registered). */
  gstApplies: boolean;
  /** Supplier's state ≠ receiving branch's state → IGST. */
  interState: boolean;
  /** We can claim the GST back (regular registration), so it isn't part of stock cost. */
  creditClaimable: boolean;
};

export const gstContext = (
  supplier: Pick<Supplier, 'gstin' | 'stateCode'>,
  store: Pick<Store, 'stateCode'>,
  registration: string,
): GstContext => ({
  gstApplies: !!supplier.gstin,
  interState: !!supplier.gstin && supplier.stateCode !== store.stateCode,
  creditClaimable: registration === 'REGULAR',
});

export type ProductInfo = Product & { unit: Unit; taxRate: TaxRate };

export async function loadProducts(tx: Tx, tenantId: string, ids: string[]) {
  const rows = await tx.product.findMany({
    where: { tenantId, id: { in: [...new Set(ids)] } },
    include: { unit: true, taxRate: true },
  });
  return new Map(rows.map((p) => [p.id, p as ProductInfo]));
}

export async function supplierCosts(
  tx: Tx,
  tenantId: string,
  supplierId: string,
  productIds: string[],
) {
  const rows = await tx.supplierProduct.findMany({
    where: { tenantId, supplierId, productId: { in: productIds } },
  });
  return new Map(rows.map((r) => [r.productId, r.cost]));
}

export type PriceInput = {
  rate?: string | undefined;
  discountPct?: number | undefined;
  gstRate?: number | undefined;
  cessRate?: number | undefined;
};

export type Priced = {
  rate: Decimal;
  discountPct: Decimal;
  gstRate: Decimal;
  cessRate: Decimal;
  hsnCode: string | null;
};

/**
 * Price terms of a line. Rate: given → fallback (PO/receipt line) → the supplier's price → the
 * product's last purchase cost. GST and cess: given → fallback → the product's tax rate.
 */
export function priceLine(
  p: ProductInfo,
  input: PriceInput,
  field: string,
  supplierCost: Decimal | undefined,
  fallback?: {
    rate: Decimal;
    discountPct: Decimal;
    gstRate: Decimal;
    cessRate: Decimal;
  },
): Priced {
  const rate =
    input.rate !== undefined
      ? new Decimal(input.rate)
      : (fallback?.rate ?? supplierCost ?? p.purchaseCost ?? null);
  if (rate === null)
    throw unprocessable(
      'RATE_REQUIRED',
      `No purchase price known for ${p.name} — give the rate.`,
      `${field}.rate`,
    );
  const taxable = p.taxRate.kind === 'TAXABLE';
  return {
    rate,
    discountPct:
      input.discountPct !== undefined
        ? new Decimal(input.discountPct)
        : (fallback?.discountPct ?? new Decimal(0)),
    gstRate:
      input.gstRate !== undefined
        ? new Decimal(input.gstRate)
        : (fallback?.gstRate ?? (taxable ? p.taxRate.rate : new Decimal(0))),
    cessRate:
      input.cessRate !== undefined
        ? new Decimal(input.cessRate)
        : (fallback?.cessRate ??
          (taxable ? p.taxRate.cessRate : new Decimal(0))),
    hsnCode: p.hsnCode,
  };
}

export function assertQty(p: ProductInfo, qty: Decimal, field: string) {
  if (qty.decimalPlaces() > p.unit.decimals)
    throw unprocessable(
      'INVALID_QTY',
      p.unit.decimals
        ? `${p.name} is counted to ${p.unit.decimals} decimal places.`
        : `${p.name} is counted in whole ${p.unit.code}.`,
      field,
    );
}
