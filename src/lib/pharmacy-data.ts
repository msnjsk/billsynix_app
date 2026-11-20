/**
 * Mock data for the pharmacy dashboard (business type "Medical shop / pharmacy").
 * Brand names are fictional; molecules are real. Drug schedules are indicative — check them
 * against the current Drugs Rules before relying on them. Replace with API data once a backend exists.
 */
import { TODAY, addDays, daysFromToday, fmtDate } from '@/lib/suppliers-data';
import type { SalesPoint } from '@/lib/dashboard-data';

export { TODAY, daysFromToday, fmtDate };

export type Schedule = 'OTC' | 'H' | 'H1';
export type TherapyArea =
  | 'Diabetes'
  | 'Cardiac & BP'
  | 'Antibiotics'
  | 'Pain & fever'
  | 'Gastro'
  | 'Respiratory & allergy'
  | 'Vitamins'
  | 'Neuro & sleep'
  | 'Thyroid'
  | 'Derma & first aid';

export type Batch = { batch: string; expiry: string; qty: number };

export type Medicine = {
  sku: string;
  brand: string;
  molecule: string;
  form: 'Tablet' | 'Capsule' | 'Syrup' | 'Injection' | 'Sachet' | 'Lotion' | 'Liquid' | 'Device';
  pack: string;
  schedule: Schedule;
  area: TherapyArea;
  generic: boolean;
  /** MRP per pack. */
  mrp: number;
  /** Purchase rate to retailer (cost) per pack. */
  ptr: number;
  reorderLevel: number;
  /** Packs sold in the last 30 days. */
  sold30: number;
  rack: string;
  coldChain: boolean;
  distributor: string;
  batches: Batch[];
};

const d = (days: number) => addDays(TODAY, days);

