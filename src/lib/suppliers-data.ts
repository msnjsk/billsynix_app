/**
 * Mock supplier data, extending the basic list in store-data.
 * Replace with API calls (e.g. TanStack Query hooks) once a backend exists.
 */
import { suppliers as baseSuppliers } from '@/lib/store-data';
import { apiConfigured } from '@/lib/api/client';

/** "Today": the real local date when connected to a backend, the sample data's date otherwise. */
export const TODAY = apiConfigured
  ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  : '2024-05-14';

const toUtc = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
};

/** Whole days from TODAY to `iso` (negative = in the past). */
export const daysFromToday = (iso: string) => Math.round((toUtc(iso) - toUtc(TODAY)) / 86_400_000);

export const addDays = (iso: string, days: number) =>
  new Date(toUtc(iso) + days * 86_400_000).toISOString().slice(0, 10);

/** "14 May" — formatted in UTC so server and client render the same text. */
export const fmtDate = (iso: string) =>
  new Date(toUtc(iso)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export type PaymentMethod = 'Bank transfer' | 'UPI' | 'Cash' | 'Cheque';
export type Payment = { date: string; amount: number; method: PaymentMethod; ref: string };

export type Supplier = {
  id: string;
  name: string;
  contact: string;
  phone: string;
  email: string;
  gstin: string;
  supplies: string;
  creditDays: number;
  since: number;
  onTime: number; // % of deliveries on time
  lastDelivery: string | null;
  due: number;
  dueDate: string | null;
  payments: Payment[];
};

type Extra = Omit<Supplier, 'id' | 'name' | 'phone' | 'supplies' | 'due'>;

const extras: Record<string, Extra> = {
  'Nandini Dairy Co-op': {
    contact: 'Manjunath G',
    email: 'orders@nandini-coop.example',
    gstin: '29AABCN1234F1Z5',
    creditDays: 7,
    since: 2019,
    onTime: 96,
    lastDelivery: '2024-05-14',
    dueDate: '2024-05-16',
    payments: [
      { date: '2024-05-07', amount: 21600, method: 'UPI', ref: 'UPI/412873' },
      { date: '2024-04-30', amount: 19850, method: 'Bank transfer', ref: 'NEFT/88213' },
    ],
  },
  'Sri Balaji Traders': {
    contact: 'Venkatesh B',
    email: 'accounts@sribalaji.example',
    gstin: '33AAGFS5678K1Z2',
    creditDays: 10,
    since: 2017,
    onTime: 88,
    lastDelivery: '2024-05-13',
    dueDate: '2024-05-12',
    payments: [{ date: '2024-04-29', amount: 38200, method: 'Bank transfer', ref: 'NEFT/87120' }],
  },
  'Fizzo Beverages': {
    contact: 'Rahul Menon',
    email: 'south@fizzo.example',
    gstin: '33AACCF9012L1ZX',
    creditDays: 15,
    since: 2021,
    onTime: 92,
    lastDelivery: '2024-05-09',
    dueDate: null,
    payments: [{ date: '2024-05-10', amount: 9400, method: 'UPI', ref: 'UPI/409911' }],
  },
  'Bake House': {
    contact: 'Selvi P',
    email: '',
    gstin: '',
    creditDays: 7,
    since: 2022,
    onTime: 98,
    lastDelivery: '2024-05-13',
    dueDate: '2024-05-20',
    payments: [{ date: '2024-05-11', amount: 2800, method: 'Cash', ref: 'Receipt 3391' }],
  },
};

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export const initialSuppliers: Supplier[] = baseSuppliers.map((s) => {
  const extra = extras[s.name] ?? {
    contact: '',
    email: '',
    gstin: '',
    creditDays: 7,
    since: 2024,
    onTime: 100,
    lastDelivery: null,
    dueDate: null,
    payments: [],
  };
  return { id: slug(s.name), name: s.name, phone: s.phone, supplies: s.items, due: s.due, ...extra };
});

export type PoLine = { name: string; qty: number; cost: number };
export type PoStatus = 'Ordered' | 'Received';
export type PurchaseOrder = {
  id: string;
  supplier: string;
  date: string;
  expected: string;
  status: PoStatus;
  lines: PoLine[];
  total: number;
};

export const initialPurchaseOrders: PurchaseOrder[] = [
  { id: 'PO-1046', supplier: 'Fizzo Beverages', date: '2024-05-14', expected: '2024-05-16', status: 'Ordered', lines: [], total: 6200 },
  { id: 'PO-1045', supplier: 'Nandini Dairy Co-op', date: '2024-05-14', expected: '2024-05-14', status: 'Received', lines: [], total: 18400 },
  { id: 'PO-1044', supplier: 'Bake House', date: '2024-05-13', expected: '2024-05-13', status: 'Received', lines: [], total: 3200 },
  { id: 'PO-1043', supplier: 'Fizzo Beverages', date: '2024-05-09', expected: '2024-05-09', status: 'Received', lines: [], total: 9400 },
  { id: 'PO-1042', supplier: 'Sri Balaji Traders', date: '2024-05-02', expected: '2024-05-03', status: 'Received', lines: [], total: 42750 },
];

export const paymentMethods: PaymentMethod[] = ['Bank transfer', 'UPI', 'Cash', 'Cheque'];

export type DueState = 'overdue' | 'soon' | 'upcoming' | 'settled';

/** Payment state of a supplier relative to TODAY ("soon" = within 3 days). */
export const dueState = (s: Supplier): DueState => {
  if (s.due <= 0 || !s.dueDate) return 'settled';
  const d = daysFromToday(s.dueDate);
  if (d < 0) return 'overdue';
  if (d <= 3) return 'soon';
  return 'upcoming';
};

export const dueLabel = (s: Supplier) => {
  if (s.due <= 0 || !s.dueDate) return 'Settled';
  const d = daysFromToday(s.dueDate);
  if (d < 0) return `Overdue by ${-d} day${d === -1 ? '' : 's'}`;
  if (d === 0) return 'Due today';
  if (d === 1) return 'Due tomorrow';
  return `Due ${fmtDate(s.dueDate)} (in ${d} days)`;
};
