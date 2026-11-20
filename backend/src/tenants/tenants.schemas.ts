import { z } from 'zod';
import { STATE_CODES, gstinProblem, panOf } from '../common/gst.js';
import { optionalText, phone, pincode, text } from '../common/schemas.js';

export const BUSINESS_TYPES = [
  'grocery',
  'supermarket',
  'pharmacy',
  'electronics',
  'garments',
  'hardware',
  'wholesale',
  'restaurant',
] as const;

export const storeCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,4}$/, 'must be 2–4 letters or digits');

const gstinField = z
  .string()
  .trim()
  .toUpperCase()
  .optional()
  .transform((v) => (v ? v : undefined));

export const address = z.object({
  line1: text(160),
  line2: optionalText(160),
  city: text(80),
  pincode,
});

const registration = z.enum(['REGULAR', 'COMPOSITION', 'UNREGISTERED']);

/** GST rules shared by registration and profile updates. */
function checkGst(
  v: { registration: string; gstin?: string | undefined; stateCode: string },
  ctx: z.RefinementCtx,
  path: (string | number)[],
) {
  if (v.registration === 'UNREGISTERED') {
    if (v.gstin)
      ctx.addIssue({
        code: 'custom',
        path: [...path, 'gstin'],
        message: 'an unregistered business has no GSTIN',
      });
    return;
  }
  if (!v.gstin) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'gstin'],
      message: 'GSTIN is required for a GST-registered business',
    });
    return;
  }
  const problem = gstinProblem(v.gstin);
  if (problem) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'gstin'],
      message: problem,
    });
  } else if (v.gstin.slice(0, 2) !== v.stateCode) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'gstin'],
      message: 'GSTIN state code does not match the business state',
    });
  }
}

export const businessSchema = z.object({
  displayName: text(80),
  legalName: optionalText(120),
  businessType: z.enum(BUSINESS_TYPES),
  registration: registration.default('REGULAR'),
  gstin: gstinField,
  stateCode: z.enum(STATE_CODES),
  phone: phone.optional(),
  email: z.email().optional(),
  address,
});

const hqSchema = z.object({ code: storeCode, name: optionalText(80) });
export type BusinessInput = z.infer<typeof businessSchema>;
export type HqInput = z.infer<typeof hqSchema>;

export const registerTenantSchema = z
  .object({
    business: businessSchema,
    owner: z.object({
      name: text(80),
      email: z.email().transform((e) => e.toLowerCase()),
      password: z.string().min(10, 'must be at least 10 characters').max(128),
    }),
    /** Head-office branch. Address and GSTIN come from the business. */
    hq: hqSchema,
  })
  .superRefine((v, ctx) => checkGst(v.business, ctx, ['business']));

export type RegisterTenantInput = z.infer<typeof registerTenantSchema>;

/** A signed-in person adding another business: no owner block — it's them. */
export const addBusinessSchema = z
  .object({ business: businessSchema, hq: hqSchema })
  .superRefine((v, ctx) => checkGst(v.business, ctx, ['business']));
export type AddBusinessInput = z.infer<typeof addBusinessSchema>;

export const updateTenantSchema = businessSchema
  .partial()
  .extend({ address: address.partial().optional() })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

/** Validates the merged result of an update (current values + patch). */
export function tenantGstProblem(merged: {
  registration: string;
  gstin?: string | undefined;
  stateCode: string;
}): string | null {
  const issues: string[] = [];
  checkGst(
    merged,
    {
      addIssue: (i: { message?: string }) =>
        issues.push(i.message ?? 'invalid'),
    } as unknown as z.RefinementCtx,
    [],
  );
  return issues[0] ?? null;
}

export { panOf };
