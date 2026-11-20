/**
 * Customer orders (phone / WhatsApp orders for home delivery or store pickup).
 * Counter bills live in sales-data; purchase orders to suppliers live in suppliers-data.
 *
 * Demo mode shows sample orders. Connected to a backend, the screen starts empty: orders aren't
 * stored on the server yet, so the samples (which name demo products and customers) don't apply.
 */
import { apiConfigured } from '@/lib/api/client';
import { products } from '@/lib/store-data';
import { initialCustomers } from '@/lib/customers-data';

/**
 * "Now" as HH:MM: the real time (in the shop's time zone) when connected; the demo's fixed
 * 10:45 otherwise (just after its latest counter bill at 10:42).
 */
export const nowHHMM = () =>
  apiConfigured
    ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
    : '10:45';

export type Channel = 'WhatsApp' | 'Phone' | 'In store';
export type Fulfilment = 'Delivery' | 'Pickup';
export type OrderStatus = 'new' | 'packing' | 'ready' | 'dispatched' | 'completed' | 'cancelled';
export type OrderPayment = 'Prepaid UPI' | 'Cash on delivery' | 'Khata';
export type CollectMethod = 'Cash' | 'UPI';

export type OrderLine = { name: string; price: number; qty: number };
export type OrderEvent = { status: OrderStatus; time: string; note?: string };

export type Order = {
  id: string;
  /** Customer id from customers-data, or null for someone not yet saved. */
  customerId: string | null;
  customer: string;
  phone: string;
  address: string;
  channel: Channel;
  fulfilment: Fulfilment;
  /** Hour slot like "11:00–12:00". */
  slot: string;
  lines: OrderLine[];
  deliveryFee: number;
  payment: OrderPayment;
  /** Prepaid and khata orders are settled at placement; COD when collected. */
  paid: boolean;
  collectedBy?: CollectMethod;
  status: OrderStatus;
  rider: string | null;
  notes: string;
  history: OrderEvent[];
  /** Connected: the POS bill made for it (stock out, invoice, payment). */
  bill?: { saleId: string; invoiceNo: string } | null;
};

export const riders = ['Murugan', 'Ganesh'];
export const channels: Channel[] = ['WhatsApp', 'Phone', 'In store'];
export const orderPayments: OrderPayment[] = ['Cash on delivery', 'Prepaid UPI', 'Khata'];

/** Delivery is free from ₹500; below that a flat ₹30. */
export const FREE_DELIVERY_FROM = 500;
export const DELIVERY_FEE = 30;
export const deliveryFeeFor = (fulfilment: Fulfilment, subtotal: number) =>
  fulfilment === 'Delivery' && subtotal > 0 && subtotal < FREE_DELIVERY_FROM ? DELIVERY_FEE : 0;

export const slots = Array.from({ length: 13 }, (_, i) => {
  const h = 8 + i;
  return `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`;
});

export const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const slotEnd = (slot: string) => toMin(slot.split('–')[1] ?? '23:59');
const slotStart = (slot: string) => toMin(slot.split('–')[0] ?? '00:00');

/** Slots that have not ended yet, for new orders. */
export const openSlots = () => slots.filter((s) => slotEnd(s) > toMin(nowHHMM()));

export const subtotal = (o: Pick<Order, 'lines'>) => o.lines.reduce((s, l) => s + l.price * l.qty, 0);
export const orderTotal = (o: Order) => subtotal(o) + o.deliveryFee;
export const itemCount = (o: Pick<Order, 'lines'>) => o.lines.reduce((s, l) => s + l.qty, 0);

export const isOpen = (o: Order) => o.status !== 'completed' && o.status !== 'cancelled';

export type Urgency = 'late' | 'soon' | 'later' | 'done';
/** Late = slot already ended; soon = slot ends within the hour. */
export const urgencyOf = (o: Order): Urgency => {
  if (!isOpen(o)) return 'done';
  const left = slotEnd(o.slot) - toMin(nowHHMM());
  if (left < 0) return 'late';
  if (left <= 60 || slotStart(o.slot) <= toMin(nowHHMM())) return 'soon';
  return 'later';
};

/** The board columns, in order. */
export const boardStatuses = ['new', 'packing', 'ready', 'dispatched'] as const;

