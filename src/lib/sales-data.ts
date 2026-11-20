/**
 * Mock data for the Sales page. Builds on the dashboard series so figures agree across pages.
 * Replace with API calls (e.g. TanStack Query hooks) once a backend exists.
 */
import { orders as recentOrders, products } from '@/lib/store-data';
import { dailySales, monthlySales, weeklySales, type SalesPoint } from '@/lib/dashboard-data';

export type SalesRow = SalesPoint & { orders: number; prevOrders: number };

/** Average bill drifts up to ₹369 on the latest point (14 May → 348 orders). */
const withOrders = (rows: SalesPoint[]): SalesRow[] =>
  rows.map((r, i) => {
    const avg = 369 - (rows.length - 1 - i) * 1.5;
    return {
      ...r,
      orders: Math.round(r.revenue / avg),
      prevOrders: Math.round(r.previous / (avg * 0.97)),
    };
  });

export const salesRanges = {
  '7D': { label: 'Last 7 days', rows: withOrders(dailySales.slice(-7)), unit: 'day' },
  '14D': { label: 'Last 14 days', rows: withOrders(dailySales), unit: 'day' },
  '8W': { label: 'Last 8 weeks', rows: withOrders(weeklySales), unit: 'week' },
  '6M': { label: 'Last 6 months', rows: withOrders(monthlySales), unit: 'month' },
} as const;
export type SalesRangeKey = keyof typeof salesRanges;

/** Average revenue per hour of the day over the last 14 days. */
export const avgHourly = [
  { hour: '7a', sales: 8200 },
  { hour: '8a', sales: 12900 },
  { hour: '9a', sales: 11400 },
  { hour: '10a', sales: 8600 },
  { hour: '11a', sales: 7100 },
  { hour: '12p', sales: 6400 },
  { hour: '1p', sales: 5600 },
  { hour: '2p', sales: 4900 },
  { hour: '3p', sales: 5800 },
  { hour: '4p', sales: 7600 },
  { hour: '5p', sales: 10100 },
  { hour: '6p', sales: 13400 },
  { hour: '7p', sales: 12200 },
  { hour: '8p', sales: 7400 },
  { hour: '9p', sales: 3900 },
];

/** Today's bills per cashier (totals add up to 348 bills / ₹1,28,450). */
export const cashiers = [
  { name: 'Priya S', counter: 'Counter 1', bills: 142, revenue: 52300 },
  { name: 'Arun K', counter: 'Counter 2', bills: 118, revenue: 44150 },
  { name: 'Kavitha R', counter: 'Counter 3', bills: 88, revenue: 32000 },
];

/* ---------- today's bills ---------- */

export type PayMethod = 'UPI' | 'Cash' | 'Card';
export type BillStatus = 'Paid' | 'Refunded' | 'Cancelled';
export type BillLine = { name: string; price: number; qty: number };
export type Bill = {
  id: number;
  time: string;
  method: PayMethod;
  status: BillStatus;
  cashier: string;
  customer: string;
  lines: BillLine[];
  total: number;
};

/** Small deterministic PRNG so the mock bills are identical on server and client. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const customers = ['Walk-in', 'Walk-in', 'Walk-in', 'Lakshmi R', 'Mohan V', 'Fathima N', 'Ravi Teja', 'Walk-in', 'Deepa M'];
const methods: PayMethod[] = ['UPI', 'UPI', 'UPI', 'Cash', 'Cash', 'Card'];

/** Fills a bill with catalogue items up to `total`; any remainder becomes loose (weighed) items. */
function fillLines(total: number, rand: () => number): BillLine[] {
  const lines: BillLine[] = [];
  let remaining = total;
  for (let n = 0; n < 8; n++) {
    const fits = products.filter((p) => p.price <= remaining);
    if (!fits.length) break;
    const p = fits[Math.floor(rand() * fits.length)]!;
    const qty = Math.min(Math.floor(remaining / p.price), 1 + Math.floor(rand() * 3));
    const existing = lines.find((l) => l.name === p.name);
    if (existing) existing.qty += qty;
    else lines.push({ name: p.name, price: p.price, qty });
    remaining -= qty * p.price;
  }
  if (remaining > 0) lines.push({ name: 'Loose items (by weight)', price: remaining, qty: 1 });
  return lines;
}

function buildBills(): Bill[] {
  const rand = rng(1405);
  const bills: Bill[] = [];
  // Earlier bills this morning: #4791 – #4815, every ~4–6 minutes from 06:52.
  let minutes = 6 * 60 + 52;
  for (let id = 4791; id <= 4815; id++) {
    minutes += 4 + Math.floor(rand() * 3);
    const total = 60 + Math.round((rand() ** 1.6 * 2400) / 5) * 5;
    bills.push({
      id,
      time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
      method: methods[Math.floor(rand() * methods.length)]!,
      status: rand() < 0.06 ? 'Refunded' : 'Paid',
      cashier: cashiers[Math.floor(rand() * cashiers.length)]!.name,
      customer: customers[Math.floor(rand() * customers.length)]!,
      lines: [],
      total,
    });
  }
  // Latest bills come from the shared store data so the dashboard's activity feed matches.
  for (const o of [...recentOrders].reverse()) {
    bills.push({
      id: o.id,
      time: o.time,
      method: o.method as PayMethod,
      status: o.status as BillStatus,
      cashier: cashiers[o.id % cashiers.length]!.name,
      customer: customers[o.id % customers.length]!,
      lines: [],
      total: o.total,
    });
  }
  return bills.map((b) => ({ ...b, lines: fillLines(b.total, rand) })).reverse();
}

export const todaysBills = buildBills();

/** GST included in a price, assuming a flat 5% rate for this mock. */
export const GST_RATE = 0.05;
export const gstIncluded = (amount: number) => Math.round((amount - amount / (1 + GST_RATE)) * 100) / 100;
