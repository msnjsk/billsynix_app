/**
 * Customers and delivery/pickup orders against the API (connected mode), mapped to the shapes the
 * Customers and Orders screens already use (customers-data, orders-data).
 *
 *  - Customers: `/customers` (+ visits and spend over 90 days, since when they owe), the account
 *    statement `/customers/:id/ledger`, payments `/customers/:id/receipts`.
 *  - Orders: `/customer-orders`. The screen shows an order's number (ORD-00001) as its id; the
 *    server id is kept here to act on it.
 *
 * Loyalty points aren't kept by the server yet, so connected customers show none.
 */
import { api, newKey } from '@/lib/api/client';
import type { Customer, LedgerEntry } from '@/lib/customers-data';
import type { CollectMethod, Order, OrderPayment, OrderStatus } from '@/lib/orders-data';
import type { PayMethod } from '@/lib/sales-data';
import { currentStoreId, live } from './hydrate';

const num = (s: string | number | null | undefined) => Number(s ?? 0);

/* ---------- customers ---------- */

type ApiCustomer = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  addressLine1: string | null;
  city: string | null;
  creditLimit: string;
  balance: string;
  notes: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  visits90: number;
  spend90: string;
  lastVisit: string | null;
  owingSince: string | null;
};

const toCustomer = (c: ApiCustomer): Customer => ({
  id: c.id,
  name: c.name,
  phone: c.phone ?? '',
  email: c.email ?? '',
  area: c.addressLine1 ?? c.city ?? '',
  since: c.createdAt.slice(0, 10),
  visits90: c.visits90,
  spend90: num(c.spend90),
  lastVisit: c.lastVisit,
  points: 0,
  creditLimit: num(c.creditLimit),
  balance: num(c.balance),
  balanceSince: c.owingSince,
  ledger: [],
  notes: c.notes ?? '',
});

export async function loadCustomers(): Promise<Customer[]> {
  const out: Customer[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await api<{ data: ApiCustomer[]; meta: { total: number } }>('GET', '/customers', {
      query: { status: 'ACTIVE', page, pageSize: 200 },
    });
    out.push(...r.data.map(toCustomer));
    if (out.length >= r.meta.total || !r.data.length) break;
  }
  return out;
}

const TXN_LABEL: Record<string, string> = {
  SALE: '',
  OPENING: 'Opening balance',
  RECEIPT: '',
  RETURN: 'Returned goods',
  VOID: 'Bill cancelled',
};

/** The account statement, newest first. */
export async function loadLedger(customerId: string): Promise<LedgerEntry[]> {
  const r = await api<{ data: { date: string; type: string; amount: string; refNo: string }[] }>(
    'GET',
    `/customers/${customerId}/ledger`,
  );
  return r.data.map((t) => ({
    date: t.date,
    kind: num(t.amount) > 0 ? 'credit' : 'payment',
    amount: Math.abs(num(t.amount)),
    ref: [TXN_LABEL[t.type], t.refNo].filter(Boolean).join(' · '),
  }));
}

export type CustomerValues = { name: string; phone: string; email: string; area: string; creditLimit: number; notes: string };

export async function createCustomer(v: CustomerValues): Promise<Customer> {
  const c = await api<ApiCustomer>('POST', '/customers', {
    body: {
      name: v.name,
      phone: v.phone,
      ...(v.email ? { email: v.email } : {}),
      ...(v.area ? { addressLine1: v.area } : {}),
      creditLimit: v.creditLimit.toFixed(2),
      ...(v.notes ? { notes: v.notes } : {}),
    },
  });
  return toCustomer({ ...c, visits90: 0, spend90: '0', lastVisit: null, owingSince: null });
}

export async function updateCustomer(id: string, v: CustomerValues) {
  await api('PATCH', `/customers/${id}`, {
    body: {
      name: v.name,
      phone: v.phone,
      email: v.email || null,
      addressLine1: v.area || null,
      creditLimit: v.creditLimit.toFixed(2),
      notes: v.notes || null,
    },
  });
}

const TENDER = { Cash: 'CASH', UPI: 'UPI', Card: 'CARD' } as const;

/** The customer paid towards their khata (cash goes into your open drawer, if any). */
export async function receivePayment(id: string, amount: number, method: PayMethod, ref: string) {
  return api<{ number: string; balanceAfter: string }>('POST', `/customers/${id}/receipts`, {
    idempotencyKey: newKey(),
    body: {
      amount: amount.toFixed(2),
      method: TENDER[method],
      ...(ref ? { reference: ref } : {}),
      storeId: currentStoreId(),
    },
  });
}

/* ---------- orders ---------- */

