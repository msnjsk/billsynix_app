import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';

export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

/**
 * A non-negative decimal accepted as a JSON string ("240.50") or number (240.5) and normalised to
 * a fixed-scale string. Values with more decimals than `scale` are rejected, never rounded, so a
 * float artefact like 0.30000000000000004 can't slip into money (ADR-002).
 */
export const decimalInput = (scale: number, maxIntDigits: number) => {
  const re = new RegExp(`^\\d{1,${maxIntDigits}}(\\.\\d{1,${scale}})?$`);
  return z.union([z.string(), z.number()]).transform((v, ctx) => {
    const s =
      typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v.trim();
    if (!re.test(s)) {
      ctx.addIssue({
        code: 'custom',
        message: `must be a non-negative number with at most ${scale} decimal places`,
      });
      return z.NEVER;
    }
    return new Decimal(s).toFixed(scale);
  });
};

/** Money: up to 10 integer digits, 2 decimals → "240.50". */
export const moneyInput = decimalInput(2, 10);
/** Quantity: up to 9 integer digits, 3 decimals → "1.250". */
export const qtyInput = decimalInput(3, 9);
/** Percentage 0–max with up to 2 decimals, returned as a number (API convention). */
export const percentInput = (max = 100) =>
  decimalInput(2, 3)
    .transform((s) => Number(s))
    .refine((n) => n <= max, `must be at most ${max}`);

export const money = (d: Decimal) => d.toFixed(2);
export const moneyOrNull = (d: Decimal | null) => (d ? d.toFixed(2) : null);
export const qty = (d: Decimal) => d.toFixed(3);
export const percent = (d: Decimal) => Number(d.toFixed(2));