export const medicines: Medicine[] = [
  {
    sku: 'PH-1001', brand: 'Feverex 650', molecule: 'Paracetamol 650 mg', form: 'Tablet', pack: 'Strip of 15', schedule: 'OTC', area: 'Pain & fever',
    generic: false, mrp: 32, ptr: 24, reorderLevel: 60, sold30: 420, rack: 'A-1', coldChain: false, distributor: 'Vel Medical Agencies',
    batches: [{ batch: 'FX24B11', expiry: d(410), qty: 96 }, { batch: 'FX23K07', expiry: d(48), qty: 44 }],
  },
  {
    sku: 'PH-1002', brand: 'Cefzin 200', molecule: 'Cefixime 200 mg', form: 'Tablet', pack: 'Strip of 10', schedule: 'H1', area: 'Antibiotics',
    generic: false, mrp: 108, ptr: 79, reorderLevel: 25, sold30: 72, rack: 'C-2', coldChain: false, distributor: 'Kaveri Pharma',
    batches: [{ batch: 'CZ24A02', expiry: d(300), qty: 14 }, { batch: 'CZ23H19', expiry: d(-12), qty: 6 }],
  },
  {
    sku: 'PH-1003', brand: 'Levoquin 500', molecule: 'Levofloxacin 500 mg', form: 'Tablet', pack: 'Strip of 5', schedule: 'H1', area: 'Antibiotics',
    generic: false, mrp: 74, ptr: 54, reorderLevel: 20, sold30: 38, rack: 'C-3', coldChain: false, distributor: 'Kaveri Pharma',
    batches: [{ batch: 'LQ24C15', expiry: d(520), qty: 22 }],
  },
  {
    sku: 'PH-1004', brand: 'Azimax 500', molecule: 'Azithromycin 500 mg', form: 'Tablet', pack: 'Strip of 3', schedule: 'H', area: 'Antibiotics',
    generic: false, mrp: 119, ptr: 88, reorderLevel: 20, sold30: 64, rack: 'C-1', coldChain: false, distributor: 'Kaveri Pharma',
    batches: [{ batch: 'AZ24B08', expiry: d(260), qty: 9 }],
  },
  {
    sku: 'PH-1005', brand: 'Moxclav 625', molecule: 'Amoxicillin 500 mg + Clavulanic acid 125 mg', form: 'Tablet', pack: 'Strip of 6', schedule: 'H',
    area: 'Antibiotics', generic: false, mrp: 201, ptr: 152, reorderLevel: 15, sold30: 41, rack: 'C-4', coldChain: false, distributor: 'Kaveri Pharma',
    batches: [{ batch: 'MX24A21', expiry: d(25), qty: 12 }, { batch: 'MX24D02', expiry: d(560), qty: 18 }],
  },
  {
    sku: 'PH-1006', brand: 'Metfor 500 SR', molecule: 'Metformin 500 mg SR', form: 'Tablet', pack: 'Strip of 15', schedule: 'H', area: 'Diabetes',
    generic: true, mrp: 28, ptr: 15, reorderLevel: 80, sold30: 510, rack: 'D-1', coldChain: false, distributor: 'Lifeline Distributors',
    batches: [{ batch: 'MF24C30', expiry: d(640), qty: 210 }],
  },
  {
    sku: 'PH-1007', brand: 'Glimfor M2', molecule: 'Glimepiride 2 mg + Metformin 500 mg', form: 'Tablet', pack: 'Strip of 15', schedule: 'H',
    area: 'Diabetes', generic: false, mrp: 138, ptr: 104, reorderLevel: 40, sold30: 186, rack: 'D-2', coldChain: false, distributor: 'Lifeline Distributors',
    batches: [{ batch: 'GM24B14', expiry: d(380), qty: 38 }],
  },
  {
    sku: 'PH-1008', brand: 'Insuvia R', molecule: 'Human insulin (regular) 40 IU/ml', form: 'Injection', pack: '10 ml vial', schedule: 'H', area: 'Diabetes',
    generic: false, mrp: 162, ptr: 128, reorderLevel: 10, sold30: 34, rack: 'Fridge-1', coldChain: true, distributor: 'Lifeline Distributors',
    batches: [{ batch: 'IR24A09', expiry: d(74), qty: 7 }, { batch: 'IR24C22', expiry: d(330), qty: 12 }],
  },
  {
    sku: 'PH-1009', brand: 'Glarvia Pen', molecule: 'Insulin glargine 100 IU/ml', form: 'Injection', pack: '3 ml pen', schedule: 'H', area: 'Diabetes',
    generic: false, mrp: 760, ptr: 610, reorderLevel: 6, sold30: 18, rack: 'Fridge-1', coldChain: true, distributor: 'Lifeline Distributors',
    batches: [{ batch: 'GP24B03', expiry: d(210), qty: 4 }],
  },
  {
    sku: 'PH-1010', brand: 'Amlotab 5', molecule: 'Amlodipine 5 mg', form: 'Tablet', pack: 'Strip of 15', schedule: 'H', area: 'Cardiac & BP',
    generic: true, mrp: 26, ptr: 13, reorderLevel: 60, sold30: 330, rack: 'B-1', coldChain: false, distributor: 'Vel Medical Agencies',
    batches: [{ batch: 'AM24A17', expiry: d(590), qty: 160 }],
  },
  {
    sku: 'PH-1011', brand: 'Telsar 40', molecule: 'Telmisartan 40 mg', form: 'Tablet', pack: 'Strip of 15', schedule: 'H', area: 'Cardiac & BP',
    generic: false, mrp: 112, ptr: 84, reorderLevel: 40, sold30: 210, rack: 'B-2', coldChain: false, distributor: 'Vel Medical Agencies',
    batches: [{ batch: 'TS24B26', expiry: d(470), qty: 31 }],
  },
  {
    sku: 'PH-1012', brand: 'Atorva 10', molecule: 'Atorvastatin 10 mg', form: 'Tablet', pack: 'Strip of 15', schedule: 'H', area: 'Cardiac & BP',
    generic: false, mrp: 96, ptr: 70, reorderLevel: 30, sold30: 150, rack: 'B-3', coldChain: false, distributor: 'Vel Medical Agencies',
    batches: [{ batch: 'AT23L05', expiry: d(118), qty: 26 }, { batch: 'AT24C11', expiry: d(612), qty: 40 }],
  },
  {
    sku: 'PH-1013', brand: 'Thyrovin 50', molecule: 'Levothyroxine 50 mcg', form: 'Tablet', pack: 'Bottle of 100', schedule: 'H', area: 'Thyroid',
    generic: false, mrp: 165, ptr: 126, reorderLevel: 12, sold30: 46, rack: 'B-6', coldChain: false, distributor: 'Lifeline Distributors',
    batches: [{ batch: 'TH24A28', expiry: d(400), qty: 10 }],
  },
  {
    sku: 'PH-1014', brand: 'Pantoz 40', molecule: 'Pantoprazole 40 mg', form: 'Tablet', pack: 'Strip of 15', schedule: 'H', area: 'Gastro',
    generic: true, mrp: 34, ptr: 16, reorderLevel: 60, sold30: 280, rack: 'E-1', coldChain: false, distributor: 'Vel Medical Agencies',
    batches: [{ batch: 'PZ24B09', expiry: d(520), qty: 122 }],
  },
  {
    sku: 'PH-1015', brand: 'Ondaset 4', molecule: 'Ondansetron 4 mg', form: 'Tablet', pack: 'Strip of 10', schedule: 'H', area: 'Gastro',
    generic: false, mrp: 58, ptr: 41, reorderLevel: 20, sold30: 62, rack: 'E-2', coldChain: false, distributor: 'Kaveri Pharma',
    batches: [{ batch: 'OD23J30', expiry: d(9), qty: 15 }, { batch: 'OD24C04', expiry: d(480), qty: 20 }],
  },
  {
    sku: 'PH-1016', brand: 'Montek LC', molecule: 'Montelukast 10 mg + Levocetirizine 5 mg', form: 'Tablet', pack: 'Strip of 10', schedule: 'H',
    area: 'Respiratory & allergy', generic: false, mrp: 215, ptr: 161, reorderLevel: 20, sold30: 96, rack: 'F-1', coldChain: false, distributor: 'Kaveri Pharma',
    batches: [{ batch: 'ML24A11', expiry: d(355), qty: 0 }],
  },
  {
    sku: 'PH-1017', brand: 'Cetrin 10', molecule: 'Cetirizine 10 mg', form: 'Tablet', pack: 'Strip of 10', schedule: 'OTC', area: 'Respiratory & allergy',
    generic: true, mrp: 20, ptr: 9, reorderLevel: 40, sold30: 190, rack: 'F-2', coldChain: false, distributor: 'Vel Medical Agencies',
    batches: [{ batch: 'CT24B19', expiry: d(700), qty: 140 }],
  },
  {
    sku: 'PH-1018', brand: 'Alzolam 0.25', molecule: 'Alprazolam 0.25 mg', form: 'Tablet', pack: 'Strip of 10', schedule: 'H1', area: 'Neuro & sleep',
    generic: false, mrp: 36, ptr: 26, reorderLevel: 15, sold30: 40, rack: 'Locked-1', coldChain: false, distributor: 'Kaveri Pharma',
    batches: [{ batch: 'AL24A03', expiry: d(430), qty: 24 }],
  },
  {
    sku: 'PH-1019', brand: 'Zolnite 10', molecule: 'Zolpidem 10 mg', form: 'Tablet', pack: 'Strip of 10', schedule: 'H1', area: 'Neuro & sleep',
    generic: false, mrp: 128, ptr: 95, reorderLevel: 10, sold30: 22, rack: 'Locked-1', coldChain: false, distributor: 'Kaveri Pharma',
    batches: [{ batch: 'ZN23G12', expiry: d(-3), qty: 3 }, { batch: 'ZN24B20', expiry: d(380), qty: 8 }],
  },
  {
    sku: 'PH-1020', brand: 'Hydrolyte ORS', molecule: 'Oral rehydration salts (WHO)', form: 'Sachet', pack: '21.8 g sachet', schedule: 'OTC',
    area: 'Gastro', generic: true, mrp: 22, ptr: 14, reorderLevel: 50, sold30: 260, rack: 'G-1', coldChain: false, distributor: 'Vel Medical Agencies',
    batches: [{ batch: 'OR24A30', expiry: d(66), qty: 80 }, { batch: 'OR24D01', expiry: d(720), qty: 60 }],
  },
  {
    sku: 'PH-1021', brand: 'Vitamax D3 60K', molecule: 'Cholecalciferol 60,000 IU', form: 'Sachet', pack: '1 g sachet', schedule: 'OTC', area: 'Vitamins',
    generic: false, mrp: 48, ptr: 31, reorderLevel: 40, sold30: 150, rack: 'G-3', coldChain: false, distributor: 'Lifeline Distributors',
    batches: [{ batch: 'VD24B01', expiry: d(160), qty: 18 }],
  },
  {
    sku: 'PH-1022', brand: 'Becomin Z', molecule: 'Vitamin B-complex + Zinc', form: 'Capsule', pack: 'Strip of 15', schedule: 'OTC', area: 'Vitamins',
    generic: false, mrp: 52, ptr: 34, reorderLevel: 40, sold30: 170, rack: 'G-2', coldChain: false, distributor: 'Lifeline Distributors',
    batches: [{ batch: 'BZ24A14', expiry: d(240), qty: 75 }],
  },
  {
    sku: 'PH-1023', brand: 'Calamin Lotion', molecule: 'Calamine 8% + Zinc oxide', form: 'Lotion', pack: '100 ml bottle', schedule: 'OTC',
    area: 'Derma & first aid', generic: true, mrp: 95, ptr: 62, reorderLevel: 10, sold30: 28, rack: 'H-1', coldChain: false, distributor: 'Vel Medical Agencies',
    batches: [{ batch: 'CL23K15', expiry: d(37), qty: 8 }],
  },
  {
    sku: 'PH-1024', brand: 'Sepsol Antiseptic', molecule: 'Chloroxylenol 4.8%', form: 'Liquid', pack: '500 ml bottle', schedule: 'OTC',
    area: 'Derma & first aid', generic: false, mrp: 210, ptr: 158, reorderLevel: 8, sold30: 24, rack: 'H-3', coldChain: false, distributor: 'Vel Medical Agencies',
    batches: [{ batch: 'SP24B07', expiry: d(900), qty: 14 }],
  },
  {
    sku: 'PH-1025', brand: 'InsuFine Syringe 40U', molecule: 'Insulin syringe 1 ml, 40 U', form: 'Device', pack: 'Pack of 10', schedule: 'OTC',
    area: 'Diabetes', generic: true, mrp: 85, ptr: 52, reorderLevel: 15, sold30: 44, rack: 'H-4', coldChain: false, distributor: 'Lifeline Distributors',
    batches: [{ batch: 'IS24A05', expiry: d(1100), qty: 6 }],
  },
];

