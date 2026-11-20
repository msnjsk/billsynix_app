import type { Tx } from '../database/prisma.service.js';
import { Decimal } from '../common/decimal.js';

type Rates = { rate: Decimal | number; cessRate: Decimal | number };

/** Price the customer pays per unit: the price itself if GST-inclusive, else price + GST + cess. */
export function grossPrice(
  sellingPrice: Decimal | string,
  priceIncludesTax: boolean,
  tax: Rates,
): Decimal {
  const p = new Decimal(sellingPrice);
  if (priceIncludesTax) return p;
  const pct = new Decimal(tax.rate).plus(tax.cessRate);
  return p
    .times(pct.plus(100))
    .dividedBy(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Selling above the printed MRP is illegal (Legal Metrology Act). null when within MRP or when
 * the product has no MRP.
 */
export function priceAboveMrp(
  args: {
    mrp: Decimal | string | null;
    sellingPrice: Decimal | string;
    priceIncludesTax: boolean;
  },
  tax: Rates,
): string | null {
  if (args.mrp === null) return null;
  const gross = grossPrice(args.sellingPrice, args.priceIncludesTax, tax);
  const mrp = new Decimal(args.mrp);
  if (gross.lte(mrp)) return null;
  return args.priceIncludesTax
    ? `The selling price ₹${gross.toFixed(2)} is above the MRP ₹${mrp.toFixed(2)}.`
    : `The selling price with GST (₹${gross.toFixed(2)}) is above the MRP ₹${mrp.toFixed(2)}.`;
}

export type StorePrice = {
  sellingPrice: string;
  source: 'PRICE_LIST' | 'PRODUCT';
};

/**
 * Price each product bills at in a branch: its entry in the branch's active price list, else the
 * product's own selling price.
 */
export async function storePrices(
  tx: Tx,
  tenantId: string,
  priceListId: string | null,
  products: ReadonlyArray<{ id: string; sellingPrice: Decimal }>,
): Promise<Map<string, StorePrice>> {
  const out = new Map<string, StorePrice>(
    products.map((p) => [
      p.id,
      { sellingPrice: p.sellingPrice.toFixed(2), source: 'PRODUCT' as const },
    ]),
  );
  if (!priceListId || !products.length) return out;
  const list = await tx.priceList.findFirst({
    where: { id: priceListId, tenantId, isActive: true },
    select: { id: true },
  });
  if (!list) return out;
  const entries = await tx.productPrice.findMany({
    where: {
      tenantId,
      priceListId: list.id,
      productId: { in: products.map((p) => p.id) },
    },
  });
  for (const e of entries)
    out.set(e.productId, {
      sellingPrice: e.sellingPrice.toFixed(2),
      source: 'PRICE_LIST',
    });
  return out;
}
