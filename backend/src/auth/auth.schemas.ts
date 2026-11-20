import { z } from 'zod';

const email = z.email().transform((e) => e.toLowerCase());
/** Same length rules everywhere a password is chosen. */
export const newPassword = z
  .string()
  .min(10, 'must be at least 10 characters')
  .max(128, 'must be at most 128 characters');

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
  /** Needed only when the account belongs to more than one business. */
  tenantId: z.uuid().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Native clients send the refresh token in the body; browsers rely on the httpOnly cookie. */
export const refreshSchema = z
  .object({ refreshToken: z.string().max(200).optional() })
  .default({});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const switchTenantSchema = z.object({ tenantId: z.uuid() });
export type SwitchTenantInput = z.infer<typeof switchTenantSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const forgotPasswordSchema = z.object({ email });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const pinLoginSchema = z.object({
  membershipId: z.uuid(),
  pin: z.string().regex(/^\d{4}$/, 'must be 4 digits'),
});
export type PinLoginInput = z.infer<typeof pinLoginSchema>;
