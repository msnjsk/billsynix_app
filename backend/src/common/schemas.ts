import { z } from 'zod';

/** Path/query id parameter. Invalid ids are reported as 404 by callers' lookups, but rejected here first. */
export const uuidParam = z.uuid({ message: 'must be a UUID' });

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export type Page<T> = {
  data: T[];
  meta: { page: number; pageSize: number; total: number };
};

export const page = <T>(
  data: T[],
  total: number,
  q: PaginationQuery,
): Page<T> => ({
  data,
  meta: { page: q.page, pageSize: q.pageSize, total },
});

export const skipTake = (q: PaginationQuery) => ({
  skip: (q.page - 1) * q.pageSize,
  take: q.pageSize,
});

/** Trimmed non-empty string. */
export const text = (max = 200) => z.string().trim().min(1).max(max);
export const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const pincode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'must be a 6-digit PIN code');
export const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{6,20}$/, 'must be a phone number');
