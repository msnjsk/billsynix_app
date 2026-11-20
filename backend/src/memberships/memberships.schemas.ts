import { z } from 'zod';
import { paginationQuery, text } from '../common/schemas.js';

const roleKeys = z
  .array(z.string().trim().min(1).max(40))
  .min(1, 'give at least one role')
  .max(5)
  .transform((r) => [...new Set(r)]);
const storeIds = z
  .array(z.uuid())
  .max(50)
  .transform((s) => [...new Set(s)]);
const pin = z.string().regex(/^\d{4}$/, 'must be 4 digits');

export const createMembershipSchema = z.object({
  name: text(80),
  email: z.email().transform((e) => e.toLowerCase()),
  /** Required for a new person; ignored when the email already has an account (they keep theirs). */
  password: z
    .string()
    .min(10, 'must be at least 10 characters')
    .max(128)
    .optional(),
  roleKeys,
  storeIds: storeIds.default([]),
  pin: pin.optional(),
});
export type CreateMembershipInput = z.infer<typeof createMembershipSchema>;

export const updateMembershipSchema = z
  .object({
    roleKeys,
    storeIds,
    status: z.enum(['ACTIVE', 'DISABLED']),
    pin: pin.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateMembershipInput = z.infer<typeof updateMembershipSchema>;

export const listMembershipsQuery = paginationQuery.extend({
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  storeId: z.uuid().optional(),
});
export type ListMembershipsQuery = z.infer<typeof listMembershipsQuery>;
