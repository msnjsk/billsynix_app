import type { Tx } from '../database/prisma.service.js';
import type { TaxKind } from '../generated/prisma/client.js';

/**
 * What every new business starts with. Keep in step with the backfill in the
 * `catalogue` migration (which gave existing businesses the same rows).
 *
 * ⚠ GST slabs follow the September 2025 rationalisation (5% / 18%, 40% for sin goods, nil for
 * fresh produce). The business adds others (e.g. 12% or 28% + cess for older stock) as needed;
 * have an accountant confirm each product's HSN and rate before issuing invoices.
 */
export const DEFAULT_TAX_RATES: ReadonlyArray<{
  name: string;
  kind: TaxKind;
  rate: number;
}> = [
  { name: 'GST 0% (nil-rated)', kind: 'NIL_RATED', rate: 0 },
  { name: 'Exempt', kind: 'EXEMPT', rate: 0 },
  { name: 'GST 5%', kind: 'TAXABLE', rate: 5 },
  { name: 'GST 18%', kind: 'TAXABLE', rate: 18 },
  { name: 'GST 40%', kind: 'TAXABLE', rate: 40 },
];

export const DEFAULT_UNITS: ReadonlyArray<{
  code: string;
  name: string;
  decimals: number;
  uqc: string;
}> = [
  { code: 'PCS', name: 'Pieces', decimals: 0, uqc: 'NOS' },
  { code: 'KG', name: 'Kilogram', decimals: 3, uqc: 'KGS' },
  { code: 'G', name: 'Gram', decimals: 0, uqc: 'GMS' },
  { code: 'L', name: 'Litre', decimals: 3, uqc: 'LTR' },
  { code: 'ML', name: 'Millilitre', decimals: 0, uqc: 'MLT' },
  { code: 'PKT', name: 'Packet', decimals: 0, uqc: 'PAC' },
  { code: 'BOX', name: 'Box', decimals: 0, uqc: 'BOX' },
  { code: 'DOZ', name: 'Dozen', decimals: 0, uqc: 'DOZ' },
  { code: 'M', name: 'Metre', decimals: 2, uqc: 'MTR' },
];

/** GST Unique Quantity Codes (the list GSTN accepts in returns). */
export const UQC_CODES = [
  'BAG',
  'BAL',
  'BDL',
  'BKL',
  'BOU',
  'BOX',
  'BTL',
  'BUN',
  'CAN',
  'CBM',
  'CCM',
  'CMS',
  'CTN',
  'DOZ',
  'DRM',
  'GGK',
  'GMS',
  'GRS',
  'GYD',
  'KGS',
  'KLR',
  'KME',
  'LTR',
  'MLT',
  'MTR',
  'MTS',
  'NOS',
  'OTH',
  'PAC',
  'PCS',
  'PRS',
  'QTL',
  'ROL',
  'SET',
  'SQF',
  'SQM',
  'SQY',
  'TBS',
  'TGM',
  'THD',
  'TON',
  'TUB',
  'UGS',
  'UNT',
  'YDS',
] as const;

/** Inside the registration transaction. */
export async function createCatalogueDefaults(tx: Tx, tenantId: string) {
  await tx.taxRate.createMany({
    data: DEFAULT_TAX_RATES.map((t) => ({ tenantId, ...t })),
  });
  await tx.unit.createMany({
    data: DEFAULT_UNITS.map((u) => ({ tenantId, ...u })),
  });
}
