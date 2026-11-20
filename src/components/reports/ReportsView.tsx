'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlarmClock,
  ArrowDownUp,
  BadgeIndianRupee,
  Boxes,
  Briefcase,
  Building2,
  CalendarRange,
  CreditCard,
  Download,
  HandCoins,
  Landmark,
  Layers,
  Package,
  Truck,
  UserCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { PageHead, downloadCsv } from '@/components/AppShell';
import { api, errorMessage } from '@/lib/api/client';
import { can, isLive } from '@/lib/live/session';
import { stores, useBranches } from '@/lib/branch-data';
import { TODAY, addDays } from '@/lib/suppliers-data';
import { Blocked, Btn, Empty, ErrorLine, Loading, fieldFixed, inr2, labelCls } from '@/components/live/kit';

/* =====================================================================
   Formatting
   ===================================================================== */

type J = Record<string, any>; // report payloads, typed per report below
const num = (v: unknown) => Number(v ?? 0);
const money = (v: unknown) => inr2(v as string);
const qty = (v: unknown) => num(v).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const pct = (v: unknown) => `${num(v).toFixed(1)}%`;
const day = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const MOVE: Record<string, string> = {
  OPENING: 'Opening stock',
  SALE: 'Sold',
  SALE_RETURN: 'Customer returns',
  PURCHASE_RECEIPT: 'Goods received',
  PURCHASE_RETURN: 'Returned to supplier',
  TRANSFER_IN: 'Transfer in',
  TRANSFER_OUT: 'Transfer out',
  TRANSFER_LOSS: 'Lost in transit',
  WRITE_OFF: 'Written off',
  ADJUSTMENT: 'Adjustment',
  COUNT_ADJUSTMENT: 'Stock count correction',
  VOID: 'Cancelled bill',
};
const MODE: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK_TRANSFER: 'Bank transfer', CHEQUE: 'Cheque', CREDIT: 'Credit (khata)' };
const humanize = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/* =====================================================================
   Report catalogue
   ===================================================================== */

type Q = { from: string; to: string; storeId: string; days: number };
type Col<R> = { label: string; get: (r: R) => ReactNode; csv?: (r: R) => string | number; right?: boolean; strong?: boolean };
type Def = {
  key: string;
  title: string;
  blurb: string;
  group: 'Business' | 'Sales & products' | 'Stock' | 'Money';
  icon: LucideIcon;
  allowed: () => boolean;
  /** What the controls offer. */
  range?: boolean;
  branch?: boolean;
  days?: boolean;
  path: (q: Q) => [string, Record<string, string | number>];
  render: (d: J, ctx: Ctx) => ReactNode;
  csv?: (d: J, ctx: Ctx) => (string | number)[][];
};
type Ctx = { branchName: (id: string) => string };

const rangeQ = (q: Q) => ({ from: q.from, to: q.to, ...(q.storeId ? { storeId: q.storeId } : {}) });

