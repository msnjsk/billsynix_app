/** GST state codes (first two characters of a GSTIN). Same list as the frontend. */
export const GST_STATES: Readonly<Record<string, string>> = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

export const STATE_CODES = Object.keys(GST_STATES) as [string, ...string[]];

const GSTIN_FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Mod-36 check character over the first 14 characters (GSTN algorithm). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARS.indexOf(first14[i] ?? '') * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36] ?? '';
}

/** null when valid, otherwise a message suitable for an API error. */
export function gstinProblem(raw: string): string | null {
  const g = raw.trim().toUpperCase();
  if (!GSTIN_FORMAT.test(g))
    return 'A GSTIN is 15 characters, e.g. 33ABCDE1234F1Z5.';
  if (!GST_STATES[g.slice(0, 2)])
    return `${g.slice(0, 2)} is not a GST state code.`;
  if (gstinCheckChar(g.slice(0, 14)) !== g[14])
    return 'The GSTIN check digit does not match.';
  return null;
}

/** PAN embedded in a GSTIN (characters 3–12) — the same for every state registration. */
export const panOf = (gstin: string) => gstin.slice(2, 12);
