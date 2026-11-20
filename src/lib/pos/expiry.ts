/**
 * Near-expiry ("clearance") batches and their automatic markdowns.
 * Batches come from inventory-data so the Dashboard, Inventory and POS agree.
 *
 * The markdown is a store policy, not a cashier discount, so it does not count
 * against the cashier's discount limit. Change the slabs in `markdownRules`.
 */
import { expiringBatches } from '@/lib/inventory-data';
import { posCatalog } from '@/lib/pos/catalog';

/** Discount by days left until expiry — first matching rule wins. */
export const markdownRules: { maxDays: number; pct: number }[] = [
  { maxDays: 0, pct: 50 }, // expires today
  { maxDays: 1, pct: 30 }, // tomorrow
  { maxDays: 3, pct: 20 },
  { maxDays: 7, pct: 10 },
];

/** % off for a batch with `days` left; null = no markdown (fresh enough). Expired batches can't be sold at all. */
export const markdownFor = (days: number) => (days < 0 ? null : (markdownRules.find((r) => days <= r.maxDays)?.pct ?? null));

export type Batch = {
  id: string;
  sku: string;
  /** Units in this batch. */
  qty: number;
  /** Days left until expiry (0 = expires today, negative = expired). */
  days: number;
  /** Automatic markdown; null when expired. */
  pct: number | null;
};

export const initialBatches: Batch[] = expiringBatches.flatMap((b) => {
  const item = posCatalog.find((p) => p.name === b.name);
  return item ? [{ id: b.batch, sku: item.sku, qty: b.qty, days: b.days, pct: markdownFor(b.days) }] : [];
});

export const isExpired = (b: Pick<Batch, 'days'>) => b.days < 0;

/** Expiry as a date, counted from today (the mock batches store "days left"). */
export const expiryDate = (days: number, from = new Date()) => {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
};

export const fmtExpiry = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export const expiryLabel = (days: number) =>
  days < 0
    ? `Expired ${-days} day${days === -1 ? '' : 's'} ago`
    : days === 0
      ? 'Expires today'
      : days === 1
        ? 'Expires tomorrow'
        : `Expires in ${days} days`;

/** Colour for how urgent the expiry is. */
export const expiryTone = (days: number) => (days <= 1 ? 'coral' : days <= 3 ? 'amber' : 'sky');
