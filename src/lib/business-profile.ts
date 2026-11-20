/**
 * Business profile: who the store is (printed on every invoice), how it is registered for GST,
 * and which features suit its type of business.
 *
 * Saved per computer in browser storage until a backend exists; every screen reads it through
 * `useBusinessProfile()` and updates live when it is saved (also across tabs / the desktop app).
 */
import { apiConfigured } from '@/lib/api/client';
import { useSyncExternalStore } from 'react';

/* ---------- business types & modules ---------- */

export const businessTypes = {
  grocery: { label: 'Grocery & departmental', blurb: 'Kirana, provisions, departmental stores' },
  supermarket: { label: 'Supermarket / mini-market', blurb: 'Multi-counter self-service stores' },
  pharmacy: { label: 'Medical shop / pharmacy', blurb: 'Medicines, batches, expiry, prescriptions' },
  electronics: { label: 'Mobile & electronics', blurb: 'Phones, accessories, appliances' },
  garments: { label: 'Garments & textile', blurb: 'Clothing, sarees, fabric by the metre' },
  hardware: { label: 'Hardware & electrical', blurb: 'Tools, fittings, cables, paint' },
  wholesale: { label: 'Wholesale & distribution', blurb: 'B2B sales, bulk quantities, credit' },
  restaurant: { label: 'Restaurant / food outlet', blurb: 'Cafés, sweet shops, small eateries' },
} as const;
export type BusinessType = keyof typeof businessTypes;

/**
 * Features a store can switch on. `available` ones work today; the others are planned and
 * shown so the store knows what is coming for its type of business.
 */
export const moduleInfo = {
  expiry: {
    label: 'Batch & expiry',
    desc: 'Near-expiry batches appear in POS search with an automatic markdown; expired stock is blocked.',
    available: true,
  },
  loyalty: { label: 'Loyalty points', desc: "Shows the customer's tier and points on the bill.", available: true },
  serials: { label: 'Serial / IMEI numbers', desc: 'Capture the serial or IMEI of each unit sold; warranty on the invoice.', available: false },
  variants: { label: 'Size & colour variants', desc: 'One product with sizes / colours, each with its own barcode and stock.', available: false },
  units: { label: 'Units & conversions', desc: 'Sell by piece, box, metre or kg with automatic conversion.', available: false },
  prescriptions: { label: 'Prescriptions', desc: 'Doctor and patient details for Schedule H / H1 medicines.', available: false },
  priceLists: { label: 'Customer price lists', desc: 'Wholesale / dealer price tiers per customer, credit limits.', available: false },
  tables: { label: 'Tables & kitchen orders', desc: 'Table service, KOT printing, split bills, service charge.', available: false },
} as const;
export type ModuleKey = keyof typeof moduleInfo;
export type Modules = Record<ModuleKey, boolean>;

const off: Modules = { expiry: false, loyalty: false, serials: false, variants: false, units: false, prescriptions: false, priceLists: false, tables: false };

/** Suggested features per business type (applied when the type is chosen). */
export const presetModules: Record<BusinessType, Modules> = {
  grocery: { ...off, expiry: true, loyalty: true },
  supermarket: { ...off, expiry: true, loyalty: true, units: true },
  pharmacy: { ...off, expiry: true, loyalty: true, prescriptions: true, units: true },
  electronics: { ...off, serials: true, loyalty: true },
  garments: { ...off, variants: true, loyalty: true, units: true },
  hardware: { ...off, units: true, priceLists: true },
  wholesale: { ...off, priceLists: true, units: true, expiry: true },
  restaurant: { ...off, tables: true, loyalty: true },
};

/**
 * Features that make sense for each type of business, most useful first. Only these are offered
 * when the type is chosen (e.g. no IMEI numbers for a grocery, no kitchen orders for a pharmacy).
 */
export const relevantModules: Record<BusinessType, ModuleKey[]> = {
  grocery: ['expiry', 'loyalty', 'units'],
  supermarket: ['expiry', 'loyalty', 'units', 'priceLists'],
  pharmacy: ['expiry', 'prescriptions', 'units', 'loyalty'],
  electronics: ['serials', 'loyalty', 'priceLists'],
  garments: ['variants', 'units', 'loyalty'],
  hardware: ['units', 'priceLists', 'serials'],
  wholesale: ['priceLists', 'units', 'expiry'],
  restaurant: ['tables', 'loyalty'],
};