/** Sellable stock — expired batches don't count (they belong in the Expiry panel, not on sale). */
export const stockOf = (m: Medicine) => m.batches.filter((b) => daysFromToday(b.expiry) >= 0).reduce((s, b) => s + b.qty, 0);
export const marginPct = (m: Medicine) => Math.round(((m.mrp - m.ptr) / m.mrp) * 1000) / 10;

/* ---------- expiry ---------- */

export type ExpiryBand = 'expired' | 'd30' | 'd90' | 'd180';

/** Pharmacies plan three months ahead: distributors take back short-expiry stock, so it is returned, not discarded. */
export const expiryBands: Record<ExpiryBand, { label: string; hint: string; test: (days: number) => boolean; action: string }> = {
  expired: { label: 'Expired', hint: 'Remove from the shelf now — cannot be sold', test: (n) => n < 0, action: 'Return / destroy' },
  d30: { label: '≤ 30 days', hint: 'Return to the distributor this month', test: (n) => n >= 0 && n <= 30, action: 'Return' },
  d90: { label: '31–90 days', hint: 'Sell first, or return before 30 days', test: (n) => n > 30 && n <= 90, action: 'Sell first' },
  d180: { label: '91–180 days', hint: 'Keep an eye on these', test: (n) => n > 90 && n <= 180, action: 'Watch' },
};

