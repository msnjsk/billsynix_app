/**
 * Validation for business-profile fields, shared by the Business profile screen and the
 * first-run setup wizard so both check details the same way.
 */
import { z } from 'zod';
import {
  businessTypes,
  gstStates,
  gstinProblem,
  moduleInfo,
  type BusinessProfile,
  type BusinessType,
  type ModuleKey,
} from '@/lib/business-profile';

const typeKeys = Object.keys(businessTypes) as BusinessType[];
const moduleKeys = Object.keys(moduleInfo) as ModuleKey[];

/** Field rules without cross-field checks (so other forms can .extend() it). */
export const profileShape = z.object({
  businessType: z.enum(typeKeys as [BusinessType, ...BusinessType[]]),
  displayName: z.string().trim().min(2, 'Enter the store name').max(40, 'Keep it under 40 characters so it fits the receipt'),
  legalName: z.string().trim().max(80, 'Keep it under 80 characters'),
  ownerName: z.string().trim().max(40, 'Keep it under 40 characters'),
  phone: z.string().trim().regex(/^\+?[\d\s-]{8,16}$/, 'Enter a phone number, e.g. +91 44 2626 1234'),
  email: z.union([z.literal(''), z.email('Enter a valid email')]),
  address: z.object({
    line1: z.string().trim().min(3, 'Enter the street address'),
    line2: z.string().trim(),
    city: z.string().trim().min(2, 'Enter the city'),
    pincode: z.string().trim().regex(/^[1-9]\d{5}$/, 'PIN codes are 6 digits'),
    stateCode: z.string().refine((c) => !!gstStates[c], 'Choose the state'),
  }),
  registration: z.enum(['regular', 'composition', 'unregistered']),
  gstin: z.string().trim(),
  fssai: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d{14}$/.test(v), 'FSSAI licence numbers are 14 digits'),
  drugLicence: z.string().trim().max(120, 'Keep it under 120 characters'),
  invoicePrefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{1,8}$/, '1–8 letters or digits, e.g. SFM'),
  receiptFooter: z.string().trim().max(160, 'Keep it under 160 characters'),
  modules: z.object(Object.fromEntries(moduleKeys.map((k) => [k, z.boolean()])) as Record<ModuleKey, z.ZodBoolean>),
});

/** GSTIN is required (and must be valid) unless unregistered, and must match the store's state. */
export function refineProfile(
  v: { registration: string; gstin: string; address: { stateCode: string } },
  ctx: z.RefinementCtx
) {
  if (v.registration === 'unregistered') return;
  const problem = gstinProblem(v.gstin);
  if (problem) {
    ctx.addIssue({ code: 'custom', path: ['gstin'], message: v.gstin ? problem : 'Enter your 15-character GSTIN' });
    return;
  }
  const code = v.gstin.toUpperCase().slice(0, 2);
  if (code !== v.address.stateCode)
    ctx.addIssue({ code: 'custom', path: ['address', 'stateCode'], message: `Your GSTIN is registered in ${gstStates[code]}` });
}

export const profileFormSchema = profileShape.superRefine(refineProfile);
export type ProfileFormValues = z.infer<typeof profileShape>;

export const toProfileForm = (p: BusinessProfile): ProfileFormValues => {
  const { isSample: _ignored, ...rest } = p;
  return rest;
};