/**
 * Licence fields offered for each type at all: food sellers have an FSSAI licence, pharmacies a drug
 * licence (and often FSSAI for nutrition products); electronics, garments and hardware need neither.
 */
export const licenceFields: Record<BusinessType, ('fssai' | 'drugLicence')[]> = {
  grocery: ['fssai'],
  supermarket: ['fssai'],
  pharmacy: ['drugLicence', 'fssai'],
  electronics: [],
  garments: [],
  hardware: [],
  wholesale: ['fssai'],
  restaurant: ['fssai'],
};

/** Licence numbers that belong on the invoice for each type (shown first on the form). */
export const suggestedLicences: Record<BusinessType, ('fssai' | 'drugLicence')[]> = {
  grocery: ['fssai'],
  supermarket: ['fssai'],
  pharmacy: ['drugLicence'],
  electronics: [],
  garments: [],
  hardware: [],
  wholesale: ['fssai'],
  restaurant: ['fssai'],
};

/* ---------- GST ---------- */

export type Registration = 'regular' | 'composition' | 'unregistered';

export const registrationInfo: Record<Registration, { label: string; desc: string }> = {
  regular: { label: 'Regular GST', desc: 'Charges GST and issues tax invoices (CGST + SGST, or IGST).' },
  composition: { label: 'Composition scheme', desc: 'Pays tax on turnover; issues a Bill of Supply and does not collect GST.' },
  unregistered: { label: 'Not registered', desc: 'Below the GST threshold; issues a plain Bill of Supply.' },
};

/** GST state codes (first two digits of a GSTIN). */
export const gstStates: Record<string, string> = {
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

const GSTIN_FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The 15th character of a GSTIN is a mod-36 check digit over the first 14. */
export const gstinCheckChar = (first14: string) => {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARS.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36]!;
};

/** null if valid, else a message for the form. */
export const gstinProblem = (raw: string): string | null => {
  const g = raw.trim().toUpperCase();
  if (!GSTIN_FORMAT.test(g)) return 'A GSTIN is 15 characters, e.g. 33ABCDE1234F1Z5';
  if (!gstStates[g.slice(0, 2)]) return `${g.slice(0, 2)} is not a GST state code`;
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return 'The last character (check digit) does not match — please re-check the GSTIN';
  return null;
};

/* ---------- the profile ---------- */

export type BusinessProfile = {
  businessType: BusinessType;
  /** Name customers see — printed large on the receipt. */
  displayName: string;
  /** Registered legal name, if different. */
  legalName: string;
  ownerName: string;
  phone: string;
  email: string;
  address: { line1: string; line2: string; city: string; pincode: string; stateCode: string };
  registration: Registration;
  gstin: string;
  fssai: string;
  drugLicence: string;
  /** Prefix of the invoice series, e.g. SFM → SFM/26-27/04822. */
  invoicePrefix: string;
  receiptFooter: string;
  modules: Modules;
  /** True until the store saves its own details (the defaults are a demo store). */
  isSample: boolean;
};

export const defaultProfile: BusinessProfile = {
  businessType: 'grocery',
  displayName: 'Senthil Fresh Mart',
  legalName: '',
  ownerName: 'Senthil Kumar',
  phone: '+91 44 2626 1234',
  email: '',
  address: { line1: '12, 2nd Avenue, Anna Nagar', line2: '', city: 'Chennai', pincode: '600040', stateCode: '33' },
  registration: 'regular',
  gstin: '33ABCPS1234K1Z5',
  fssai: '',
  drugLicence: '',
  invoicePrefix: 'SFM',
  receiptFooter: 'Exchange within 7 days with this bill. Thank you, visit again!',
  modules: presetModules.grocery,
  isSample: true,
};

