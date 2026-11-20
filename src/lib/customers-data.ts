/**
 * Mock customer data: profiles, loyalty and the khata (store credit) ledger.
 * Today's bills come from sales-data so the Sales and Customers pages agree.
 * Replace with API calls (e.g. TanStack Query hooks) once a backend exists.
 */
import { todaysBills, type Bill, type PayMethod } from '@/lib/sales-data';
import { TODAY, daysFromToday, fmtDate, slug } from '@/lib/suppliers-data';

export { TODAY, daysFromToday, fmtDate, slug };

export type LedgerKind = 'credit' | 'payment';
export type LedgerEntry = { date: string; kind: LedgerKind; amount: number; method?: PayMethod; ref: string };

export type Customer = {
  id: string;
  name: string;
  phone: string;
  email: string;
  area: string;
  since: string;
  /** Visits and spend over the last 90 days, excluding today. */
  visits90: number;
  spend90: number;
  lastVisit: string | null;
  points: number;
  creditLimit: number;
  /** Khata balance the customer owes the store. */
  balance: number;
  /** Date of the oldest unpaid credit purchase. */
  balanceSince: string | null;
  ledger: LedgerEntry[];
  notes: string;
};

type Seed = Omit<Customer, 'id'>;

const seeds: Seed[] = [
  {
    name: 'Lakshmi R',
    phone: '+91 98401 22334',
    email: 'lakshmi.r@example.com',
    area: 'Anna Nagar West',
    since: '2019-06-02',
    visits90: 46,
    spend90: 28400,
    lastVisit: '2024-05-13',
    points: 1240,
    creditLimit: 5000,
    balance: 1850,
    balanceSince: '2024-05-06',
    ledger: [
      { date: '2024-05-10', kind: 'credit', amount: 620, ref: 'Bill #4702' },
      { date: '2024-05-08', kind: 'payment', amount: 1500, method: 'UPI', ref: 'UPI/882104' },
      { date: '2024-05-06', kind: 'credit', amount: 1230, ref: 'Bill #4611' },
    ],
    notes: 'Prefers Nandini milk delivered before 7 AM.',
  },
  {
    name: 'Mohan V',
    phone: '+91 98842 55120',
    email: '',
    area: 'Shenoy Nagar',
    since: '2020-11-15',
    visits90: 31,
    spend90: 17650,
    lastVisit: '2024-05-12',
    points: 690,
    creditLimit: 3000,
    balance: 3420,
    balanceSince: '2024-04-18',
    ledger: [
      { date: '2024-05-02', kind: 'credit', amount: 1180, ref: 'Bill #4488' },
      { date: '2024-04-26', kind: 'credit', amount: 940, ref: 'Bill #4371' },
      { date: '2024-04-18', kind: 'credit', amount: 1300, ref: 'Bill #4250' },
    ],
    notes: '',
  },
  {
    name: 'Fathima N',
    phone: '+91 99401 87766',
    email: 'fathima.n@example.com',
    area: 'Anna Nagar East',
    since: '2021-03-08',
    visits90: 38,
    spend90: 21900,
    lastVisit: '2024-05-14',
    points: 910,
    creditLimit: 4000,
    balance: 0,
    balanceSince: null,
    ledger: [
      { date: '2024-05-04', kind: 'payment', amount: 2100, method: 'Cash', ref: 'Receipt 1182' },
      { date: '2024-04-27', kind: 'credit', amount: 2100, ref: 'Bill #4390' },
    ],
    notes: 'Orders bulk rice and dal at the start of each month.',
  },
  {
    name: 'Ravi Teja',
    phone: '+91 90031 44558',
    email: '',
    area: 'Aminjikarai',
    since: '2023-01-20',
    visits90: 22,
    spend90: 7350,
    lastVisit: '2024-05-11',
    points: 260,
    creditLimit: 0,
    balance: 0,
    balanceSince: null,
    ledger: [],
    notes: '',
  },
  {
    name: 'Deepa M',
    phone: '+91 98409 66231',
    email: 'deepa.m@example.com',
    area: 'Kilpauk',
    since: '2018-08-30',
    visits90: 52,
    spend90: 34200,
    lastVisit: '2024-05-14',
    points: 1580,
    creditLimit: 8000,
    balance: 2640,
    balanceSince: '2024-05-09',
    ledger: [
      { date: '2024-05-12', kind: 'credit', amount: 1420, ref: 'Bill #4760' },
      { date: '2024-05-09', kind: 'credit', amount: 1220, ref: 'Bill #4655' },
      { date: '2024-05-01', kind: 'payment', amount: 3800, method: 'UPI', ref: 'UPI/870033' },
    ],
    notes: 'Runs a tiffin centre; buys oil and atta in bulk.',
  },
  {
    name: 'Suresh Babu',
    phone: '+91 97910 33402',
    email: '',
    area: 'Anna Nagar West',
    since: '2022-07-11',
    visits90: 9,
    spend90: 3120,
    lastVisit: '2024-04-02',
    points: 140,
    creditLimit: 2000,
    balance: 1260,
    balanceSince: '2024-03-28',
    ledger: [
      { date: '2024-04-02', kind: 'credit', amount: 560, ref: 'Bill #3988' },
      { date: '2024-03-28', kind: 'credit', amount: 700, ref: 'Bill #3901' },
    ],
    notes: '',
  },
  {
    name: 'Anitha Joseph',
    phone: '+91 98403 71190',
    email: 'anitha.j@example.com',
    area: 'Thirumangalam',
    since: '2023-09-04',
    visits90: 18,
    spend90: 8900,
    lastVisit: '2024-05-10',
    points: 320,
    creditLimit: 0,
    balance: 0,
    balanceSince: null,
    ledger: [],
    notes: '',
  },
  {
    name: 'Karthik S',
    phone: '+91 95000 18277',
    email: '',
    area: 'Shenoy Nagar',
    since: '2024-02-14',
    visits90: 6,
    spend90: 1980,
    lastVisit: '2024-03-30',
    points: 60,
    creditLimit: 0,
    balance: 0,
    balanceSince: null,
    ledger: [],
    notes: '',
  },
  {
    name: 'Meena Iyer',
    phone: '+91 98848 20915',
    email: 'meena.iyer@example.com',
    area: 'Anna Nagar East',
    since: '2017-12-01',
    visits90: 40,
    spend90: 19800,
    lastVisit: '2024-05-13',
    points: 1020,
    creditLimit: 5000,
    balance: 780,
    balanceSince: '2024-05-13',
    ledger: [{ date: '2024-05-13', kind: 'credit', amount: 780, ref: 'Bill #4788' }],
    notes: 'Vegetarian household; ask before suggesting egg offers.',
  },
  {
    name: 'Abdul Rahman',
    phone: '+91 99620 40381',
    email: '',
    area: 'Kilpauk',
    since: '2021-05-19',
    visits90: 14,
    spend90: 6400,
    lastVisit: '2024-04-20',
    points: 210,
    creditLimit: 2500,
    balance: 0,
    balanceSince: null,
    ledger: [{ date: '2024-04-20', kind: 'payment', amount: 950, method: 'Cash', ref: 'Receipt 1109' }],
    notes: '',
  },
];

