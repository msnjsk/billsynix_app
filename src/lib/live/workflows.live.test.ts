/**
 * Phase 8 exit criterion: the agreed product, inventory, purchase and sale workflows work from the
 * frontend on real backend data. Each step calls the same live-layer function the screen calls and
 * then checks what the screens' stores now show. Needs a running API (see vitest.config.mts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_URL, api, enableNativeTokens } from '@/lib/api/client';
import { getSession, signOut } from '@/lib/auth';
import { getBranches } from '@/lib/branch-data';
import { getBusinessProfile } from '@/lib/business-profile';
import { initialMovements, inventoryItems } from '@/lib/inventory-data';
import { posCatalog } from '@/lib/pos/catalog';
import { getPurchases, suppliers as uiSuppliers } from '@/lib/purchase-data';
import { kpis, ordersToday } from '@/lib/dashboard-data';
import { todaysBills } from '@/lib/sales-data';
import { TODAY } from '@/lib/suppliers-data';
import { getLiveStatus, lastSignOut, liveSignIn } from './session';
import { live } from './hydrate';
import { liveBillSales } from './dashboard';
import { answerOpeningFloat, onOpeningFloatRequest } from './ask';
import {
  changeStock,
  createPurchaseOrder,
  createSupplier,
  receiveGoods,
  recordSupplierPayment,
  refundWholeBill,
  returnLive,
  saveProduct,
  sellLive,
  sendPurchaseOrder,
} from './actions';

const PASSWORD = 'correct-horse-battery';
const email = `fe-${Date.now()}@example.test`;
const stockHere = (sku: string) => getBranches().stock[getBranches().currentId]?.[sku] ?? 0;

describe('Phase 8 — frontend workflows on the live API', () => {
  let sku = '';
  let supplierId = '';
  let invoiceNo = '';

  beforeAll(async () => {
    enableNativeTokens();
    // The opening-cash dialog: answer it as a cashier would.
    onOpeningFloatRequest(() => queueMicrotask(() => answerOpeningFloat(500)));
    const res = await fetch(`${API_URL}/tenants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client': 'native' },
      body: JSON.stringify({
        business: {
          displayName: 'Frontend Flow Mart',
          businessType: 'supermarket',
          registration: 'UNREGISTERED',
          stateCode: '33',
          address: { line1: '1 Main Road', city: 'Chennai', pincode: '600001' },
        },
        owner: { name: 'Meena Owner', email, password: PASSWORD },
        hq: { code: 'FFM' },
      }),
    });
    expect(res.status).toBe(201);
  });
  afterAll(() => vi.restoreAllMocks());

  it('signs in and loads the store into the screens', async () => {
    const r = await liveSignIn(email, PASSWORD);
    expect(r.ok).toBe(true);
    expect(getLiveStatus().state).toBe('ready');
    expect(getSession()).toMatchObject({ name: 'Meena Owner', role: 'owner' });
    expect(getBusinessProfile()).toMatchObject({ displayName: 'Frontend Flow Mart', registration: 'unregistered' });
    expect(getBranches().branches).toEqual([expect.objectContaining({ code: 'FFM', isHq: true })]);
    expect(inventoryItems).toHaveLength(0);
  });

  it('products: add with opening stock, appears in the catalogue and the POS', async () => {
    await saveProduct({ name: 'Ponni Rice 5kg', category: 'Staples', supplier: '', price: 415, cost: 360, stock: 20 }, null);
    const item = inventoryItems.find((i) => i.name === 'Ponni Rice 5kg');
    expect(item).toMatchObject({ category: 'Staples', price: 415, cost: 360, stock: 20 });
    sku = item!.sku;
    expect(posCatalog.find((p) => p.sku === sku)).toMatchObject({ price: 415, stock: 20 });
    // Edit: price and a stock correction.
    await saveProduct({ name: 'Ponni Rice 5kg', category: 'Staples', supplier: '', price: 420, cost: 360, stock: 22 }, item!);
    expect(inventoryItems.find((i) => i.sku === sku)).toMatchObject({ price: 420, stock: 22 });
  });

  it('inventory: a damaged write-off shows in stock and the activity list', async () => {
    await changeStock(sku, -2, 'Damaged');
    expect(stockHere(sku)).toBe(20);
    expect(initialMovements[0]).toMatchObject({ product: 'Ponni Rice 5kg', qty: -2, reason: 'Damage' });
  });

  it('purchases: supplier → PO → receipt with damaged goods returned → payment', async () => {
    await createSupplier({ name: 'Sri Balaji Traders', contact: 'Venkatesh', phone: '9840011223', email: '', gstin: '', supplies: 'Rice', creditDays: 15 });
    supplierId = uiSuppliers.find((s) => s.name === 'Sri Balaji Traders')!.id;

    const po = await createPurchaseOrder({ supplierId, date: TODAY, expected: TODAY, status: 'draft', lines: [{ sku, qty: 10, rate: 350, discountPct: 0, gst: 0 }], notes: '' });
    expect(po.number).toMatch(/^PO-\d{5}$/);
    const poId = getPurchases().pos[0]!.id;
    expect(getPurchases().pos[0]).toMatchObject({ status: 'draft' });
    await sendPurchaseOrder(poId);
    expect(getPurchases().pos[0]).toMatchObject({ status: 'sent' });

    const grn = await receiveGoods(
      { supplierId, poId, date: TODAY, supplierChallan: 'SBT/77', lines: [{ sku, received: 10, rejected: 1, rejectReason: 'Damaged', batch: '', expiry: '', rate: 350 }], notes: '' },
      true,
    );
    expect(grn.number).toMatch(/^GRN-\d{5}$/);
    expect(stockHere(sku)).toBe(29); // 20 + 9 accepted
    const st = getPurchases();
    expect(st.grns[0]).toMatchObject({ poId, supplierChallan: 'SBT/77' });
    expect(st.bills[0]).toMatchObject({ number: 'SBT/77', grnIds: [st.grns[0]!.id] });
    expect(st.returns[0]).toMatchObject({ grnId: st.grns[0]!.id, status: 'settled' });
    expect(uiSuppliers.find((s) => s.id === supplierId)!.due).toBe(3500 - 350); // invoice − debit note

    await recordSupplierPayment({ supplierId, date: TODAY, amount: 1000, mode: 'UPI', ref: 'UTR1', allocations: [], notes: '' });
    expect(uiSuppliers.find((s) => s.id === supplierId)!.due).toBe(2150);
    expect(getPurchases().payments[0]).toMatchObject({ amount: 1000, mode: 'UPI', allocations: [expect.objectContaining({ amount: 1000 })] });
  });

  it('POS: a cash sale is numbered by the server and takes stock; a return issues a credit note', async () => {
    const r = await sellLive({
      storeId: getBranches().currentId,
      lines: [{ key: 'line-1', sku, name: 'Ponni Rice 5kg', price: 420, qty: 2, discount: null }],
      billDiscount: null,
      buyer: null,
      payments: [{ method: 'Cash', amount: 840, tendered: 1000 }],
      payable: 840,
    });
    invoiceNo = r.invoiceNo;
    expect(invoiceNo).toMatch(/^FFM1\/\d{4}\/00001$/);
    const sale = await api<{ status: string; changeGiven: string; items: { qty: string }[] }>('GET', `/sales/${r.saleId}`);
    expect(sale).toMatchObject({ status: 'COMPLETED', changeGiven: '160.00' });

    const back = await returnLive(invoiceNo, { 'line-1': 1 }, 'Changed mind', 'Cash', getBranches().currentId);
    expect(back).toMatchObject({ creditNoteNo: expect.stringMatching(/^FFM1\/\d{4}\/C0001$/), refund: 420 });
  });

  it('a price the POS shows that the server no longer agrees with is refused', async () => {
    await expect(
      sellLive({
        storeId: getBranches().currentId,
        lines: [{ key: 'x', sku, name: 'Ponni Rice 5kg', price: 400, qty: 1, discount: null }],
        billDiscount: null,
        buyer: null,
        payments: [{ method: 'Cash', amount: 400 }],
        payable: 400,
      }),
    ).rejects.toMatchObject({ code: 'PRICE_CHANGED', message: expect.stringContaining('420') });
  });

  it('dashboard and sales screens show today’s real figures; the sales screen can refund', async () => {
    await saveProduct({ name: 'Ponni Rice 5kg', category: 'Staples', supplier: '', price: 420, cost: 360, stock: stockHere(sku) }, inventoryItems.find((i) => i.sku === sku)!);
    expect(ordersToday).toBe(1);
    expect(kpis[0]).toMatchObject({ label: "Today's Revenue", value: '₹420' }); // 840 − 420 returned
    expect(todaysBills).toHaveLength(1);
    const bill = todaysBills[0]!;
    expect(bill).toMatchObject({ total: 840, status: 'Paid', method: 'Cash' });
    const sale = liveBillSales.get(bill.id)!;
    await refundWholeBill(sale);
    expect(todaysBills[0]).toMatchObject({ status: 'Refunded' });
    expect(stockHere(sku)).toBe(29);
    expect(live.products.get(sku)).toBeDefined();
  });

  it('signing out ends the server session', async () => {
    signOut();
    await lastSignOut;
    expect(getSession()).toBeNull();
    expect(getLiveStatus().state).toBe('signedOut');
    await expect(api('GET', '/auth/me')).rejects.toMatchObject({ status: 401 });
  });
});
