import type {
  Counter,
  Store,
  TerminalDevice,
} from '../generated/prisma/client.js';

export const storeView = (s: Store) => ({
  id: s.id,
  code: s.code,
  name: s.name,
  kind: s.kind,
  isHq: s.isHq,
  address: {
    line1: s.addressLine1,
    line2: s.addressLine2,
    city: s.city,
    pincode: s.pincode,
    stateCode: s.stateCode,
  },
  gstin: s.gstin,
  phone: s.phone,
  managerName: s.managerName,
  timezone: s.timezone,
  monthlyTarget: s.monthlyTarget.toFixed(2),
  openedOn: s.openedOn ? s.openedOn.toISOString().slice(0, 10) : null,
  status: s.status,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

export const counterView = (c: Counter) => ({
  id: c.id,
  storeId: c.storeId,
  number: c.number,
  name: c.name,
  status: c.status,
  createdAt: c.createdAt,
});

/** Never exposes the key hash. */
export const deviceView = (d: TerminalDevice) => ({
  id: d.id,
  storeId: d.storeId,
  counterId: d.counterId,
  name: d.name,
  lastSeenAt: d.lastSeenAt,
  revokedAt: d.revokedAt,
  status: d.revokedAt ? 'REVOKED' : 'ACTIVE',
  createdAt: d.createdAt,
});
