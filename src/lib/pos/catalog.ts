/**
 * POS catalogue: the inventory items plus what billing needs — barcode, HSN code and GST rate.
 *
 * ⚠ GST rates below follow the September 2025 rate rationalisation as best understood
 * (5% / 18% slabs, 40% for aerated drinks, packaged paneer exempt). Confirm every HSN code
 * and rate with your accountant before issuing real invoices; change them here only.
 */
import { inventoryItems } from '@/lib/inventory-data';

export type GstRate = 0 | 5 | 12 | 18 | 28 | 40;
export const gstRates: GstRate[] = [0, 5, 12, 18, 28, 40];

export type PosItem = {
  sku: string;
  name: string;
  category: string;
  /** Selling price per unit, GST inclusive (MRP or below). */
  price: number;
  stock: number;
  /** Units sold over the sales window — used to sort by popularity. */
  units: number;
  barcode: string;
  hsn: string;
  gst: GstRate;
};

const tax: Record<string, { hsn: string; gst: GstRate }> = {
  'Gehu Gold Atta 5kg': { hsn: '1101', gst: 5 },
  'Nandini Milk 1L': { hsn: '0401', gst: 0 },
  'Sagar Rice Ponni 10kg': { hsn: '1006', gst: 5 },
  'Fizzo Cola 750ml': { hsn: '2202', gst: 40 },
  'Crunchee Marie 250g': { hsn: '1905', gst: 5 },
  'Kavya Sunflower Oil 1L': { hsn: '1512', gst: 5 },
  'Sudha Detergent 1kg': { hsn: '3402', gst: 18 },
  'Nandini Curd 400g': { hsn: '0403', gst: 5 },
  'Bake House Bread': { hsn: '1905', gst: 0 },
  'Paneer Fresh 200g': { hsn: '0406', gst: 0 },
  'Eggs Tray 30': { hsn: '0407', gst: 0 },
  'Toor Dal 1kg': { hsn: '0713', gst: 5 },
};

/** Default for items without an entry above, and for loose / open-price items. */
export const DEFAULT_TAX = { hsn: '9999', gst: 5 as GstRate };

/** EAN-13 check digit for a 12-digit body. */
export const ean13Check = (body: string) => {
  const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return String((10 - (sum % 10)) % 10);
};

/** Mock EAN-13 barcodes: 890 (India) + 4-digit company + 5-digit item + check digit. */
const barcodeFor = (i: number) => {
  const body = `8901234${String(10001 + i).padStart(5, '0')}`;
  return body + ean13Check(body);
};

export const posCatalog: PosItem[] = inventoryItems.map((it, i) => ({
  sku: it.sku,
  name: it.name,
  category: it.category,
  price: it.price,
  stock: it.stock,
  units: it.units,
  barcode: barcodeFor(i),
  ...(tax[it.name] ?? DEFAULT_TAX),
}));

/** Exact match on barcode or SKU (case-insensitive) — what a scanner or typed code should hit. */
export const findByCode = (items: PosItem[], code: string) => {
  const c = code.trim().toUpperCase();
  if (!c) return undefined;
  return items.find((p) => p.barcode === c || p.sku.toUpperCase() === c);
};

/** Fuzzy search on name, SKU and barcode; every word must match somewhere. */
export const searchItems = (items: PosItem[], q: string) => {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((p) => {
    const hay = `${p.name} ${p.sku} ${p.barcode} ${p.category}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
};

/**
 * Search results in the order a cashier expects: names starting with the text first,
 * then a word starting with it, then anything else — best sellers first within each group.
 */
export const rankItems = (items: PosItem[], q: string) => {
  const s = q.trim().toLowerCase();
  const score = (p: PosItem) => {
    const n = p.name.toLowerCase();
    if (n.startsWith(s)) return 0;
    if (n.split(/\s+/).some((w) => w.startsWith(s))) return 1;
    return 2;
  };
  return searchItems(items, q).sort((a, b) => score(a) - score(b) || b.units - a.units);
};