export type BatchRow = Batch & { id: string; med: Medicine; days: number; value: number; band: ExpiryBand | null };

export const batchRows: BatchRow[] = medicines
  .flatMap((m) =>
    m.batches
      .filter((b) => b.qty > 0)
      .map((b) => {
        const days = daysFromToday(b.expiry);
        const band = (Object.keys(expiryBands) as ExpiryBand[]).find((k) => expiryBands[k].test(days)) ?? null;
        return { ...b, id: `${m.sku}:${b.batch}`, med: m, days, value: b.qty * m.ptr, band };
      })
  )
  .sort((a, b) => a.days - b.days);

/* ---------- reorder ---------- */

/** Order enough for three weeks of sales. */
export const COVER_DAYS = 21;
export const suggestedQty = (m: Medicine) => Math.max(0, Math.ceil((m.sold30 / 30) * COVER_DAYS - stockOf(m)));
export const daysLeft = (m: Medicine) => (m.sold30 ? Math.floor(stockOf(m) / (m.sold30 / 30)) : Infinity);
export const shortItems = medicines
  .filter((m) => stockOf(m) <= m.reorderLevel)
  .sort((a, b) => daysLeft(a) - daysLeft(b));

/* ---------- sales ---------- */

/** Last 14 days, ending today (14 May). Margin ≈ 21%, previous period ≈ 9% lower. */
export const pharmaSales: SalesPoint[] = [
  41200, 39800, 44600, 52300, 36900, 42100, 43800, 45200, 47100, 51800, 58400, 38700, 46900, 48620,
].map((revenue, i) => ({
  label: fmtDate(addDays(TODAY, i - 13)),
  revenue,
  profit: Math.round((revenue * 0.214) / 10) * 10,
  previous: Math.round(revenue / 1.09 / 100) * 100,
}));