/** Printable address lines, e.g. ["12, 2nd Avenue, Anna Nagar", "Chennai, Tamil Nadu 600040"]. */
export const addressLines = (p: BusinessProfile) => {
  const state = gstStates[p.address.stateCode] ?? '';
  const cityLine = [p.address.city, [state, p.address.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [p.address.line1, p.address.line2, cityLine].filter((l) => l.trim());
};

/** State used to decide CGST+SGST vs IGST: from the GSTIN when present, else the address. */
export const profileStateCode = (p: BusinessProfile) => (p.gstin.length >= 2 && p.registration !== 'unregistered' ? p.gstin.slice(0, 2) : p.address.stateCode);

export const chargesGst = (p: Pick<BusinessProfile, 'registration'>) => p.registration === 'regular';

/** Composition dealers must print this on every bill of supply (CGST Rules, rule 46A / 49). */
export const COMPOSITION_DECLARATION = 'Composition taxable person, not eligible to collect tax on supplies';

/** Lines under the store name on every receipt: legal name, address, phone, GSTIN and licences. */
export const receiptHeaderLines = (p: BusinessProfile) => [
  ...(p.legalName.trim() && p.legalName.trim() !== p.displayName.trim() ? [p.legalName.trim()] : []),
  ...addressLines(p),
  ...(p.phone.trim() ? [`Ph ${p.phone.trim()}`] : []),
  ...(p.registration !== 'unregistered' && p.gstin.trim() ? [`GSTIN ${p.gstin.trim().toUpperCase()}`] : []),
  ...(p.fssai.trim() ? [`FSSAI Lic. No. ${p.fssai.trim()}`] : []),
  ...(p.drugLicence.trim() ? [`D.L. No. ${p.drugLicence.trim()}`] : []),
];

/** Heading printed on a document. */
export const documentTitle = (doc: { kind: 'invoice' | 'credit'; billOfSupply?: boolean | undefined; buyer?: { gstin: string } | null }) =>
  doc.kind === 'credit' ? 'CREDIT NOTE (RETURN)' : doc.billOfSupply ? 'BILL OF SUPPLY' : doc.buyer?.gstin ? 'TAX INVOICE' : 'TAX INVOICE / BILL';

/* ---------- storage + live hook ---------- */

const KEY = 'kirana:business-profile';
/** Connected mode keeps no profile on the computer — only the last signed-in store's name and type. */
const LIVE_CARD_KEY = 'kirana:live-store';

/** The store last signed in to on this computer (connected mode), or null — never the sample store. */
export function liveStoreCard(): { displayName: string; businessType: BusinessType } | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(LIVE_CARD_KEY) ?? 'null') as { displayName?: unknown; businessType?: unknown } | null;
    if (!v || typeof v.displayName !== 'string' || !v.displayName) return null;
    const type = typeof v.businessType === 'string' && v.businessType in businessTypes ? (v.businessType as BusinessType) : 'supermarket';
    return { displayName: v.displayName, businessType: type };
  } catch {
    return null;
  }
}
let cache: BusinessProfile | null = null;
const listeners = new Set<() => void>();

/** Saved profile merged over defaults, so fields added later always have a value. */
function read(): BusinessProfile {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return defaultProfile;
    const saved = JSON.parse(raw) as Partial<BusinessProfile>;
    return {
      ...defaultProfile,
      ...saved,
      address: { ...defaultProfile.address, ...saved.address },
      modules: { ...defaultProfile.modules, ...saved.modules },
    };
  } catch {
    return defaultProfile;
  }
}

export function getBusinessProfile(): BusinessProfile {
  if (typeof window === 'undefined') return defaultProfile;
  cache ??= read();
  return cache;
}

export function saveBusinessProfile(p: BusinessProfile) {
  cache = { ...p, isSample: false };
  try {
    if (!apiConfigured) window.localStorage.setItem(KEY, JSON.stringify(cache));
    else window.localStorage.setItem(LIVE_CARD_KEY, JSON.stringify({ displayName: p.displayName, businessType: p.businessType }));
  } catch {
    /* storage blocked — the profile still applies until the page is closed */
  }
  listeners.forEach((l) => l());
}

/** Back to the demo store's details. `keepType`: the type chosen at setup stays (it can't change). */
export function resetBusinessProfile(keepType?: BusinessType) {
  cache = keepType ? { ...defaultProfile, businessType: keepType, modules: presetModules[keepType] } : defaultProfile;
  try {
    // Keeping the type: remember it (still marked as sample details); otherwise forget everything.
    if (keepType && !apiConfigured) window.localStorage.setItem(KEY, JSON.stringify(cache));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    cache = null; // saved in another tab / window
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The current profile; re-renders when it is saved anywhere. Server render uses the defaults. */
export function useBusinessProfile() {
  return useSyncExternalStore(subscribe, getBusinessProfile, () => defaultProfile);
}