const REPORTS: Def[] = [
  {
    key: 'business',
    title: 'Business summary',
    blurb: 'Sales, profit, expenses, purchases, credit and cash in one view',
    group: 'Business',
    icon: Briefcase,
    allowed: () => can('reports:finance'),
    range: true,
    branch: true,
    path: (q) => ['/reports/business-summary', rangeQ(q)],
    render: (d) => (
      <>
        <Tiles
          items={[
            ['Net sales', money(d.sales.netSales), `${d.sales.bills} bills · refunds ${money(d.sales.refunds)}`],
            ['Gross profit', money(d.sales.grossProfit), `${pct(d.sales.grossMarginPct)} margin`],
            ['Expenses', money(d.expenses.total), `GST on expenses ${money(d.expenses.gstOnExpenses)}`],
            ['Operating result', money(d.operatingResult), 'Gross profit − expenses', num(d.operatingResult) < 0 ? 'text-coral' : 'text-teal'],
          ]}
        />
        <div className="grid gap-4 lg:grid-cols-3">
          <KV
            title="Sales"
            rows={[
              ['Gross sales', money(d.sales.grossSales)],
              ['Refunds', `− ${money(d.sales.refunds)}`],
              ['Net sales', money(d.sales.netSales), true],
              ['GST collected', money(d.sales.outputTax)],
              ['Net of GST', money(d.sales.netSalesExTax)],
              ['Cost of goods sold', money(d.sales.costOfGoods)],
              ['Gross profit', money(d.sales.grossProfit), true],
            ]}
          />
          <KV
            title="Cash"
            rows={[
              ['Cash sales', money(d.cash.cashSales)],
              ['Cash refunds', `− ${money(d.cash.cashRefunds)}`],
              ['Put into drawers', money(d.cash.drawerPayIns)],
              ['Taken out of drawers', `− ${money(d.cash.drawerPayOuts)}`],
              ['Net cash', money(d.cash.net), true],
            ]}
          />
          <KV
            title="Purchasing, credit and today"
            rows={[
              ['Bought from suppliers', money(d.purchasing.purchased)],
              ['Returned to suppliers', money(d.purchasing.returnedToSuppliers)],
              ['Paid to suppliers', money(d.purchasing.paidToSuppliers)],
              ['Credit given (khata)', money(d.credit.givenOnAccount)],
              ['Credit collected', money(d.credit.collected)],
              ['Stock at cost now', money(d.now.stockAtCost), true],
              ['Customers owe you now', money(d.now.receivable)],
              ['You owe suppliers now', money(d.now.payable)],
            ]}
          />
        </div>
        <Note>{d.basis}</Note>
      </>
    ),
    csv: (d) => [
      ['Item', 'Amount'],
      ...Object.entries({ ...d.sales, ...prefix('expenses', d.expenses), operatingResult: d.operatingResult, ...prefix('cash', d.cash), ...prefix('purchasing', d.purchasing), ...prefix('credit', d.credit), ...prefix('now', d.now) }).map(([k, v]) => [k, String(v)]),
    ],
  },
  {
    key: 'sales',
    title: 'Sales by period',
    blurb: 'Day, week or month: bills, discounts, refunds, tax and profit',
    group: 'Sales & products',
    icon: CalendarRange,
    allowed: () => can('reports:sales'),
    range: true,
    branch: true,
    path: (q) => {
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
      return ['/reports/sales', { ...rangeQ(q), groupBy: days > 120 ? 'month' : days > 45 ? 'week' : 'day' }];
    },
    render: (d) => {
      const max = Math.max(1, ...d.periods.map((p: J) => num(p.netSales)));
      return (
        <>
          <Tiles
            items={[
              ['Net sales', money(d.totals.netSales), `${d.totals.bills} bills`],
              ['Average bill', money(d.totals.averageBill), `Discounts ${money(d.totals.discounts)}`],
              ['GST', money(d.totals.tax), `On ${money(d.totals.taxable)} taxable`],
              ['Gross profit', money(d.totals.grossProfit), `${pct(d.totals.grossMarginPct)} margin`],
            ]}
          />
          <Table
            rows={d.periods}
            cols={[
              { label: d.groupBy === 'day' ? 'Day' : d.groupBy === 'week' ? 'Week of' : 'Month', get: (r) => day(r.period) },
              {
                label: 'Net sales',
                get: (r) => (
                  <span className="flex items-center justify-end gap-2">
                    <span className="hidden h-2 w-24 rounded-full bg-bg sm:inline-block">
                      <span className="block h-2 rounded-full bg-blue" style={{ width: `${(num(r.netSales) / max) * 100}%` }} />
                    </span>
                    {money(r.netSales)}
                  </span>
                ),
                csv: (r) => r.netSales,
                right: true,
                strong: true,
              },
              { label: 'Bills', get: (r) => r.bills, right: true },
              { label: 'Avg bill', get: (r) => money(r.averageBill), csv: (r) => r.averageBill, right: true },
              { label: 'Discounts', get: (r) => money(r.discounts), csv: (r) => r.discounts, right: true },
              { label: 'Refunds', get: (r) => money(r.refunds), csv: (r) => r.refunds, right: true },
              { label: 'GST', get: (r) => money(r.tax), csv: (r) => r.tax, right: true },
              { label: 'Profit', get: (r) => money(r.grossProfit), csv: (r) => r.grossProfit, right: true },
            ]}
            empty="No sales in this period."
          />
        </>
      );
    },
    csv: (d) => [['Period', 'Bills', 'Gross', 'Discounts', 'Returns', 'Refunds', 'Net', 'Taxable', 'GST', 'Avg bill', 'Profit'], ...d.periods.map((p: J) => [p.period, p.bills, p.grossSales, p.discounts, p.returns, p.refunds, p.netSales, p.taxable, p.tax, p.averageBill, p.grossProfit])],
  },
  {
    key: 'location',
    title: 'Sales by branch & counter',
    blurb: 'Which branch and which counter sells what',
    group: 'Sales & products',
    icon: Building2,
    allowed: () => can('reports:sales'),
    range: true,
    path: (q) => ['/reports/sales-by-location', { from: q.from, to: q.to }],
    render: (d) => (
      <>
        <Tiles items={[['Net sales', money(d.totals.netSales), `${d.totals.bills} bills`], ['Branches billing', String(d.stores.length), '']]} />
        <Table
          rows={d.stores.flatMap((s: J) => [{ ...s, _kind: 'store' }, ...s.counters.map((c: J) => ({ ...c, _kind: 'counter' }))])}
          cols={[
            {
              label: 'Branch / counter',
              get: (r) => (r._kind === 'store' ? <b>{r.store.name}</b> : <span className="pl-4 text-sub">{r.counter.name}</span>),
              csv: (r) => (r._kind === 'store' ? r.store.name : `  ${r.counter.name}`),
            },
            { label: 'Bills', get: (r) => r.bills, right: true },
            { label: 'Gross', get: (r) => money(r.grossSales), csv: (r) => r.grossSales, right: true },
            { label: 'Returns', get: (r) => r.returns, right: true },
            { label: 'Refunds', get: (r) => money(r.refunds), csv: (r) => r.refunds, right: true },
            { label: 'Net sales', get: (r) => money(r.netSales), csv: (r) => r.netSales, right: true, strong: true },
          ]}
          empty="No sales in this period."
        />
      </>
    ),
  },
  {
    key: 'products',
    title: 'Product performance',
    blurb: 'Best and worst sellers, with cost and margin',
    group: 'Sales & products',
    icon: Package,
    allowed: () => can('reports:sales'),
    range: true,
    branch: true,
    path: (q) => ['/reports/products', rangeQ(q)],
    render: (d) => (
      <>
        <Tiles
          items={[
            ['Products sold', String(d.totals.products), ''],
            ['Revenue', money(d.totals.revenue), ''],
            ...(d.totals.cost !== undefined ? ([['Cost', money(d.totals.cost), ''], ['Profit', money(d.totals.profit), '']] as TileItem[]) : []),
          ]}
        />
        <Table
          rows={d.data}
          cols={[
            { label: 'Product', get: (r) => <Named name={r.name} sub={`${r.sku}${r.category ? ` · ${r.category.name ?? r.category}` : ''}`} />, csv: (r) => r.name },
            { label: 'Bills', get: (r) => r.bills, right: true },
            { label: 'Units', get: (r) => qty(r.units), csv: (r) => r.units, right: true },
            { label: 'Returned', get: (r) => (num(r.unitsReturned) ? qty(r.unitsReturned) : '—'), csv: (r) => r.unitsReturned, right: true },
            { label: 'Revenue', get: (r) => money(r.revenue), csv: (r) => r.revenue, right: true, strong: true },
            { label: 'Share', get: (r) => pct(r.sharePct), csv: (r) => r.sharePct, right: true },
            ...(d.totals.cost !== undefined
              ? ([
                  { label: 'Profit', get: (r: J) => money(r.profit), csv: (r: J) => r.profit, right: true },
                  { label: 'Margin', get: (r: J) => pct(r.marginPct), csv: (r: J) => r.marginPct, right: true },
                ] as Col<J>[])
              : []),
          ]}
          empty="Nothing sold in this period."
        />
      </>
    ),
  },
  {
    key: 'categories',
    title: 'Departments',
    blurb: 'Sales and margin by top-level category',
    group: 'Sales & products',
    icon: Layers,
    allowed: () => can('reports:sales'),
    range: true,
    branch: true,
    path: (q) => ['/reports/categories', rangeQ(q)],
    render: (d) => (
      <Table
        rows={d.data}
        cols={[
          { label: 'Department', get: (r) => <b>{r.name}</b>, csv: (r) => r.name },
          { label: 'Products', get: (r) => r.products, right: true },
          { label: 'Units', get: (r) => qty(r.units), csv: (r) => r.units, right: true },
          { label: 'Revenue', get: (r) => money(r.revenue), csv: (r) => r.revenue, right: true, strong: true },
          { label: 'Share', get: (r) => <Bar value={num(r.sharePct)} />, csv: (r) => r.sharePct, right: true },
          { label: 'Profit', get: (r) => (r.profit !== undefined ? money(r.profit) : '—'), csv: (r) => r.profit ?? '', right: true },
          { label: 'Margin', get: (r) => (r.marginPct !== undefined ? pct(r.marginPct) : '—'), csv: (r) => r.marginPct ?? '', right: true },
        ]}
        empty="Nothing sold in this period."
      />
    ),
  },
  {
    key: 'valuation',
    title: 'Inventory valuation',
    blurb: 'Stock on hand at cost, selling price and MRP',
    group: 'Stock',
    icon: Boxes,
    allowed: () => can('reports:finance'),
    branch: true,
    path: (q) => ['/reports/inventory-valuation', q.storeId ? { storeId: q.storeId } : {}],
    render: (d) => (
      <>
        <Tiles
          items={[
            ['At cost', money(d.totals.atCost), `${qty(d.totals.qty)} units · ${d.totals.lines} lines`],
            ['At selling price', money(d.totals.atSellingPrice), `Potential margin ${money(num(d.totals.atSellingPrice) - num(d.totals.atCost))}`],
            ['At MRP', money(d.totals.atMrp), ''],
            ['Below zero', String(d.totals.negativeLines), d.totals.negativeLines ? `${money(d.totals.negativeAtCost)} to reconcile` : 'Nothing negative', d.totals.negativeLines ? 'text-coral' : ''],
          ]}
        />
        <Table
          rows={d.stores.flatMap((s: J) => [{ ...s, _kind: 'store', name: s.store.name }, ...s.categories.map((c: J) => ({ ...c, _kind: 'cat' }))])}
          cols={[
            { label: 'Branch / department', get: (r) => (r._kind === 'store' ? <b>{r.name}</b> : <span className="pl-4 text-sub">{r.name}</span>), csv: (r) => (r._kind === 'store' ? r.name : `  ${r.name}`) },
            { label: 'Lines', get: (r) => r.lines, right: true },
            { label: 'Units', get: (r) => qty(r.qty), csv: (r) => r.qty, right: true },
            { label: 'At cost', get: (r) => money(r.atCost), csv: (r) => r.atCost, right: true, strong: true },
            { label: 'At selling price', get: (r) => money(r.atSellingPrice), csv: (r) => r.atSellingPrice, right: true },
            { label: 'At MRP', get: (r) => money(r.atMrp), csv: (r) => r.atMrp, right: true },
          ]}
          empty="No stock on hand."
        />
        <Note>{d.basis}</Note>
      </>
    ),
  },
  {
    key: 'movements',
    title: 'Stock movements',
    blurb: 'Everything that moved stock in or out, with shrinkage',
    group: 'Stock',
    icon: ArrowDownUp,
    allowed: () => can('inventory:read'),
    range: true,
    branch: true,
    path: (q) => ['/reports/stock-movements', rangeQ(q)],
    render: (d) => (
      <>
        <Tiles
          items={[
            ['Value in', money(d.totals.valueIn), ''],
            ['Value out', money(d.totals.valueOut), ''],
            ['Shrinkage at cost', money(d.totals.shrinkageAtCost), 'Damage, expiry, theft, losses and count corrections', num(d.totals.shrinkageAtCost) ? 'text-coral' : ''],
          ]}
        />
        <Table
          rows={d.data}
          cols={[
            { label: 'Movement', get: (r) => <Named name={MOVE[r.type] ?? humanize(r.type)} sub={r.reason ? humanize(r.reason) : ''} />, csv: (r) => `${MOVE[r.type] ?? r.type}${r.reason ? ` (${r.reason})` : ''}` },
            { label: 'Entries', get: (r) => r.movements, right: true },
            { label: 'Units in', get: (r) => (num(r.qtyIn) ? qty(r.qtyIn) : '—'), csv: (r) => r.qtyIn, right: true },
            { label: 'Units out', get: (r) => (num(r.qtyOut) ? qty(r.qtyOut) : '—'), csv: (r) => r.qtyOut, right: true },
            { label: 'Value in', get: (r) => (num(r.valueIn) ? money(r.valueIn) : '—'), csv: (r) => r.valueIn, right: true },
            { label: 'Value out', get: (r) => (num(r.valueOut) ? money(r.valueOut) : '—'), csv: (r) => r.valueOut, right: true },
            { label: 'Went below zero', get: (r) => (r.belowZero ? <span className="text-coral">{r.belowZero}</span> : '—'), csv: (r) => r.belowZero, right: true },
          ]}
          empty="No stock moved in this period."
        />
      </>
    ),
  },
  {
    key: 'expiry',
    title: 'Expiry',
    blurb: 'Batches expired or expiring soon, valued at cost',
    group: 'Stock',
    icon: AlarmClock,
    allowed: () => can('inventory:read'),
    branch: true,
    days: true,
    path: (q) => ['/reports/expiry', { days: q.days, ...(q.storeId ? { storeId: q.storeId } : {}) }],
    render: (d, ctx) => (
      <>
        <Tiles
          items={[
            ['Expired', money(d.totals.expired), 'Still on the shelf', num(d.totals.expired) ? 'text-coral' : ''],
            ['Within 7 days', money(d.totals.within7Days), '', num(d.totals.within7Days) ? 'text-amber' : ''],
            ['Within 30 days', money(d.totals.within30Days), ''],
            [`All within ${d.days} days`, money(d.totals.atRisk), 'At cost'],
          ]}
        />
        <Table
          rows={d.data}
          cols={[
            { label: 'Product', get: (r) => <Named name={r.product.name} sub={`${r.product.sku} · batch ${r.batchNo}`} />, csv: (r) => `${r.product.name} (${r.batchNo})` },
            { label: 'Branch', get: (r) => ctx.branchName(r.storeId), csv: (r) => ctx.branchName(r.storeId) },
            { label: 'Expires', get: (r) => day(r.expiryDate), csv: (r) => r.expiryDate },
            {
              label: 'Days left',
              get: (r) => <span className={r.daysLeft < 0 ? 'font-semibold text-coral' : r.daysLeft <= 7 ? 'font-semibold text-amber' : ''}>{r.daysLeft < 0 ? `${-r.daysLeft} ago` : r.daysLeft}</span>,
              csv: (r) => r.daysLeft,
              right: true,
            },
            { label: 'Units', get: (r) => qty(r.qty), csv: (r) => r.qty, right: true },
            { label: 'At cost', get: (r) => money(r.valueAtCost), csv: (r) => r.valueAtCost, right: true, strong: true },
            { label: 'At MRP', get: (r) => (r.valueAtMrp ? money(r.valueAtMrp) : '—'), csv: (r) => r.valueAtMrp ?? '', right: true },
          ]}
          empty="Nothing expiring in this window. Batch tracking must be on for a product to show here."
        />
      </>
    ),
  },
  {
    key: 'payments',
    title: 'Payment reconciliation',
    blurb: 'Tenders by status, refunds, customer receipts and drawers',
    group: 'Money',
    icon: CreditCard,
    allowed: () => can('cash:reconcile'),
    range: true,
    branch: true,
    path: (q) => ['/reports/payment-reconciliation', rangeQ(q)],
    render: (d) => (
      <>
        <Tiles
          items={[
            ['Settled', money(d.tenders.reduce((s: number, t: J) => s + num(t.settled), 0)), 'Money actually received'],
            ['Waiting to verify', money(d.awaitingVerification.amount), `${d.awaitingVerification.count} payment${d.awaitingVerification.count === 1 ? '' : 's'}${d.awaitingVerification.oldest ? ` · oldest ${day(d.awaitingVerification.oldest)}` : ''}`, num(d.awaitingVerification.amount) ? 'text-amber' : ''],
            ['Drawer difference', money(d.drawers.variance), `${d.drawers.closed} closed · ${d.drawers.openNow} open · ${d.drawers.awaitingReview} to sign off`, num(d.drawers.variance) ? 'text-coral' : ''],
          ]}
        />
        <Table
          title="Tenders"
          rows={d.tenders}
          cols={[
            { label: 'Method', get: (r) => <b>{MODE[r.method] ?? r.method}</b>, csv: (r) => r.method },
            { label: 'Recorded', get: (r) => money(r.recorded), csv: (r) => r.recorded, right: true },
            { label: 'Settled', get: (r) => money(r.settled), csv: (r) => r.settled, right: true, strong: true },
            { label: 'To verify', get: (r) => money(r.pendingVerification), csv: (r) => r.pendingVerification, right: true },
            { label: 'Failed', get: (r) => money(r.failed), csv: (r) => r.failed, right: true },
            { label: 'Refunded / cancelled', get: (r) => money(r.refunded), csv: (r) => r.refunded, right: true },
          ]}
          empty="No payments in this period."
        />
        <div className="grid gap-4 lg:grid-cols-2">
          <Table
            title="Refunds"
            rows={d.refunds}
            cols={[
              { label: 'Method', get: (r) => MODE[r.method] ?? r.method, csv: (r) => r.method },
              { label: 'Status', get: (r) => humanize(r.status), csv: (r) => r.status },
              { label: 'Count', get: (r) => r.count, right: true },
              { label: 'Amount', get: (r) => money(r.amount), csv: (r) => r.amount, right: true, strong: true },
            ]}
            empty="No refunds."
          />
          <Table
            title="Payments from credit customers"
            rows={d.customerReceipts}
            cols={[
              { label: 'Method', get: (r) => MODE[r.method] ?? r.method, csv: (r) => r.method },
              { label: 'Count', get: (r) => r.count, right: true },
              { label: 'Amount', get: (r) => money(r.amount), csv: (r) => r.amount, right: true, strong: true },
            ]}
            empty="No credit payments collected."
          />
        </div>
      </>
    ),
  },
  {
    key: 'cashiers',
    title: 'Cashier performance',
    blurb: 'Bills, discounts, cancellations, returns and drawer differences',
    group: 'Money',
    icon: UserCheck,
    allowed: () => can('cash:reconcile'),
    range: true,
    branch: true,
    path: (q) => ['/reports/cashier-performance', rangeQ(q)],
    render: (d) => (
      <Table
        rows={d.data}
        cols={[
          { label: 'Cashier', get: (r) => <b>{r.cashier.name}</b>, csv: (r) => r.cashier.name },
          { label: 'Bills', get: (r) => r.bills, right: true },
          { label: 'Sales', get: (r) => money(r.revenue), csv: (r) => r.revenue, right: true, strong: true },
          { label: 'Avg bill', get: (r) => money(r.averageBill), csv: (r) => r.averageBill, right: true },
          { label: 'Discounts', get: (r) => money(r.discounts), csv: (r) => r.discounts, right: true },
          { label: 'Cancelled', get: (r) => (r.voids ? <span className="text-coral">{r.voids} · {money(r.voidedValue)}</span> : '—'), csv: (r) => r.voids, right: true },
          { label: 'Returns', get: (r) => (r.returns ? `${r.returns} · ${money(r.refunds)}` : '—'), csv: (r) => r.returns, right: true },
          {
            label: 'Drawer difference',
            get: (r) => <span className={num(r.drawerVariance) ? 'font-semibold text-coral' : ''}>{money(r.drawerVariance)}</span>,
            csv: (r) => r.drawerVariance,
            right: true,
          },
        ]}
        empty="No bills in this period."
      />
    ),
  },
  {
    key: 'expenses',
    title: 'Expenses',
    blurb: 'Running costs by category, payment mode and month',
    group: 'Money',
    icon: HandCoins,
    allowed: () => can('reports:finance') || can('expenses:write'),
    range: true,
    branch: true,
    path: (q) => ['/reports/expenses', rangeQ(q)],
    render: (d, ctx) => (
      <>
        <Tiles items={[['Spent', money(d.totals.amount), `${d.totals.count} expenses`], ['GST on bills', money(d.totals.gst), 'May be claimable']]} />
        <div className="grid gap-4 lg:grid-cols-2">
          <Table
            title="By category"
            rows={d.byCategory}
            cols={[
              { label: 'Category', get: (r) => r.category, csv: (r) => r.category },
              { label: 'Share', get: (r) => <Bar value={num(r.sharePct)} />, csv: (r) => r.sharePct, right: true },
              { label: 'Amount', get: (r) => money(r.amount), csv: (r) => r.amount, right: true, strong: true },
            ]}
            empty="No expenses."
          />
          <div className="space-y-4">
            <Table title="By payment mode" rows={d.byMode} cols={[{ label: 'Mode', get: (r) => MODE[r.mode] ?? r.mode }, { label: 'Count', get: (r) => r.count, right: true }, { label: 'Amount', get: (r) => money(r.amount), right: true, strong: true }]} empty="—" />
            <Table title="By branch" rows={d.byStore} cols={[{ label: 'Branch', get: (r) => ctx.branchName(r.storeId) }, { label: 'Count', get: (r) => r.count, right: true }, { label: 'Amount', get: (r) => money(r.amount), right: true, strong: true }]} empty="—" />
          </div>
        </div>
        <p className="text-sm">
          <Link href="/expenses" className="font-semibold text-blue hover:underline">
            Open the Expenses page →
          </Link>
        </p>
      </>
    ),
    csv: (d) => [['Category', 'Count', 'Amount', 'GST', 'Share %'], ...d.byCategory.map((r: J) => [r.category, r.count, r.amount, r.gst, r.sharePct])],
  },
  {
    key: 'purchases',
    title: 'Purchases by supplier',
    blurb: 'Bought, returned, paid and still owed, per supplier',
    group: 'Money',
    icon: Truck,
    allowed: () => can('reports:finance'),
    range: true,
    branch: true,
    path: (q) => ['/reports/purchases', rangeQ(q)],
    render: (d) => (
      <>
        <Tiles
          items={[
            ['Bought', money(d.totals.purchased), `${d.totals.receipts} goods receipts · GST ${money(d.totals.tax)}`],
            ['Returned', money(d.totals.returned), ''],
            ['Paid', money(d.totals.paid), ''],
            ['Still owed', money(d.totals.outstanding), 'All suppliers, today', num(d.totals.outstanding) ? 'text-amber' : ''],
          ]}
        />
        <Table
          rows={d.data}
          cols={[
            { label: 'Supplier', get: (r) => <b>{r.supplier.name}</b>, csv: (r) => r.supplier.name },
            { label: 'Receipts', get: (r) => r.receipts, right: true },
            { label: 'Bought', get: (r) => money(r.purchased), csv: (r) => r.purchased, right: true, strong: true },
            { label: 'GST', get: (r) => money(r.tax), csv: (r) => r.tax, right: true },
            { label: 'Returned', get: (r) => money(r.returned), csv: (r) => r.returned, right: true },
            { label: 'Paid', get: (r) => money(r.paid), csv: (r) => r.paid, right: true },
            { label: 'Owed now', get: (r) => money(r.outstanding), csv: (r) => r.outstanding, right: true },
          ]}
          empty="No purchases in this period."
        />
        {d.note && <Note>{d.note}</Note>}
      </>
    ),
  },
  {
    key: 'receivables',
    title: 'Customers who owe you',
    blurb: 'Credit (khata) balances with how long they’ve been owed',
    group: 'Money',
    icon: Users,
    allowed: () => can('customers:read'),
    path: () => ['/reports/receivables', {}],
    render: (d) => (
      <>
        <Tiles
          items={[
            ['Owed to you', money(d.total), `${d.data.length} customer${d.data.length === 1 ? '' : 's'}`],
            ['0–30 days', money(d.ageing['0-30']), ''],
            ['31–90 days', money(num(d.ageing['31-60']) + num(d.ageing['61-90'])), '', num(d.ageing['31-60']) + num(d.ageing['61-90']) ? 'text-amber' : ''],
            ['Over 90 days', money(d.ageing['90+']), '', num(d.ageing['90+']) ? 'text-coral' : ''],
          ]}
        />
        <Table
          rows={d.data}
          cols={[
            { label: 'Customer', get: (r) => <Named name={r.customer.name} sub={r.customer.phone ?? ''} />, csv: (r) => r.customer.name },
            { label: 'Owes', get: (r) => <span className={r.overLimit ? 'text-coral' : ''}>{money(r.balance)}</span>, csv: (r) => r.balance, right: true, strong: true },
            { label: 'Limit', get: (r) => money(r.creditLimit), csv: (r) => r.creditLimit, right: true },
            { label: 'Owing since', get: (r) => day(r.owingSince), csv: (r) => r.owingSince ?? '' },
            { label: 'Age', get: (r) => r.ageing, csv: (r) => r.ageing },
            { label: 'Last bill', get: (r) => day(r.lastSale), csv: (r) => r.lastSale ?? '' },
            { label: 'Last payment', get: (r) => day(r.lastReceipt), csv: (r) => r.lastReceipt ?? '' },
          ]}
          empty="No customer owes you anything."
        />
      </>
    ),
  },
  {
    key: 'payables',
    title: 'What you owe suppliers',
    blurb: 'Supplier balances, with how late each one is',
    group: 'Money',
    icon: BadgeIndianRupee,
    allowed: () => can('reports:finance') || can('supplier-payments:write'),
    path: () => ['/reports/payables', {}],
    render: (d) => (
      <>
        <Tiles
          items={[
            ['You owe', money(d.totals.balance), `${d.data.length} supplier${d.data.length === 1 ? '' : 's'}`],
            ['Not yet due', money(d.totals.current), ''],
            ['1–30 days late', money(d.totals.d1_30), '', num(d.totals.d1_30) ? 'text-amber' : ''],
            ['Over 30 days late', money(num(d.totals.d31_60) + num(d.totals.d60)), '', num(d.totals.d31_60) + num(d.totals.d60) ? 'text-coral' : ''],
          ]}
        />
        <Table
          rows={d.data}
          cols={[
            { label: 'Supplier', get: (r) => <Named name={r.supplier.name} sub={`${r.supplier.creditDays} days credit`} />, csv: (r) => r.supplier.name },
            { label: 'Owed', get: (r) => money(r.balance), csv: (r) => r.balance, right: true, strong: true },
            { label: 'Not yet due', get: (r) => money(r.ageing.current), csv: (r) => r.ageing.current, right: true },
            { label: '1–30 late', get: (r) => money(r.ageing.d1_30), csv: (r) => r.ageing.d1_30, right: true },
            { label: '31–60 late', get: (r) => money(r.ageing.d31_60), csv: (r) => r.ageing.d31_60, right: true },
            { label: '60+ late', get: (r) => money(r.ageing.d60), csv: (r) => r.ageing.d60, right: true },
            { label: 'Overdue', get: (r) => <span className={num(r.overdue) ? 'font-semibold text-coral' : ''}>{money(r.overdue)}</span>, csv: (r) => r.overdue, right: true },
          ]}
          empty="You don’t owe any supplier anything."
        />
      </>
    ),
  },
];