/** Bills from today's register, grouped by customer name ("Walk-in" excluded). */
export const billsByCustomer = todaysBills.reduce<Record<string, Bill[]>>((acc, b) => {
  if (b.customer !== 'Walk-in') (acc[b.customer] ??= []).push(b);
  return acc;
}, {});

export const initialCustomers: Customer[] = seeds.map((s) => ({
  ...s,
  id: slug(s.name),
  lastVisit: billsByCustomer[s.name]?.length ? TODAY : s.lastVisit,
}));

/** 1 loyalty point per ₹100 spent; 100 points = ₹10 off. */
export const POINTS_PER_RUPEE = 1 / 100;
export const POINT_VALUE = 0.1;

export type Tier = 'Gold' | 'Silver' | 'Regular';
export const tierOf = (c: Customer): Tier => (c.spend90 >= 20000 ? 'Gold' : c.spend90 >= 8000 ? 'Silver' : 'Regular');

/** A khata balance becomes overdue 15 days after the oldest unpaid purchase. */
export const CREDIT_GRACE_DAYS = 15;

export type CreditState = 'none' | 'ok' | 'overdue' | 'over-limit';
export const creditState = (c: Customer): CreditState => {
  if (c.balance <= 0) return 'none';
  if (c.creditLimit > 0 && c.balance > c.creditLimit) return 'over-limit';
  if (c.balanceSince && -daysFromToday(c.balanceSince) > CREDIT_GRACE_DAYS) return 'overdue';
  return 'ok';
};

/** Days since the last visit, or Infinity if never. */
export const daysSinceVisit = (c: Customer) => (c.lastVisit ? -daysFromToday(c.lastVisit) : Infinity);
export const LAPSED_AFTER_DAYS = 30;
export const isLapsed = (c: Customer) => daysSinceVisit(c) > LAPSED_AFTER_DAYS;

export const lastVisitLabel = (c: Customer) => {
  const d = daysSinceVisit(c);
  if (d === Infinity) return 'No visits yet';
  if (d === 0) return 'Visited today';
  if (d === 1) return 'Visited yesterday';
  return `Last visit ${fmtDate(c.lastVisit!)} (${d} days ago)`;
};

export const creditLabel = (c: Customer) => {
  if (c.balance <= 0) return 'No dues';
  const days = c.balanceSince ? -daysFromToday(c.balanceSince) : 0;
  const since = days === 0 ? 'since today' : `for ${days} day${days === 1 ? '' : 's'}`;
  if (creditState(c) === 'over-limit') return `Over limit · owed ${since}`;
  return `Owed ${since}`;
};

/** Digits-only phone with country code, for tel: and WhatsApp links. */
export const dialable = (phone: string) => {
  const d = phone.replace(/\D/g, '');
  return d.length === 10 ? `91${d}` : d;
};
