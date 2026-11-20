/**
 * Mock data for the Dashboard Overview.
 * Replace these exports with API calls (e.g. TanStack Query hooks) once a backend exists.
 */

import { apiConfigured } from '@/lib/api/client';

export type SalesPoint = { label: string; revenue: number; profit: number; previous: number };

/** Builds a series where profit is ~18.5% of revenue and the previous period is 18.6% lower. */
const series = (rows: [string, number][]): SalesPoint[] =>
  rows.map(([label, revenue]) => ({
    label,
    revenue,
    profit: Math.round((revenue * 0.1848) / 10) * 10,
    previous: Math.round(revenue / 1.186 / 100) * 100,
  }));

/** 1–14 May 2024 (4 & 11 May are Saturdays, 5 & 12 May are Sundays). */
export const dailySales = series([
  ['1 May', 88400],
  ['2 May', 96200],
  ['3 May', 104800],
  ['4 May', 128600],
  ['5 May', 82300],
  ['6 May', 98700],
  ['7 May', 106400],
  ['8 May', 112900],
  ['9 May', 118200],
  ['10 May', 131500],
  ['11 May', 214300],
  ['12 May', 96800],
  ['13 May', 118100],
  ['14 May', 128450],
]);

export const weeklySales = series([
  ['18 Mar', 652000],
  ['25 Mar', 684500],
  ['1 Apr', 671200],
  ['8 Apr', 702800],
  ['15 Apr', 738400],
  ['22 Apr', 729100],
  ['29 Apr', 768900],
  ['6 May', 787600],
]);

export const monthlySales = series([
  ['Nov', 2645000],
  ['Dec', 2918000],
  ['Jan', 2784000],
  ['Feb', 2702000],
  ['Mar', 2961000],
  ['Apr', 3087000],
]);

export const dayNames: Record<string, string> = {
  '4 May': 'Sat',
  '11 May': 'Sat',
  '5 May': 'Sun',
  '12 May': 'Sun',
};

export let footfall = 1912;

export type Kpi = {
  label: string;
  value: string;
  delta: number;
  deltaLabel?: string;
  progress: number;
  foot: string;
  spark: number[];
  highlight?: boolean;
};

export const kpis: Kpi[] = [
  { label: "Today's Revenue", value: '₹1,28,450', delta: 12.8, progress: 86, foot: '86% of ₹1.5L target', spark: [4, 5, 4, 6, 5, 7, 8] },
  { label: 'Total Orders', value: '348', delta: 8.2, progress: 87, foot: '87% of 400', spark: [5, 4, 6, 5, 6, 7, 7] },
  { label: 'Gross Profit', value: '₹23,890', delta: 6.4, progress: 80, foot: '80% of ₹30K', spark: [4, 5, 5, 4, 6, 6, 7] },
  { label: 'Avg Order', value: '₹369', delta: 4.2, progress: 92, foot: '92% of ₹400', spark: [5, 6, 5, 6, 6, 7, 7] },
  { label: 'Low Stock', value: '24 Products', delta: 6, deltaLabel: '▲ 6', progress: 33, foot: '8 critical', spark: [3, 4, 4, 5, 6, 6, 7], highlight: true },
  { label: 'Inventory Value', value: '₹18,45,000', delta: -2.1, progress: 72, foot: '1,284 SKUs', spark: [7, 6, 6, 5, 6, 5, 5] },
];

export const payments = [
  { method: 'UPI', amount: 57800, color: 'var(--blue)' },
  { method: 'Cash', amount: 38535, color: 'var(--teal)' },
  { method: 'Card', amount: 25690, color: 'var(--vio)' },
  { method: 'Other', amount: 6425, color: 'var(--amber)' },
];
export let ordersToday = 348;

/** Connected mode: today's figures from the API (see lib/live/hydrate). */
export function setTodayCounts(bills: number) {
  ordersToday = bills;
  footfall = bills;
}

export const inventoryHealth = { inStock: 1260, low: 16, critical: 8 };

export const categoryShare = [
  { name: 'Grocery', share: 34, color: 'var(--blue)' },
  { name: 'Dairy', share: 22, color: 'var(--sky)' },
  { name: 'Beverages', share: 18, color: 'var(--cyan)' },
  { name: 'Snacks', share: 15, color: 'var(--vio)' },
  { name: 'Household', share: 11, color: 'var(--lime)' },
];

export const expiring = [
  { name: 'Nandini Curd 400g', batch: 'DC-2291', days: 1 },
  { name: 'Bake House Bread', batch: 'BK-0514', days: 2 },
  { name: 'Paneer Fresh 200g', batch: 'DC-2304', days: 5 },
];

export type ActivityKind = 'sale' | 'restock' | 'adjust';
export const activity: { kind: ActivityKind; text: string; time: string }[] = [
  { kind: 'sale', text: 'Sale #4821 · ₹1,240', time: '10:42' },
  { kind: 'restock', text: 'Restocked Nandini Milk +120', time: '10:15' },
  { kind: 'sale', text: 'Sale #4820 · ₹860', time: '10:08' },
  { kind: 'adjust', text: 'Adjusted Eggs tray −2 damaged', time: '09:51' },
  { kind: 'restock', text: 'Restocked Gehu Gold Atta +40', time: '09:20' },
];

export const suggestions = [
  'Which products should I reorder this week?',
  'Why did profit dip on Sunday?',
  'Best time to run a dairy offer?',
];

/**
 * Connected mode: the figures above are a sample store's. Start from zero so a real business never
 * sees them — the API's figures are written in by lib/live/dashboard.ts when they load (and stay
 * empty for someone whose role can't see sales reports).
 */
export function clearDashboard() {
  for (const a of [dailySales, weeklySales, monthlySales, payments, categoryShare, expiring, activity] as unknown[][]) a.length = 0;
  for (const k of Object.keys(dayNames)) delete dayNames[k];
  kpis.splice(
    0,
    kpis.length,
    ...(["Today's Revenue", 'Total Orders', 'Gross Profit', 'Avg Order', 'Low Stock', 'Inventory Value'] as const).map((label) => ({
      label,
      value: label === 'Low Stock' ? '0 Products' : label === 'Total Orders' ? '0' : '₹0',
      delta: 0,
      progress: 0,
      foot: '—',
      spark: [],
    }))
  );
  Object.assign(inventoryHealth, { inStock: 0, low: 0, critical: 0 });
  setTodayCounts(0);
}

if (apiConfigured) clearDashboard();