const prefix = (p: string, o: J) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`${p}.${k}`, v]));
const GROUPS = ['Business', 'Sales & products', 'Stock', 'Money'] as const;

/* =====================================================================
   View
   ===================================================================== */

type PresetKey = 'today' | '7' | '30' | 'month' | 'last' | 'fy' | 'custom';
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
const presets: [Exclude<PresetKey, 'custom'>, string, () => { from: string; to: string }][] = [
  ['today', 'Today', () => ({ from: TODAY, to: TODAY })],
  ['7', '7 days', () => ({ from: addDays(TODAY, -6), to: TODAY })],
  ['30', '30 days', () => ({ from: addDays(TODAY, -29), to: TODAY })],
  ['month', 'This month', () => ({ from: monthStart(TODAY), to: TODAY })],
  [
    'last',
    'Last month',
    () => {
      const end = addDays(monthStart(TODAY), -1);
      return { from: monthStart(end), to: end };
    },
  ],
  [
    'fy',
    'This FY',
    () => {
      const [y, m] = TODAY.split('-').map(Number) as [number, number];
      return { from: `${m >= 4 ? y : y - 1}-04-01`, to: TODAY };
    },
  ],
];

export function ReportsView() {
  const router = useRouter();
  const params = useSearchParams();
  const branches = useBranches();
  const shops = stores(branches);
  const ctx: Ctx = { branchName: (id) => branches.branches.find((b) => b.id === id)?.name ?? '—' };

  const available = useMemo(() => (isLive() ? REPORTS.filter((r) => r.allowed()) : []), []);
  const current = available.find((r) => r.key === params.get('r')) ?? available[0];

  const [preset, setPreset] = useState<PresetKey>('month');
  const [range, setRange] = useState(() => presets[3]![2]());
  const [storeId, setStoreId] = useState('');
  const [days, setDays] = useState(30);
  // Tagged with its report, so switching reports never renders one report with another's data.
  const [loaded, setLoaded] = useState<{ key: string; d: J } | null>(null);
  const data = loaded && loaded.key === current?.key ? loaded.d : null;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!current || range.from > range.to) return;
    const ctl = new AbortController();
    const [path, query] = current.path({ ...range, storeId, days });
    setLoading(true);
    setError('');
    api<J>('GET', path, { query, signal: ctl.signal })
      .then((d) => setLoaded({ key: current.key, d }))
      .catch((e) => {
        if (!ctl.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
  }, [current, range, storeId, days]);

  const exportCsv = () => {
    if (!current || !data) return;
    const rows = current.csv ? current.csv(data, ctx) : lastTableCsv.rows;
    if (rows.length) downloadCsv(`${current.key}_${current.range ? `${range.from}_to_${range.to}` : TODAY}.csv`, rows);
  };

  if (!isLive())
    return (
      <Shell>
        <Blocked kind="offline">Reports are built from the bills, stock and payments the server records. Set NEXT_PUBLIC_API_URL in .env.local and restart the app.</Blocked>
      </Shell>
    );
  if (!current)
    return (
      <Shell>
        <Blocked kind="denied">Your role can’t see any reports. Ask the owner for report permissions.</Blocked>
      </Shell>
    );

  lastTableCsv.rows = [];
  return (
    <Shell
      action={
        <Btn onClick={exportCsv} disabled={!data}>
          <Download className="size-4" /> Export CSV
        </Btn>
      }
    >
      <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
        {/* report list */}
        <nav className="card h-fit p-2 xl:sticky xl:top-20" aria-label="Reports">
          {GROUPS.map((g) => {
            const items = available.filter((r) => r.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="mb-2">
                <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-mute">{g}</div>
                {items.map((r) => {
                  const Icon = r.icon;
                  const on = r.key === current.key;
                  return (
                    <button
                      key={r.key}
                      type="button"
                      onClick={() => router.replace(`/reports?r=${r.key}`, { scroll: false })}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition ${on ? 'bg-blue/10 font-semibold text-blue' : 'text-ink hover:bg-bg'}`}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{r.title}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {can('reports:finance') && (
            <div className="mb-1 border-t border-line pt-2">
              <Link href="/gst-report" className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-ink hover:bg-bg">
                <Landmark className="size-4" aria-hidden="true" /> GST report ↗
              </Link>
            </div>
          )}
        </nav>

        <div className="min-w-0 space-y-4">
          <section className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-extrabold">{current.title}</h2>
                <p className="text-sm text-sub">{current.blurb}</p>
              </div>
              {loading && <span className="text-xs text-mute">Loading…</span>}
            </div>
            {(current.range || current.branch || current.days) && (
              <div className="mt-3 flex flex-wrap items-end gap-3">
                {current.range && (
                  <>
                    <div className="flex flex-wrap gap-1 rounded-xl bg-bg p-1">
                      {presets.map(([k, label, fn]) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => {
                            setPreset(k);
                            setRange(fn());
                          }}
                          className={`h-8 rounded-lg px-2.5 text-xs font-semibold ${preset === k ? 'bg-surface text-ink shadow-sm' : 'text-sub hover:text-ink'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <label className={labelCls}>
                      From
                      <input
                        type="date"
                        value={range.from}
                        max={range.to}
                        onChange={(e) => {
                          setPreset('custom');
                          setRange((r) => ({ ...r, from: e.target.value }));
                        }}
                        className={`${fieldFixed} mt-1 h-9 w-40`}
                      />
                    </label>
                    <label className={labelCls}>
                      To
                      <input
                        type="date"
                        value={range.to}
                        min={range.from}
                        max={TODAY}
                        onChange={(e) => {
                          setPreset('custom');
                          setRange((r) => ({ ...r, to: e.target.value }));
                        }}
                        className={`${fieldFixed} mt-1 h-9 w-40`}
                      />
                    </label>
                  </>
                )}
                {current.days && (
                  <label className={labelCls}>
                    Expiring within
                    <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${fieldFixed} mt-1 h-9 w-32`}>
                      {[7, 30, 60, 90, 180].map((d) => (
                        <option key={d} value={d}>
                          {d} days
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {current.branch && shops.length + branches.branches.filter((b) => b.kind === 'warehouse').length > 1 && (
                  <label className={labelCls}>
                    Branch
                    <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={`${fieldFixed} mt-1 h-9 w-48`}>
                      <option value="">All branches</option>
                      {branches.branches
                        .filter((b) => b.active)
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
              </div>
            )}
          </section>

          <ErrorLine>{error}</ErrorLine>
          {!data ? !error && <Loading /> : <div className="space-y-4">{current.render(data, ctx)}</div>}
        </div>
      </div>
    </Shell>
  );
}

/* =====================================================================
   Building blocks
   ===================================================================== */

/** The CSV of the first table rendered, for reports without their own export. */
const lastTableCsv: { rows: (string | number)[][] } = { rows: [] };

function Shell({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageHead title="Reports" sub="Sales, stock, money and staff — from what the server recorded">
        {action}
      </PageHead>
      {children}
    </div>
  );
}

type TileItem = [string, string, string] | [string, string, string, string];
function Tiles({ items }: { items: TileItem[] }) {
  return (
    <section className={`grid gap-3 sm:grid-cols-2 ${items.length >= 4 ? 'xl:grid-cols-4' : items.length === 3 ? 'xl:grid-cols-3' : ''}`}>
      {items.map(([label, value, sub, tone]) => (
        <div key={label} className="card p-4">
          <div className="text-sm font-semibold text-sub">{label}</div>
          <div className={`mt-2 truncate text-[22px] font-extrabold tabular-nums ${tone ?? ''}`}>{value}</div>
          {sub && <div className="mt-0.5 text-xs text-mute">{sub}</div>}
        </div>
      ))}
    </section>
  );
}

function KV({ title, rows }: { title: string; rows: [string, string, boolean?][] }) {
  return (
    <section className="card p-4">
      <h3 className="mb-2 font-bold">{title}</h3>
      {rows.map(([k, v, strong]) => (
        <div key={k} className={`flex justify-between gap-3 py-1 text-sm ${strong ? 'border-t border-line pt-1.5 font-bold' : 'text-sub'}`}>
          <span>{k}</span>
          <span className="tabular-nums text-ink">{v}</span>
        </div>
      ))}
    </section>
  );
}

function Table<R extends J>({ rows, cols, empty, title }: { rows: R[]; cols: Col<R>[]; empty: string; title?: string }) {
  if (!lastTableCsv.rows.length && rows.length)
    lastTableCsv.rows = [cols.map((c) => c.label), ...rows.map((r) => cols.map((c) => (c.csv ? c.csv(r) : textOf(c.get(r)))))];
  return (
    <section className="card overflow-hidden">
      {title && <h3 className="border-b border-line px-4 py-3 font-bold">{title}</h3>}
      {!rows.length ? (
        <Empty>{empty}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-bg/60 text-xs uppercase tracking-wide text-mute">
              <tr>
                {cols.map((c) => (
                  <th key={c.label} className={`whitespace-nowrap px-4! py-2.5! font-semibold ${c.right ? 'text-right' : 'text-left'}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c.label} className={`px-4! py-2.5! ${c.right ? 'text-right tabular-nums' : ''} ${c.strong ? 'font-semibold' : ''}`}>
                      {c.get(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const textOf = (n: ReactNode): string | number => (typeof n === 'string' || typeof n === 'number' ? n : '');

function Named({ name, sub }: { name: string; sub: string }) {
  return (
    <span>
      <span className="block font-medium">{name}</span>
      {sub && <span className="block text-xs text-mute">{sub}</span>}
    </span>
  );
}

function Bar({ value }: { value: number }) {
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="hidden h-2 w-20 rounded-full bg-bg sm:inline-block">
        <span className="block h-2 rounded-full bg-blue" style={{ width: `${Math.min(100, value)}%` }} />
      </span>
      {value.toFixed(1)}%
    </span>
  );
}

/** Server notes, without internal design-doc references. */
const Note = ({ children }: { children: ReactNode }) => (
  <p className="text-xs text-mute">{typeof children === 'string' ? children.replace(/\s*\(ADR-\d+\)/g, '') : children}</p>
);