export const today = {
  revenue: 48620,
  yesterday: 46900,
  bills: 142,
  billsYesterday: 136,
  rxBills: 88,
  marginPct: 21.4,
  marginPctYesterday: 20.8,
  genericSharePct: 34,
};

export const areaMix: { area: TherapyArea; pct: number }[] = [
  { area: 'Diabetes', pct: 22 },
  { area: 'Cardiac & BP', pct: 18 },
  { area: 'Antibiotics', pct: 14 },
  { area: 'Pain & fever', pct: 10 },
  { area: 'Gastro', pct: 9 },
  { area: 'Respiratory & allergy', pct: 8 },
  { area: 'Vitamins', pct: 8 },
  { area: 'Derma & first aid', pct: 5 },
  { area: 'Neuro & sleep', pct: 4 },
  { area: 'Thyroid', pct: 2 },
];

export const topMolecules = [...medicines].sort((a, b) => b.sold30 * b.mrp - a.sold30 * a.mrp).slice(0, 6);

/* ---------- Schedule H1 register ---------- */

/**
 * Schedule H1 sales must be entered in a separate register — prescriber's name and address, patient's
 * name and address, drug name and quantity — kept for three years and open to inspection.
 */
export type H1Entry = {
  id: string;
  time: string;
  bill: number;
  sku: string;
  qty: number;
  patient: string;
  patientAddress: string;
  doctor: string;
  doctorRegNo: string;
};

