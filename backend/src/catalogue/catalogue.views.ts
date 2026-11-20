import { money, moneyOrNull, percent, qty } from '../common/decimal.js';
import type {
  Prisma,
  Brand,
  Category,
  PriceList,
  Product,
  ProductBarcode,
  TaxRate,
  Unit,
} from '../generated/prisma/client.js';

export const taxRateView = (t: TaxRate) => ({
  id: t.id,
  name: t.name,
  kind: t.kind,
  rate: percent(t.rate),
  cessRate: percent(t.cessRate),
  isActive: t.isActive,
});

export const unitView = (u: Unit) => ({
  id: u.id,
  code: u.code,
  name: u.name,
  decimals: u.decimals,
  uqc: u.uqc,
  isActive: u.isActive,
});

export const brandView = (b: Brand) => ({
  id: b.id,
  name: b.name,
  isActive: b.isActive,
});

/** `path` is the names from the top, e.g. ["Grocery", "Rice"]. */
export const categoryView = (c: Category, path: string[]) => ({
  id: c.id,
  name: c.name,
  parentId: c.parentId,
  path,
  isActive: c.isActive,
});

export const barcodeView = (b: ProductBarcode) => ({
  id: b.id,
  code: b.code,
  packQty: qty(b.packQty),
  label: b.label,
  isPrimary: b.isPrimary,
});

export type ProductRow = Product & {
  category: Category | null;
  brand: Brand | null;
  unit: Unit;
  taxRate: TaxRate;
  barcodes: ProductBarcode[];
};

export const productInclude = {
  category: true,
  brand: true,
  unit: true,
  taxRate: true,
  barcodes: {
    orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }],
  },
} satisfies Prisma.ProductInclude;

export type ProductViewOptions = {
  /** Purchase cost is shown only to people who buy or price stock. */
  showCost: boolean;
  /** `<prefix>/products/:id/image` — the authenticated image endpoint. */
  apiPrefix: string;
  /** Price the selected branch bills at, when a branch was asked for. */
  storePrice?: { sellingPrice: string; source: 'PRICE_LIST' | 'PRODUCT' };
};

export const productView = (p: ProductRow, o: ProductViewOptions) => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  receiptName: p.receiptName,
  description: p.description,
  category: p.category ? { id: p.category.id, name: p.category.name } : null,
  brand: p.brand ? { id: p.brand.id, name: p.brand.name } : null,
  unit: { id: p.unit.id, code: p.unit.code, decimals: p.unit.decimals },
  taxRate: {
    id: p.taxRate.id,
    name: p.taxRate.name,
    kind: p.taxRate.kind,
    rate: percent(p.taxRate.rate),
    cessRate: percent(p.taxRate.cessRate),
  },
  hsnCode: p.hsnCode,
  mrp: moneyOrNull(p.mrp),
  sellingPrice: money(p.sellingPrice),
  ...(o.showCost ? { purchaseCost: moneyOrNull(p.purchaseCost) } : {}),
  ...(o.storePrice ? { storePrice: o.storePrice } : {}),
  priceIncludesTax: p.priceIncludesTax,
  allowOpenPrice: p.allowOpenPrice,
  trackInventory: p.trackInventory,
  tracksBatches: p.tracksBatches,
  parentId: p.parentId,
  variantLabel: p.variantLabel,
  imageUrl: p.imageKey
    ? `/${o.apiPrefix}/products/${p.id}/image?v=${p.version}`
    : null,
  barcodes: p.barcodes.map(barcodeView),
  status: p.status,
  version: p.version,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export const priceListView = (l: PriceList, storeIds: string[]) => ({
  id: l.id,
  name: l.name,
  isActive: l.isActive,
  storeIds,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
});