type ApiOrder = {
  id: string;
  number: string;
  customerId: string | null;
  customerName: string;
  phone: string;
  address: string;
  channel: string;
  fulfilment: 'DELIVERY' | 'PICKUP';
  slot: string;
  payment: 'CASH_ON_DELIVERY' | 'PREPAID_UPI' | 'KHATA';
  paid: boolean;
  collectedBy: string | null;
  rider: string | null;
  deliveryFee: string;
  notes: string | null;
  status: 'NEW' | 'PACKING' | 'READY' | 'DISPATCHED' | 'COMPLETED' | 'CANCELLED';
  history: { status: ApiOrder['status']; at: string; note?: string }[];
  sale: { id: string; invoiceNo: string; status: string } | null;
  items: { productId: string; sku: string; name: string; price: string; qty: number }[];
};

const PAYMENT: Record<ApiOrder['payment'], OrderPayment> = {
  CASH_ON_DELIVERY: 'Cash on delivery',
  PREPAID_UPI: 'Prepaid UPI',
  KHATA: 'Khata',
};
const PAYMENT_API = Object.fromEntries(Object.entries(PAYMENT).map(([k, v]) => [v, k])) as Record<OrderPayment, ApiOrder['payment']>;

/** Server id of each order shown (the screen keys orders by number). */
const serverIds = new Map<string, string>();

const hhmm = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

const toOrder = (o: ApiOrder): Order => {
  serverIds.set(o.number, o.id);
  return {
    id: o.number,
    customerId: o.customerId,
    customer: o.customerName,
    phone: o.phone,
    address: o.address,
    channel: o.channel as Order['channel'],
    fulfilment: o.fulfilment === 'DELIVERY' ? 'Delivery' : 'Pickup',
    slot: o.slot,
    lines: o.items.map((i) => ({ name: i.name, price: num(i.price), qty: i.qty })),
    deliveryFee: num(o.deliveryFee),
    payment: PAYMENT[o.payment],
    paid: o.paid,
    ...(o.collectedBy ? { collectedBy: o.collectedBy as CollectMethod } : {}),
    status: o.status.toLowerCase() as OrderStatus,
    rider: o.rider,
    notes: o.notes ?? '',
    history: o.history.map((h) => ({ status: h.status.toLowerCase() as OrderStatus, time: hhmm(h.at), ...(h.note ? { note: h.note } : {}) })),
    bill: o.sale && o.sale.status === 'COMPLETED' ? { saleId: o.sale.id, invoiceNo: o.sale.invoiceNo } : null,
  };
};

/** The server id of an order on the board (to open it at the POS). */
export const serverIdOf = (number: string) => serverIds.get(number) ?? null;

/** An order as the POS needs it to bill it. */
export async function loadOrderForBilling(id: string) {
  const o = await api<ApiOrder>('GET', `/customer-orders/${id}`);
  return {
    serverId: o.id,
    number: o.number,
    open: o.status !== 'COMPLETED' && o.status !== 'CANCELLED',
    billed: o.sale && o.sale.status === 'COMPLETED' ? o.sale.invoiceNo : null,
    customerId: o.customerId,
    customer: o.customerName,
    phone: o.phone,
    items: o.items.map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, price: num(i.price) })),
    deliveryFee: num(o.deliveryFee),
  };
}

/** Open orders and today's closed ones, at the current branch. */
export async function loadOrders(customerId?: string): Promise<Order[]> {
  const r = await api<{ data: ApiOrder[] }>('GET', '/customer-orders', {
    query: customerId ? { customerId } : { storeId: currentStoreId() },
  });
  return r.data.map(toOrder);
}

export type NewOrder = Omit<Order, 'id' | 'status' | 'rider' | 'paid' | 'history' | 'collectedBy'>;

export async function placeOrder(v: NewOrder): Promise<Order> {
  const byName = new Map([...live.products.values()].map((p) => [p.name, p.id]));
  const items = v.lines.map((l) => {
    const productId = byName.get(l.name);
    if (!productId) throw new Error(`${l.name} isn't in the catalogue any more — reload the page.`);
    return { productId, qty: l.qty, price: l.price.toFixed(2) };
  });
  const o = await api<ApiOrder>('POST', '/customer-orders', {
    body: {
      storeId: currentStoreId(),
      ...(v.customerId ? { customerId: v.customerId } : {}),
      customerName: v.customer,
      phone: v.phone,
      address: v.address,
      channel: v.channel,
      fulfilment: v.fulfilment === 'Delivery' ? 'DELIVERY' : 'PICKUP',
      slot: v.slot,
      payment: PAYMENT_API[v.payment],
      items,
      deliveryFee: v.deliveryFee.toFixed(2),
      ...(v.notes ? { notes: v.notes } : {}),
    },
  });
  return toOrder(o);
}

/** Moves an order on (packing, ready, dispatched with a rider, completed with how it was paid) or cancels it. */
export async function advanceOrder(
  number: string,
  to: OrderStatus,
  extra: { rider?: string; collectedBy?: CollectMethod; note?: string } = {},
): Promise<Order> {
  const id = serverIds.get(number);
  if (!id) throw new Error('This order is no longer on the board — reload the page.');
  const o = await api<ApiOrder>('POST', `/customer-orders/${id}/advance`, {
    body: { to: to.toUpperCase(), ...extra },
  });
  return toOrder(o);
}