export const h1Today: H1Entry[] = [
  { id: 'h1', time: '09:12', bill: 3911, sku: 'PH-1002', qty: 1, patient: 'Ramesh K', patientAddress: 'Jayanagar 4th Block', doctor: 'Dr. S. Anand', doctorRegNo: 'KMC 48211' },
  { id: 'h2', time: '09:47', bill: 3916, sku: 'PH-1018', qty: 1, patient: 'Lalitha V', patientAddress: 'BTM 2nd Stage', doctor: 'Dr. P. Rao', doctorRegNo: '' },
  { id: 'h3', time: '10:20', bill: 3922, sku: 'PH-1003', qty: 1, patient: 'Mohammed I', patientAddress: 'Wilson Garden', doctor: 'Dr. N. Shetty', doctorRegNo: 'KMC 51902' },
  { id: 'h4', time: '11:05', bill: 3931, sku: 'PH-1019', qty: 1, patient: 'Geetha R', patientAddress: '', doctor: 'Dr. P. Rao', doctorRegNo: '' },
  { id: 'h5', time: '11:38', bill: 3937, sku: 'PH-1002', qty: 2, patient: 'Arjun M', patientAddress: 'JP Nagar 6th Phase', doctor: 'Dr. S. Anand', doctorRegNo: 'KMC 48211' },
  { id: 'h6', time: '12:15', bill: 3944, sku: 'PH-1003', qty: 1, patient: 'Fatima B', patientAddress: 'Tilak Nagar', doctor: 'Dr. K. Iyer', doctorRegNo: 'KMC 39550' },
];

/* ---------- refills ---------- */

export type Refill = {
  id: string;
  patient: string;
  phone: string;
  condition: string;
  sku: string;
  packs: number;
  lastBought: string;
  /** Days one purchase lasts. */
  supplyDays: number;
};

export const refills: Refill[] = [
  { id: 'r1', patient: 'Shankar Rao', phone: '+91 98450 22113', condition: 'Diabetes', sku: 'PH-1007', packs: 4, lastBought: d(-29), supplyDays: 30 },
  { id: 'r2', patient: 'Vasantha K', phone: '+91 99001 47820', condition: 'Blood pressure', sku: 'PH-1011', packs: 2, lastBought: d(-31), supplyDays: 30 },
  { id: 'r3', patient: 'Abdul Rahim', phone: '+91 97411 30962', condition: 'Diabetes (insulin)', sku: 'PH-1008', packs: 2, lastBought: d(-25), supplyDays: 28 },
  { id: 'r4', patient: 'Sujatha N', phone: '+91 98861 55407', condition: 'Thyroid', sku: 'PH-1013', packs: 1, lastBought: d(-96), supplyDays: 100 },
  { id: 'r5', patient: 'George M', phone: '+91 90080 61234', condition: 'Cholesterol', sku: 'PH-1012', packs: 2, lastBought: d(-24), supplyDays: 30 },
  { id: 'r6', patient: 'Kamala Devi', phone: '+91 96320 88415', condition: 'Diabetes', sku: 'PH-1006', packs: 4, lastBought: d(-27), supplyDays: 30 },
  { id: 'r7', patient: 'Prakash S', phone: '+91 94480 17733', condition: 'Blood pressure', sku: 'PH-1010', packs: 2, lastBought: d(-14), supplyDays: 30 },
];

export const refillDue = (r: Refill) => daysFromToday(addDays(r.lastBought, r.supplyDays));

/* ---------- cold chain ---------- */

export const FRIDGE_MIN = 2;
export const FRIDGE_MAX = 8;
export const fridgeLog = [
  { time: '08:00', temp: 4.6, by: 'Lakshmi' },
  { time: '12:00', temp: 5.4, by: 'Lakshmi' },
];
export const NEXT_FRIDGE_CHECK = '16:00';

/* ---------- distributor dues ---------- */

export const distributorDues = [
  { name: 'Kaveri Pharma', due: 38450, dueDate: d(-2), creditDays: 21 },
  { name: 'Lifeline Distributors', due: 52200, dueDate: d(4), creditDays: 30 },
  { name: 'Vel Medical Agencies', due: 21780, dueDate: d(12), creditDays: 30 },
];

export const bySku = (sku: string) => medicines.find((m) => m.sku === sku);
