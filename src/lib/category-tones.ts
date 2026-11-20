import { categoryTone } from '@/lib/store-data';

/** Literal class strings so Tailwind can detect them at build time. */
const pillByTone: Record<string, string> = {
  amber: 'bg-amber/15 text-amber',
  sky: 'bg-sky/15 text-sky',
  cyan: 'bg-cyan/15 text-cyan',
  lime: 'bg-lime/15 text-lime',
  vio: 'bg-vio/15 text-vio',
};

/** Badge classes for a product category. */
export const categoryPill = (category: string) =>
  pillByTone[categoryTone[category] ?? ''] ?? 'bg-line text-sub';

/** CSS colour for a product category (for bars, dots, charts). */
export const categoryColor = (category: string) => {
  const tone = categoryTone[category];
  return tone ? `var(--${tone})` : 'var(--blue)';
};
