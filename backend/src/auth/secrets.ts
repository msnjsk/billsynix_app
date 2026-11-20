import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';

/* ---------- random tokens (refresh, reset, device keys) ---------- */

/** 256 bits of randomness, URL-safe. */
export const newSecret = () => randomBytes(32).toString('base64url');

/** Tokens are high-entropy, so a fast hash is enough to keep them unusable if the database leaks. */
export const sha256 = (s: string) =>
  createHash('sha256').update(s).digest('hex');

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/* ---------- human secrets (passwords, PINs) ---------- */

export const ARGON2_OPTIONS = { type: argon2.argon2id } as const;

export const hashSecret = (plain: string) => argon2.hash(plain, ARGON2_OPTIONS);

export async function verifySecret(
  hash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** True when a stored hash was made with weaker-than-current cost settings. */
export const needsRehash = (hash: string) => argon2.needsRehash(hash);

let dummyHash: Promise<string> | undefined;
/**
 * Spends the same time as a real check when the account doesn't exist, so response timing
 * doesn't reveal which emails are registered.
 */
export async function verifyAgainstDummy(plain: string): Promise<void> {
  dummyHash ??= hashSecret('not-a-real-password-just-for-timing');
  await verifySecret(await dummyHash, plain);
}

/** Device keys: `<tenantId>.<deviceId>.<secret>` (the tenant lets the API open the right RLS scope). */
export function parseDeviceKey(
  key: string,
): { tenantId: string; deviceId: string } | null {
  const m = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/.exec(key);
  return m ? { tenantId: m[1]!, deviceId: m[2]! } : null;
}
