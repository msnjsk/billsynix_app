import { z } from 'zod';
import { STATE_CODES } from '../common/gst.js';
import {
  optionalText,
  paginationQuery,
  phone,
  text,
} from '../common/schemas.js';
import { address, storeCode } from '../tenants/tenants.schemas.js';

const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .optional()
  .transform((v) => (v ? v : undefined));

const money = z.coerce
  .number()
  .min(0)
  .max(999_999_999_999)
  .transform((n) => Math.round(n * 100) / 100);

const isoDate = z.iso.date();

export const createStoreSchema = z.object({
  code: storeCode,
  name: text(80),
  kind: z.enum(['STORE', 'WAREHOUSE']).default('STORE'),
  address: address.extend({ stateCode: z.enum(STATE_CODES) }),
  gstin,
  phone: phone.optional(),
  managerName: optionalText(80),
  monthlyTarget: money.optional(),
  openedOn: isoDate.optional(),
});
export type CreateStoreInput = z.infer<typeof createStoreSchema>;

/** The code is part of issued invoice numbers, and HQ/kind define behaviour — none are editable. */
export const updateStoreSchema = z
  .object({
    name: text(80),
    address: address
      .partial()
      .extend({ stateCode: z.enum(STATE_CODES).optional() }),
    gstin,
    phone: phone.nullable(),
    managerName: z.string().trim().max(80).nullable(),
    monthlyTarget: money,
    openedOn: isoDate.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;

export const listStoresQuery = paginationQuery.extend({
  status: z.enum(['ACTIVE', 'CLOSED']).optional(),
  kind: z.enum(['STORE', 'WAREHOUSE']).optional(),
});
export type ListStoresQuery = z.infer<typeof listStoresQuery>;

export const createCounterSchema = z.object({
  name: text(40),
  number: z.coerce.number().int().min(1).max(9).optional(),
});
export type CreateCounterInput = z.infer<typeof createCounterSchema>;

export const updateCounterSchema = z
  .object({ name: text(40), status: z.enum(['ACTIVE', 'DISABLED']) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateCounterInput = z.infer<typeof updateCounterSchema>;

export const registerDeviceSchema = z.object({ name: text(60) });
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
