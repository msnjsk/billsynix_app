/**
 * Mock inventory data, derived from the product catalogue in store-data.
 * Replace with API calls (e.g. TanStack Query hooks) once a backend exists.
 */
import { lowStock, products, type Product } from '@/lib/store-data';

/** Sales figures in store-data cover 1–14 May, so daily run-rate = units / 14. */
export const SALES_WINDOW_DAYS = 14;
/** Suggested reorders aim to cover this many days of sales. */
export const COVER_TARGET_DAYS = 14;

export type StockStatus = 'ok' | 'low' | 'critical' | 'out';

export type InventoryItem = Product & {
  sku: string;
  cost: number;
  supplier: string;
};

const skuPrefix: Record<string, string> = {
  Grocery: 'GR',
  Dairy: 'DC',
  Beverages: 'BV',
  Snacks: 'SN',
  Household: 'HH',
  Bakery: 'BK',
};

const supplierFor: Record<string, string> = {
  Grocery: 'Sri Balaji Traders',
  Snacks: 'Sri Balaji Traders',
  Household: 'Sri Balaji Traders',
  Dairy: 'Nandini Dairy Co-op',
  Beverages: 'Fizzo Beverages',
  Bakery: 'Bake House',
};

/** SKU like "GR-1015": category prefix + 4-digit serial. */
export const makeSku = (category: string, serial: number) =>
  `${skuPrefix[category] ?? 'GN'}-${String(serial).padStart(4, '0')}`;

export const productCategories = Object.keys(skuPrefix);
export const supplierNames = [...new Set(Object.values(supplierFor))];

export const inventoryItems: InventoryItem[] = products.map((p, i) => ({
  ...p,
  sku: makeSku(p.category, 1001 + i * 7),
  cost: Math.round(p.price * 0.8),
  supplier: supplierFor[p.category] ?? 'Sri Balaji Traders',
}));

export const statusOf = (p: Product): StockStatus => {
  if (p.stock <= 0) return 'out';
  if (p.stock <= 5) return 'critical';
  if (lowStock(p)) return 'low';
  return 'ok';
};

export const dailyRate = (p: Product) => p.units / SALES_WINDOW_DAYS;

/** Days the current stock lasts at the current sales rate. */
export const daysOfCover = (p: Product) => {
  const rate = dailyRate(p);
  return rate > 0 ? p.stock / rate : Infinity;
};

/** Units to order so stock covers COVER_TARGET_DAYS of sales. */
export const suggestedOrder = (p: Product) =>
  Math.max(0, Math.ceil(dailyRate(p) * COVER_TARGET_DAYS - p.stock));

export const expiringBatches = [
  { name: 'Nandini Curd 400g', batch: 'DC-2291', qty: 6, days: 1 },
  { name: 'Bake House Bread', batch: 'BK-0514', qty: 8, days: 2 },
  { name: 'Paneer Fresh 200g', batch: 'DC-2304', qty: 12, days: 5 },
  { name: 'Nandini Milk 1L', batch: 'DC-2310', qty: 40, days: 6 },
];

export type Movement = {
  id: number;
  product: string;
  qty: number; // positive = stock in, negative = stock out
  reason: string;
  time: string;
};

export const initialMovements: Movement[] = [
  { id: 5, product: 'Nandini Milk 1L', qty: 120, reason: 'Purchase', time: '10:15' },
  { id: 4, product: 'Eggs Tray 30', qty: -2, reason: 'Damaged', time: '09:51' },
  { id: 3, product: 'Gehu Gold Atta 5kg', qty: 40, reason: 'Purchase', time: '09:20' },
  { id: 2, product: 'Fizzo Cola 750ml', qty: -6, reason: 'Expired', time: 'Yesterday' },
  { id: 1, product: 'Crunchee Marie 250g', qty: 48, reason: 'Purchase', time: 'Yesterday' },
];

export const stockInReasons = ['Purchase', 'Customer return', 'Count correction'] as const;
export const stockOutReasons = ['Damaged', 'Expired', 'Count correction'] as const;