export const statusLabel: Record<OrderStatus, string> = {
  new: 'New',
  packing: 'Packing',
  ready: 'Ready',
  dispatched: 'Out for delivery',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** Next step for an open order, or null if it is finished. */
export const nextStep = (o: Order): { to: OrderStatus; label: string } | null => {
  switch (o.status) {
    case 'new':
      return { to: 'packing', label: 'Start packing' };
    case 'packing':
      return { to: 'ready', label: 'Mark ready' };
    case 'ready':
      return o.fulfilment === 'Delivery'
        ? { to: 'dispatched', label: 'Dispatch' }
        : { to: 'completed', label: 'Mark picked up' };
    case 'dispatched':
      return { to: 'completed', label: 'Mark delivered' };
    default:
      return null;
  }
};

/* ---------- seed orders ---------- */

const price = (name: string) => {
  const p = products.find((x) => x.name === name);
  if (!p) throw new Error(`Unknown product in orders seed: ${name}`);
  return p.price;
};
const L = (name: string, qty: number): OrderLine => ({ name, price: price(name), qty });

const cust = (name: string) => {
  const c = initialCustomers.find((x) => x.name === name);
  if (!c) throw new Error(`Unknown customer in orders seed: ${name}`);
  return { customerId: c.id, customer: c.name, phone: c.phone };
};

type Seed = Omit<Order, 'deliveryFee' | 'paid'> & { paid?: boolean };

/** Built only in demo mode: it looks up the demo products and customers by name. */
const seedOrders = (): Seed[] => [
  {
    id: 'ORD-2059',
    ...cust('Abdul Rahman'),
    address: 'Store pickup',
    channel: 'Phone',
    fulfilment: 'Pickup',
    slot: '17:00–18:00',
    lines: [L('Toor Dal 1kg', 2), L('Gehu Gold Atta 5kg', 1), L('Sudha Detergent 1kg', 1)],
    payment: 'Cash on delivery',
    status: 'new',
    rider: null,
    notes: '',
    history: [{ status: 'new', time: '10:38' }],
  },
  {
    id: 'ORD-2058',
    customerId: null,
    customer: 'Priya Venkat',
    phone: '+91 98407 55210',
    address: '14, 3rd Avenue, Anna Nagar East',
    channel: 'WhatsApp',
    fulfilment: 'Delivery',
    slot: '12:00–13:00',
    lines: [L('Nandini Milk 1L', 2), L('Bake House Bread', 1), L('Eggs Tray 30', 1)],
    payment: 'Cash on delivery',
    status: 'new',
    rider: null,
    notes: 'First order. Call on arrival.',
    history: [{ status: 'new', time: '10:31' }],
  },
  {
    id: 'ORD-2057',
    ...cust('Mohan V'),
    address: '7/2, Shenoy Nagar Main Rd',
    channel: 'Phone',
    fulfilment: 'Delivery',
    slot: '11:00–12:00',
    lines: [L('Sagar Rice Ponni 10kg', 1), L('Kavya Sunflower Oil 1L', 2)],
    payment: 'Khata',
    status: 'new',
    rider: null,
    notes: '',
    history: [{ status: 'new', time: '10:22' }],
  },
  {
    id: 'ORD-2056',
    ...cust('Anitha Joseph'),
    address: 'Store pickup',
    channel: 'WhatsApp',
    fulfilment: 'Pickup',
    slot: '11:00–12:00',
    lines: [L('Paneer Fresh 200g', 2), L('Nandini Curd 400g', 2), L('Crunchee Marie 250g', 3)],
    payment: 'Prepaid UPI',
    status: 'packing',
    rider: null,
    notes: '',
    history: [
      { status: 'new', time: '10:05' },
      { status: 'packing', time: '10:30' },
    ],
  },
  {
    id: 'ORD-2055',
    ...cust('Suresh Babu'),
    address: '22, 2nd St, Anna Nagar West',
    channel: 'Phone',
    fulfilment: 'Delivery',
    slot: '10:00–11:00',
    lines: [L('Nandini Milk 1L', 3), L('Fizzo Cola 750ml', 2), L('Toor Dal 1kg', 1)],
    payment: 'Cash on delivery',
    status: 'packing',
    rider: null,
    notes: '',
    history: [
      { status: 'new', time: '09:20' },
      { status: 'packing', time: '10:15' },
    ],
  },
  {
    id: 'ORD-2054',
    ...cust('Lakshmi R'),
    address: 'B-4, Ganga Apartments, Anna Nagar West',
    channel: 'WhatsApp',
    fulfilment: 'Delivery',
    slot: '11:00–12:00',
    lines: [L('Gehu Gold Atta 5kg', 1), L('Nandini Milk 1L', 4), L('Nandini Curd 400g', 2), L('Bake House Bread', 1)],
    payment: 'Cash on delivery',
    status: 'ready',
    rider: null,
    notes: 'Leave with the watchman if no answer.',
    history: [
      { status: 'new', time: '09:02' },
      { status: 'packing', time: '09:40' },
      { status: 'ready', time: '10:10' },
    ],
  },
  {
    id: 'ORD-2053',
    ...cust('Karthik S'),
    address: '3, Pulla Avenue, Shenoy Nagar',
    channel: 'Phone',
    fulfilment: 'Delivery',
    slot: '09:00–10:00',
    lines: [L('Eggs Tray 30', 1), L('Bake House Bread', 2)],
    payment: 'Prepaid UPI',
    status: 'ready',
    rider: null,
    notes: '',
    history: [
      { status: 'new', time: '08:35' },
      { status: 'packing', time: '09:05' },
      { status: 'ready', time: '09:25' },
    ],
  },
  {
    id: 'ORD-2052',
    ...cust('Deepa M'),
    address: '41, Ormes Rd, Kilpauk',
    channel: 'WhatsApp',
    fulfilment: 'Delivery',
    slot: '10:00–11:00',
    lines: [L('Kavya Sunflower Oil 1L', 1), L('Gehu Gold Atta 5kg', 2), L('Toor Dal 1kg', 2)],
    payment: 'Khata',
    status: 'dispatched',
    rider: 'Murugan',
    notes: 'Tiffin centre — deliver to the back entrance.',
    history: [
      { status: 'new', time: '08:50' },
      { status: 'packing', time: '09:15' },
      { status: 'ready', time: '09:50' },
      { status: 'dispatched', time: '10:20', note: 'Rider: Murugan' },
    ],
  },
  {
    id: 'ORD-2051',
    ...cust('Ravi Teja'),
    address: '9, Aminjikarai Market Rd',
    channel: 'Phone',
    fulfilment: 'Delivery',
    slot: '09:00–10:00',
    lines: [L('Fizzo Cola 750ml', 6), L('Crunchee Marie 250g', 2)],
    payment: 'Cash on delivery',
    status: 'cancelled',
    rider: null,
    notes: '',
    history: [
      { status: 'new', time: '08:20' },
      { status: 'cancelled', time: '08:45', note: 'Customer cancelled — buying in store instead' },
    ],
  },
  {
    id: 'ORD-2050',
    ...cust('Meena Iyer'),
    address: 'Store pickup',
    channel: 'In store',
    fulfilment: 'Pickup',
    slot: '08:00–09:00',
    lines: [L('Paneer Fresh 200g', 1), L('Nandini Milk 1L', 2), L('Sudha Detergent 1kg', 1)],
    payment: 'Cash on delivery',
    paid: true,
    collectedBy: 'UPI',
    status: 'completed',
    rider: null,
    notes: '',
    history: [
      { status: 'new', time: '07:40' },
      { status: 'packing', time: '07:55' },
      { status: 'ready', time: '08:10' },
      { status: 'completed', time: '08:32', note: 'Collected ₹317 by UPI' },
    ],
  },
  {
    id: 'ORD-2049',
    ...cust('Fathima N'),
    address: '18, 6th Main Rd, Anna Nagar East',
    channel: 'WhatsApp',
    fulfilment: 'Delivery',
    slot: '08:00–09:00',
    lines: [L('Sagar Rice Ponni 10kg', 1), L('Toor Dal 1kg', 2), L('Kavya Sunflower Oil 1L', 1)],
    payment: 'Prepaid UPI',
    status: 'completed',
    rider: 'Ganesh',
    notes: '',
    history: [
      { status: 'new', time: '07:15' },
      { status: 'packing', time: '07:35' },
      { status: 'ready', time: '07:58' },
      { status: 'dispatched', time: '08:05', note: 'Rider: Ganesh' },
      { status: 'completed', time: '08:40' },
    ],
  },
];

export const initialOrders: Order[] = (apiConfigured ? [] : seedOrders()).map((s) => ({
  ...s,
  deliveryFee: deliveryFeeFor(s.fulfilment, subtotal(s)),
  paid: s.paid ?? s.payment !== 'Cash on delivery',
}));

export const ordersForCustomer = (customerId: string) => initialOrders.filter((o) => o.customerId === customerId);
