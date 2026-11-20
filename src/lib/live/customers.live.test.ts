/**
 * The Customers and Orders screens on the live API: the same functions the screens call
 * (src/lib/live/customers.ts). Needs a running API (see vitest.config.mts).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { API_URL, enableNativeTokens } from '@/lib/api/client';
import { liveSignIn } from './session';
import { saveProduct, sellLive } from './actions';
import { answerOpeningFloat, onOpeningFloatRequest } from './ask';
import { reload } from './hydrate';
import { getBranches } from '@/lib/branch-data';
import {
  advanceOrder,
  createCustomer,
  loadCustomers,
  loadLedger,
  loadOrderForBilling,
  loadOrders,
  placeOrder,
  receivePayment,
  serverIdOf,
  updateCustomer,
} from './customers';

const PASSWORD = 'correct-horse-battery';
const email = `cust-${Date.now()}@example.test`;

describe('Customers and orders screens on the live API', () => {
  let customerId = '';

  beforeAll(async () => {
    enableNativeTokens();
    const res = await fetch(`${API_URL}/tenants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client': 'native' },
      body: JSON.stringify({
        business: { displayName: 'Customer Screen Mart', businessType: 'supermarket', registration: 'UNREGISTERED', stateCode: '33', address: { line1: '1 Main Road', city: 'Chennai', pincode: '600001' } },
        owner: { name: 'Owner', email, password: PASSWORD },
        hq: { code: 'CSM' },
      }),
    });
    expect(res.status).toBe(201);
    expect((await liveSignIn(email, PASSWORD)).ok).toBe(true);
    await saveProduct({ name: 'Toor Dal 1kg', category: 'Staples', supplier: '', price: 159, cost: 130, stock: 20 }, null);
  });

  it('customers: add, edit, list with their figures', async () => {
    const c = await createCustomer({ name: 'Lakshmi R', phone: '+91 98401 22334', email: '', area: 'Anna Nagar West', creditLimit: 5000, notes: 'Milk before 7 AM' });
    customerId = c.id;
    expect(c).toMatchObject({ name: 'Lakshmi R', area: 'Anna Nagar West', creditLimit: 5000, balance: 0, points: 0 });
    await updateCustomer(c.id, { name: 'Lakshmi R', phone: '+91 98401 22334', email: 'lakshmi@example.com', area: 'Anna Nagar', creditLimit: 6000, notes: '' });
    const list = await loadCustomers();
    expect(list.find((x) => x.id === c.id)).toMatchObject({ email: 'lakshmi@example.com', area: 'Anna Nagar', creditLimit: 6000, notes: '', visits90: 0 });
  });

  it('orders: place one for the customer, move it through to delivered', async () => {
    const o = await placeOrder({
      customerId,
      customer: 'Lakshmi R',
      phone: '+91 98401 22334',
      address: 'Anna Nagar',
      channel: 'WhatsApp',
      fulfilment: 'Delivery',
      slot: '18:00–19:00',
      lines: [{ name: 'Toor Dal 1kg', price: 159, qty: 3 }],
      deliveryFee: 30,
      payment: 'Cash on delivery',
      notes: '',
    });
    expect(o).toMatchObject({ id: 'ORD-00001', status: 'new', paid: false, deliveryFee: 30, lines: [{ name: 'Toor Dal 1kg', qty: 3 }] });
    await advanceOrder(o.id, 'packing');
    await advanceOrder(o.id, 'ready');
    const out = await advanceOrder(o.id, 'dispatched', { rider: 'Murugan' });
    expect(out).toMatchObject({ status: 'dispatched', rider: 'Murugan' });
    const done = await advanceOrder(o.id, 'completed', { collectedBy: 'Cash' });
    expect(done).toMatchObject({ status: 'completed', paid: true, collectedBy: 'Cash' });
    expect(done.history.map((h) => h.status)).toEqual(['new', 'packing', 'ready', 'dispatched', 'completed']);
    expect((await loadOrders()).map((x) => x.id)).toEqual(['ORD-00001']);
    expect((await loadOrders(customerId)).map((x) => x.id)).toEqual(['ORD-00001']);
    await expect(advanceOrder(o.id, 'cancelled', { note: 'too late' })).rejects.toThrow(/completed/);
  });

  it('an order billed at the POS: invoice on the order, stock out, can’t be billed twice', async () => {
    onOpeningFloatRequest(() => queueMicrotask(() => answerOpeningFloat(500)));
    const o = await placeOrder({
      customerId,
      customer: 'Lakshmi R',
      phone: '+91 98401 22334',
      address: 'Store pickup',
      channel: 'Phone',
      fulfilment: 'Pickup',
      slot: '19:00–20:00',
      lines: [{ name: 'Toor Dal 1kg', price: 159, qty: 2 }],
      deliveryFee: 0,
      payment: 'Prepaid UPI',
      notes: '',
    });
    const forPos = await loadOrderForBilling(serverIdOf(o.id)!);
    expect(forPos).toMatchObject({ number: o.id, open: true, billed: null, items: [expect.objectContaining({ qty: 2 })] });
    const sku = forPos.items[0]!.sku;
    const before = getBranches().stock[getBranches().currentId]?.[sku] ?? 0;
    const sale = await sellLive({
      storeId: getBranches().currentId,
      lines: [{ key: 'l1', sku, name: 'Toor Dal 1kg', price: 159, qty: 2, discount: null }],
      billDiscount: null,
      buyer: { name: 'Lakshmi R', phone: '+91 98401 22334', gstin: '' },
      payments: [{ method: 'UPI', amount: 318, ref: 'UTR42' }],
      payable: 318,
      customerOrderId: forPos.serverId,
      customerId,
    });
    const billed = (await loadOrders()).find((x) => x.id === o.id)!;
    expect(billed.bill).toMatchObject({ invoiceNo: sale.invoiceNo });
    expect(await loadOrderForBilling(forPos.serverId)).toMatchObject({ billed: sale.invoiceNo });
    await reload();
    expect(getBranches().stock[getBranches().currentId]?.[sku]).toBe(before - 2);
    await expect(
      sellLive({
        storeId: getBranches().currentId,
        lines: [{ key: 'l1', sku, name: 'Toor Dal 1kg', price: 159, qty: 2, discount: null }],
        billDiscount: null,
        buyer: null,
        payments: [{ method: 'Cash', amount: 318 }],
        payable: 318,
        customerOrderId: forPos.serverId,
      }),
    ).rejects.toThrow(/already been billed/);
    // Picked up: no payment to collect, it was paid at the POS.
    await advanceOrder(o.id, 'packing');
    await advanceOrder(o.id, 'ready');
    expect(await advanceOrder(o.id, 'completed')).toMatchObject({ status: 'completed', paid: true });
  });

  it('khata: a payment lowers the balance and shows on the statement', async () => {
    const owing = await createCustomer({ name: 'Mohan V', phone: '+91 98842 55120', email: '', area: '', creditLimit: 3000, notes: '' });
    // No credit yet: nothing to collect, and the statement is empty.
    expect(await loadLedger(owing.id)).toEqual([]);
    const paid = await receivePayment(owing.id, 200, 'UPI', 'UTR123');
    expect(paid).toMatchObject({ number: 'RCPT-00001', balanceAfter: '-200.00' });
    const ledger = await loadLedger(owing.id);
    expect(ledger).toEqual([expect.objectContaining({ kind: 'payment', amount: 200, ref: 'RCPT-00001' })]);
  });
});
