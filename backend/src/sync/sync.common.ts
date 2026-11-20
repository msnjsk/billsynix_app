import { createHash } from 'node:crypto';
import type { Tx } from '../database/prisma.service.js';
import { stable } from '../common/idempotency.js';
import type { AuthContext } from '../auth/auth-context.js';
import { forbidden } from '../sales/sales.common.js';

/** The offline policy of a business (docs/phase-0 §5), from `tenants.settings.offline`. */
export type OfflinePolicy = {
  /** The device refuses to bill after this long without reaching the server. */
  maxOfflineHours: number;
  /** …or with this many bills waiting to be synchronised. */
  maxPendingSales: number;
  /** Invoice numbers reserved per block. */
  blockSize: number;
  /** Top up when fewer numbers than this are left. */
  blockLowWater: number;
  /** May an offline counter sell more than its cached stock? The server always accepts (the sale happened) and flags it. */
  allowOversell: boolean;
};

export const DEFAULT_POLICY: OfflinePolicy = {
  maxOfflineHours: 24,
  maxPendingSales: 500,
  blockSize: 200,
  blockLowWater: 50,
  allowOversell: true,
};

export async function offlinePolicy(
  tx: Tx,
  tenantId: string,
): Promise<OfflinePolicy> {
  const t = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { settings: true },
  });
  const o = ((t.settings as { offline?: Record<string, unknown> } | null)
    ?.offline ?? {}) as Record<string, unknown>;
  const int = (k: keyof OfflinePolicy, min: number, max: number) => {
    const v = o[k];
    return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
      ? v
      : (DEFAULT_POLICY[k] as number);
  };
  return {
    maxOfflineHours: int('maxOfflineHours', 1, 72),
    maxPendingSales: int('maxPendingSales', 10, 5000),
    blockSize: int('blockSize', 10, 1000),
    blockLowWater: int('blockLowWater', 1, 500),
    allowOversell:
      typeof o['allowOversell'] === 'boolean'
        ? o['allowOversell']
        : DEFAULT_POLICY.allowOversell,
  };
}

export type DeviceAuth = AuthContext & {
  device: NonNullable<AuthContext['device']>;
};

/** Sync endpoints are for registered POS devices: a cashier PIN session (`X-Device-Key` sign-in). */
export function requireDevice(auth: AuthContext): DeviceAuth {
  if (!auth.device)
    throw forbidden(
      'DEVICE_REQUIRED',
      'Only a registered POS device (cashier PIN sign-in) synchronises offline bills.',
    );
  return auth as DeviceAuth;
}

/** SHA-256 of a payload with sorted keys. */
export const payloadHash = (v: unknown) =>
  createHash('sha256').update(stable(v)).digest('hex');

/** Calendar date of an instant in a time zone, "YYYY-MM-DD". */
export const dateIn = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);

export type Warning = { code: string; message: string } & Record<
  string,
  unknown
>;

/** Grace for device clocks when matching a bill to the cashier's sign-in on the device. */
export const CLOCK_GRACE_MS = 10 * 60_000;
