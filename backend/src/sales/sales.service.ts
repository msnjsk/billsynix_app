import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Decimal } from '../common/decimal.js';
import { gstinProblem } from '../common/gst.js';
import { idempotent } from '../common/idempotency.js';
import { page, skipTake } from '../common/schemas.js';
import {
  assertPermission,
  can,
  canAccessStore,
  type AuthContext,
} from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Prisma, Store, Tenant } from '../generated/prisma/client.js';
import { storePrices } from '../catalogue/pricing.js';
import { LedgerService } from '../inventory/ledger.service.js';
import {
  customerForSale,
  postCustomerTxn,
} from '../finance/customer-ledger.js';
import {
  computeBill,
  inclusivePrice,
  r2,
  type Bill,
  type DiscountIn,
} from './bill-math.js';
import type { InvoiceDocument } from './receipt.js';
import {
  authorise,
  conflict,
  dateOnly,
  dateStr,
  listApprovers,
  nextDocumentNo,
  notFound,
  openSessionFor,
  resolveCounter,
  salesLimits,
  todayIn,
  unprocessable,
  verifyApprover,
  type Approver,
} from './sales.common.js';
import type {
  ApproversQuery,
  CreateSaleInput,
  ListSalesQuery,
  PaymentDecisionInput,
  QuoteInput,
  VoidInput,
} from './sales.schemas.js';

const ZERO = new Decimal(0);

const saleInclude = {
  items: { orderBy: { lineNo: 'asc' as const } },
  payments: { orderBy: { createdAt: 'asc' as const } },
  store: { select: { code: true, name: true } },
  counter: { select: { number: true, name: true } },
  returns: {
    select: {
      id: true,
      creditNoteNo: true,
      refundAmount: true,
      createdAt: true,
    },
  },
} satisfies Prisma.SaleInclude;
type SaleRow = Prisma.SaleGetPayload<{ include: typeof saleInclude }>;

type CounterRow = Awaited<ReturnType<typeof resolveCounter>>;

type ProductRow = Prisma.ProductGetPayload<{
  include: { unit: true; taxRate: true };
}>;

/** One priced line of a bill, ready to be recorded. */
export type PricedLine = {
  product: ProductRow;
  qty: Decimal;
  /** Per unit, tax inclusive. */
  unitPrice: Decimal;
  priceSource: string;
  mrp: Decimal | null;
  gstRate: Decimal;
  cessRate: Decimal;
  discount: DiscountIn;
  batchId?: string | undefined;
};

export type Tender = {
  method: 'CASH' | 'UPI' | 'CARD' | 'CREDIT';
  amount: string;
  tendered?: string | undefined;
  reference?: string | undefined;
  status: 'SUCCEEDED' | 'PENDING_VERIFICATION';
};

/** Everything `record()` writes for one sale, already priced and checked. */
export type SaleRecord = {
  tenantId: string;
  tenant: Tenant;
  store: Store;
  counter: CounterRow;
  cashSessionId: string;
  cashierUserId: string;
  chargeGst: boolean;
  interState: boolean;
  placeOfSupply: string;
  lines: PricedLine[];
  bill: Bill;
  billDiscount: DiscountIn;
  discountApprovedBy: string | null;
  buyer?:
    | {
        name?: string | undefined;
        phone?: string | undefined;
        gstin?: string | undefined;
      }
    | undefined;
  tenders: Tender[];
  change: Decimal;
  invoiceNo: string;
  businessDate: string;
  /** When the bill was made (offline: on the device). Defaults to now. */
  issuedAt?: Date;
  clientRef?: string | null | undefined;
  /** Billed offline on this device: stock may go below zero (flagged `negative`). */
  offlineDeviceId?: string;
  /** The customer; a CREDIT tender goes on their account. */
  customerId?: string | null;
  auditAction: string;
  meta: RequestMeta;
};

/** Tenders must cover the payable exactly; cash may be over-tendered (change). */
export function checkTenders(
  payments: readonly {
    method: 'CASH' | 'UPI' | 'CARD' | 'CREDIT';
    amount: string;
    tendered?: string | undefined;
    reference?: string | undefined;
  }[],
  payable: Decimal,
): { tenders: Tender[]; change: Decimal } {
  const paid = payments.reduce((s, p) => s.plus(p.amount), ZERO);
  if (!paid.eq(payable))
    throw unprocessable(
      'PAYMENT_MISMATCH',
      `Payments add up to ₹${paid.toFixed(2)}, the bill is ₹${payable.toFixed(2)}.`,
      'payments',
    );
  let change = ZERO;
  payments.forEach((p, i) => {
    if (p.tendered !== undefined) {
      if (p.method !== 'CASH')
        throw unprocessable(
          'INVALID_TENDER',
          'Only cash is tendered with change.',
          `payments.${i}.tendered`,
        );
      if (new Decimal(p.tendered).lt(p.amount))
        throw unprocessable(
          'INVALID_TENDER',
          'Cash handed over is less than the amount.',
          `payments.${i}.tendered`,
        );
      change = change.plus(new Decimal(p.tendered).minus(p.amount));
    }
  });
  return {
    change,
    tenders: payments.map((p) => ({
      ...p,
      // A cashier's tap is not proof that UPI or card money arrived. Credit is recorded on the
      // customer's account at once (it is a receivable, not money).
      status:
        p.method === 'CASH' || p.method === 'CREDIT'
          ? 'SUCCEEDED'
          : 'PENDING_VERIFICATION',
    })),
  };
}

/** What the customer still owes: a payment's status sets the sale's. */
export function paymentStatusOf(
  payments: { status: string; method?: string }[],
  payable: Decimal,
) {
  if (payable.isZero()) return 'PAID' as const;
  if (payments.some((p) => p.status === 'FAILED')) return 'DUE' as const;
  if (payments.some((p) => p.status === 'PENDING_VERIFICATION'))
    return 'PENDING' as const;
  if (payments.some((p) => p.method === 'CREDIT' && p.status === 'SUCCEEDED'))
    return 'CREDIT' as const;
  return 'PAID' as const;
}

/**
 * POS sales. A sale is one transaction: prices and tax from the server (branch price list,
 * product tax, MRP cap), stock out through the ledger (locked, never below zero), the next
 * invoice number of the counter's series, line snapshots, payments, and the printed document.
 * Any failure rolls all of it back — no stock moves, no number is used, no payment is recorded.
 * `Idempotency-Key` makes a retried request return the same sale.
 *
 * Payments: cash is settled at once; UPI and card stay PENDING_VERIFICATION until someone with
 * `cash:reconcile` confirms them (or, later, a payment provider's callback) — a cashier's tap is
 * not proof of payment.
 */
@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  /* ---------- pricing ---------- */

  private async price(
    tx: Tx,
    auth: AuthContext,
    counter: CounterRow,
    input: QuoteInput,
    approver: Approver | null,
  ) {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: auth.tenantId },
    });
    const store = counter.store;
    const chargeGst = tenant.registration === 'REGULAR';
    const ids = [...new Set(input.lines.map((l) => l.productId))];
    const products = new Map(
      (
        await tx.product.findMany({
          where: { tenantId: auth.tenantId, id: { in: ids } },
          include: { unit: true, taxRate: true },
        })
      ).map((p) => [p.id, p]),
    );
    const prices = await storePrices(tx, auth.tenantId, store.priceListId, [
      ...products.values(),
    ]);

    const buyerGstin = input.buyer?.gstin;
    if (buyerGstin) {
      const problem = gstinProblem(buyerGstin);
      if (problem) throw unprocessable('INVALID_GSTIN', problem, 'buyer.gstin');
    }
    const placeOfSupply = buyerGstin ? buyerGstin.slice(0, 2) : store.stateCode;
    const interState = chargeGst && placeOfSupply !== store.stateCode;

    const lines = input.lines.map((l, i) => {
      const f = `lines.${i}`;
      const p = products.get(l.productId);
      if (!p)
        throw unprocessable(
          'INVALID_REFERENCE',
          'Product not found.',
          `${f}.productId`,
        );
      if (p.status !== 'ACTIVE')
        throw unprocessable(
          'PRODUCT_INACTIVE',
          `${p.name} is no longer sold.`,
          `${f}.productId`,
        );
      const qty = new Decimal(l.qty);
      if (qty.decimalPlaces() > p.unit.decimals)
        throw unprocessable(
          'INVALID_QTY',
          p.unit.decimals
            ? `${p.name} is sold to ${p.unit.decimals} decimal places.`
            : `${p.name} is sold in whole ${p.unit.code}.`,
          `${f}.qty`,
        );
      let price: Decimal;
      let priceSource: string;
      if (l.unitPrice !== undefined) {
        if (!p.allowOpenPrice)
          throw unprocessable(
            'OPEN_PRICE_NOT_ALLOWED',
            `${p.name} has a fixed price.`,
            `${f}.unitPrice`,
          );
        price = new Decimal(l.unitPrice);
        priceSource = 'OPEN_PRICE';
      } else {
        const sp = prices.get(p.id)!;
        price = new Decimal(sp.sellingPrice);
        priceSource = sp.source;
      }
      const taxed = p.taxRate.kind === 'TAXABLE';
      const gstRate = taxed ? p.taxRate.rate : ZERO;
      const cessRate = taxed ? p.taxRate.cessRate : ZERO;
      const unitPrice =
        p.priceIncludesTax || !chargeGst
          ? price
          : inclusivePrice(price, gstRate, cessRate);
      if (p.mrp && unitPrice.gt(p.mrp))
        throw unprocessable(
          'PRICE_ABOVE_MRP',
          `${p.name}: ₹${unitPrice.toFixed(2)} is above the MRP ₹${p.mrp.toFixed(2)}.`,
          `${f}.unitPrice`,
        );
      const discount: DiscountIn = l.discount
        ? { kind: l.discount.kind, value: new Decimal(l.discount.value) }
        : null;
      return {
        product: p,
        qty,
        unitPrice,
        priceSource,
        mrp: p.mrp,
        gstRate,
        cessRate,
        discount,
        batchId: l.batchId,
      } satisfies PricedLine;
    });

    const billDiscount: DiscountIn = input.billDiscount
      ? {
          kind: input.billDiscount.kind,
          value: new Decimal(input.billDiscount.value),
        }
      : null;
    const bill = computeBill(lines, billDiscount, { interState, chargeGst });

    // Discounts above the limit (any line, or the bill overall) need a manager.
    const limits = await salesLimits(tx, auth.tenantId);
    const pct = (part: Decimal, whole: Decimal) =>
      whole.gt(0) ? part.times(100).dividedBy(whole) : ZERO;
    const maxLine = bill.rows.reduce(
      (m, r) => Decimal.max(m, pct(r.lineDiscount, r.gross)),
      ZERO,
    );
    const overall = pct(bill.lineDiscounts.plus(bill.billDiscount), bill.gross);
    let discountApprovedBy: string | null = null;
    if (Decimal.max(maxLine, overall).gt(limits.discountPct))
      discountApprovedBy = authorise(
        auth,
        approver,
        'discount:override',
        store.id,
        `A discount above ${limits.discountPct.toFixed(0)}%`,
      );

    return {
      tenant,
      store,
      chargeGst,
      interState,
      placeOfSupply,
      lines,
      bill,
      billDiscount,
      discountApprovedBy,
    };
  }

  private quoteView(
    priced: Awaited<ReturnType<SalesService['price']>>,
    available?: Map<string, Decimal>,
  ) {
    const { bill, lines } = priced;
    return {
      documentType: priced.chargeGst ? 'TAX_INVOICE' : 'BILL_OF_SUPPLY',
      interState: priced.interState,
      placeOfSupply: priced.placeOfSupply,
      lines: lines.map((l, i) => {
        const r = bill.rows[i]!;
        const have = available?.get(l.product.id);
        return {
          productId: l.product.id,
          sku: l.product.sku,
          name: l.product.name,
          qty: l.qty.toFixed(3),
          unitPrice: l.unitPrice.toFixed(2),
          priceSource: l.priceSource,
          mrp: l.product.mrp?.toFixed(2) ?? null,
          gross: r.gross.toFixed(2),
          lineDiscount: r.lineDiscount.toFixed(2),
          billShare: r.billShare.toFixed(2),
          final: r.final.toFixed(2),
          taxable: r.taxable.toFixed(2),
          gstRate: Number(l.gstRate),
          tax: r.gst.plus(r.cess).toFixed(2),
          ...(have !== undefined && l.product.trackInventory
            ? { available: have.toFixed(3), inStock: have.gte(l.qty) }
            : {}),
        };
      }),
      totals: this.totals(bill),
      slabs: bill.slabs.map((s) => ({
        rate: Number(s.rate),
        taxable: s.taxable.toFixed(2),
        cgst: s.cgst.toFixed(2),
        sgst: s.sgst.toFixed(2),
        igst: s.igst.toFixed(2),
        cess: s.cess.toFixed(2),
      })),
      discountApproval: priced.discountApprovedBy ? 'OK' : null,
    };
  }

  private totals(b: Bill) {
    return {
      gross: b.gross.toFixed(2),
      lineDiscounts: b.lineDiscounts.toFixed(2),
      billDiscount: b.billDiscount.toFixed(2),
      taxable: b.taxable.toFixed(2),
      cgst: b.cgst.toFixed(2),
      sgst: b.sgst.toFixed(2),
      igst: b.igst.toFixed(2),
      cess: b.cess.toFixed(2),
      total: b.total.toFixed(2),
      roundOff: b.roundOff.toFixed(2),
      payable: b.payable.toFixed(2),
    };
  }

  /** Cart validation: the server's prices, discounts, tax and stock — nothing is saved. */
  async quote(auth: AuthContext, input: QuoteInput) {
    assertPermission(auth, 'sales:create');
    const approver = input.approval
      ? await verifyApprover(this.prisma, auth.tenantId, input.approval)
      : null;
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const counter = await resolveCounter(tx, auth, input.counterId);
      const priced = await this.price(tx, auth, counter, input, approver);
      const balances = await tx.stockBalance.findMany({
        where: {
          tenantId: auth.tenantId,
          storeId: counter.storeId,
          productId: { in: priced.lines.map((l) => l.product.id) },
        },
      });
      const available = new Map(priced.lines.map((l) => [l.product.id, ZERO]));
      for (const b of balances) available.set(b.productId, b.qty);
      return this.quoteView(priced, available);
    });
  }

  /* ---------- sales ---------- */

  async create(
    auth: AuthContext,
    input: CreateSaleInput,
    key: string,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'sales:create');
    const approver = input.approval
      ? await verifyApprover(this.prisma, auth.tenantId, input.approval)
      : null;
    return this.prisma.withTenant(
      auth.tenantId,
      (tx) =>
        idempotent(
          tx,
          auth.tenantId,
          key,
          { route: 'POST sales', body: input },
          201,
          async () => {
            const counter = await resolveCounter(tx, auth, input.counterId);
            const session = await openSessionFor(tx, auth, counter.id);
            if (input.clientRef) {
              const dup = await tx.sale.findFirst({
                where: {
                  tenantId: auth.tenantId,
                  counterId: counter.id,
                  clientRef: input.clientRef,
                },
                select: { invoiceNo: true },
              });
              if (dup)
                throw conflict(
                  'DUPLICATE_CLIENT_REF',
                  `This bill was already saved as ${dup.invoiceNo}.`,
                );
            }
            const priced = await this.price(tx, auth, counter, input, approver);
            const { bill, store, tenant } = priced;
            if (
              input.expectedPayable !== undefined &&
              !new Decimal(input.expectedPayable).eq(bill.payable)
            )
              throw conflict(
                'PRICE_CHANGED',
                `The total is now ₹${bill.payable.toFixed(2)} (prices or tax changed) — review the bill and try again.`,
              );

            const { tenders, change } = checkTenders(
              input.payments,
              bill.payable,
            );
            const credit = tenders
              .filter((t) => t.method === 'CREDIT')
              .reduce((s, t) => s.plus(t.amount), ZERO);
            // The order this bill is for: open, at this branch, not billed yet.
            const order = input.customerOrderId
              ? await this.orderToBill(
                  tx,
                  auth.tenantId,
                  input.customerOrderId,
                  store.id,
                )
              : null;
            const customerId =
              input.customerId ?? order?.customerId ?? undefined;
            if (credit.gt(0) && !customerId)
              throw unprocessable(
                'CUSTOMER_REQUIRED',
                'Choose the customer whose account this goes on.',
                'customerId',
              );
            const customer = customerId
              ? await customerForSale(tx, auth.tenantId, customerId, credit)
              : null;
            const buyer =
              input.buyer ??
              (customer
                ? {
                    name: customer.name,
                    ...(customer.phone ? { phone: customer.phone } : {}),
                  }
                : order
                  ? { name: order.customerName, phone: order.phone }
                  : undefined);
            const businessDate = todayIn(store.timezone);
            const invoiceNo = await nextDocumentNo(
              tx,
              auth.tenantId,
              counter,
              businessDate,
              'INV',
            );
            const { sale } = await this.record(tx, {
              tenantId: auth.tenantId,
              tenant,
              store,
              counter,
              cashSessionId: session.id,
              cashierUserId: auth.userId,
              chargeGst: priced.chargeGst,
              interState: priced.interState,
              placeOfSupply: priced.placeOfSupply,
              lines: priced.lines,
              bill,
              billDiscount: priced.billDiscount,
              discountApprovedBy: priced.discountApprovedBy,
              buyer,
              tenders,
              change,
              invoiceNo,
              businessDate,
              clientRef: input.clientRef ?? null,
              customerId: customer?.id ?? null,
              auditAction: 'sale.completed',
              meta,
            });
            if (order)
              await this.markOrderBilled(
                tx,
                order,
                sale.id,
                invoiceNo,
                tenders,
                auth.userId,
              );
            return this.view(auth, sale);
          },
        ),
      { timeout: 30_000 },
    );
  }

  /**
   * Writes a priced, checked sale inside the caller's transaction: the sale, stock out through the
   * ledger (locked; below zero only for offline sales, flagged `negative`), line snapshots,
   * payments with their first transaction, the printed document and the audit record.
   */
  async record(tx: Tx, r: SaleRecord) {
    const { bill } = r;
    const sale = await tx.sale.create({
      data: {
        tenantId: r.tenantId,
        storeId: r.store.id,
        counterId: r.counter.id,
        cashSessionId: r.cashSessionId,
        cashierUserId: r.cashierUserId,
        invoiceNo: r.invoiceNo,
        documentType: r.chargeGst ? 'TAX_INVOICE' : 'BILL_OF_SUPPLY',
        paymentStatus: paymentStatusOf(r.tenders, bill.payable),
        ...(r.issuedAt ? { issuedAt: r.issuedAt } : {}),
        businessDate: dateOnly(r.businessDate),
        buyerName: r.buyer?.name ?? null,
        buyerPhone: r.buyer?.phone ?? null,
        buyerGstin: r.buyer?.gstin ?? null,
        placeOfSupply: r.placeOfSupply,
        interState: r.interState,
        billDiscountKind: r.billDiscount?.kind ?? null,
        billDiscountValue: r.billDiscount?.value ?? null,
        gross: bill.gross,
        lineDiscounts: bill.lineDiscounts,
        billDiscount: bill.billDiscount,
        taxable: bill.taxable,
        cgst: bill.cgst,
        sgst: bill.sgst,
        igst: bill.igst,
        cess: bill.cess,
        total: bill.total,
        roundOff: bill.roundOff,
        payable: bill.payable,
        changeGiven: r.change,
        discountApprovedBy: r.discountApprovedBy,
        clientRef: r.clientRef ?? null,
        customerId: r.customerId ?? null,
        ...(r.offlineDeviceId
          ? { offline: true, deviceId: r.offlineDeviceId, syncedAt: new Date() }
          : {}),
      },
    });

    // Stock out — locked and checked; a shortfall aborts the whole sale (online).
    const movements = await this.ledger.post(tx, {
      tenantId: r.tenantId,
      storeId: r.store.id,
      refType: 'SALE',
      refId: sale.id,
      userId: r.cashierUserId,
      allowNegative: !!r.offlineDeviceId,
      lines: r.lines
        .filter((l) => l.product.trackInventory)
        .map((l) => ({
          productId: l.product.id,
          batchId: l.batchId,
          qty: l.qty.negated(),
          type: 'SALE' as const,
          note: r.invoiceNo,
        })),
    });
    const costOf = new Map(movements.map((m) => [m.productId, m.unitCost]));

    await tx.saleItem.createMany({
      data: r.lines.map((l, i) => {
        const row = bill.rows[i]!;
        return {
          tenantId: r.tenantId,
          saleId: sale.id,
          lineNo: i + 1,
          productId: l.product.id,
          sku: l.product.sku,
          name: l.product.receiptName ?? l.product.name,
          hsnCode: l.product.hsnCode,
          unitCode: l.product.unit.code,
          qty: l.qty,
          unitPrice: l.unitPrice,
          mrp: l.mrp,
          priceSource: l.priceSource,
          discountKind: l.discount?.kind ?? null,
          discountValue: l.discount?.value ?? null,
          gross: row.gross,
          lineDiscount: row.lineDiscount,
          billShare: row.billShare,
          final: row.final,
          taxable: row.taxable,
          gstRate: r.chargeGst ? l.gstRate : 0,
          cessRate: r.chargeGst ? l.cessRate : 0,
          cgst: row.cgst,
          sgst: row.sgst,
          igst: row.igst,
          cess: row.cess,
          unitCost: costOf.get(l.product.id) ?? l.product.purchaseCost ?? 0,
        };
      }),
    });

    for (const t of r.tenders) {
      const pay = await tx.salePayment.create({
        data: {
          tenantId: r.tenantId,
          saleId: sale.id,
          method: t.method,
          amount: t.amount,
          status: t.status,
          tendered: t.tendered ?? null,
          reference: t.reference ?? null,
        },
      });
      await tx.paymentTransaction.create({
        data: {
          tenantId: r.tenantId,
          paymentId: pay.id,
          event: t.status === 'SUCCEEDED' ? 'CAPTURED' : 'RECORDED',
          amount: t.amount,
          reference: t.reference ?? null,
          userId: r.cashierUserId,
          ...(r.offlineDeviceId
            ? { note: 'Recorded offline on the device' }
            : {}),
        },
      });
    }

    const onAccount = r.tenders
      .filter((t) => t.method === 'CREDIT')
      .reduce((s, t) => s.plus(t.amount), ZERO);
    if (onAccount.gt(0))
      await postCustomerTxn(tx, {
        tenantId: r.tenantId,
        customerId: r.customerId!,
        type: 'SALE',
        amount: onAccount,
        date: dateOnly(r.businessDate),
        refType: 'SALE',
        refId: sale.id,
        refNo: r.invoiceNo,
        userId: r.cashierUserId,
      });

    const full = await this.loadRow(tx, r.tenantId, sale.id);
    await tx.invoice.create({
      data: {
        tenantId: r.tenantId,
        kind: full.documentType,
        number: r.invoiceNo,
        saleId: sale.id,
        issuedAt: full.issuedAt,
        document: (await this.document(
          tx,
          full,
          r.tenant,
          r.store,
        )) as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.record(
      {
        tenantId: r.tenantId,
        actorUserId: r.cashierUserId,
        action: r.auditAction,
        entity: 'sale',
        entityId: sale.id,
        data: {
          invoiceNo: r.invoiceNo,
          payable: bill.payable.toFixed(2),
          lines: r.lines.length,
          discountApprovedBy: r.discountApprovedBy,
          ...(r.offlineDeviceId ? { deviceId: r.offlineDeviceId } : {}),
        },
        meta: r.meta,
      },
      tx,
    );
    return { sale: full, movements };
  }

  /** A delivery / pickup order about to be billed: locked, open, at this branch, not billed. */
  private async orderToBill(
    tx: Tx,
    tenantId: string,
    id: string,
    storeId: string,
  ) {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customer_orders WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
    const o = locked
      ? await tx.customerOrder.findUnique({ where: { id: locked.id } })
      : null;
    if (!o)
      throw unprocessable(
        'INVALID_REFERENCE',
        'Order not found.',
        'customerOrderId',
      );
    if (o.storeId !== storeId)
      throw unprocessable(
        'OTHER_BRANCH',
        `${o.number} is for another branch.`,
        'customerOrderId',
      );
    if (o.saleId)
      throw conflict(
        'ORDER_ALREADY_BILLED',
        `${o.number} has already been billed.`,
      );
    if (o.status === 'COMPLETED' || o.status === 'CANCELLED')
      throw conflict(
        'INVALID_STATE',
        `${o.number} is ${o.status.toLowerCase()}.`,
      );
    return o;
  }

  private async markOrderBilled(
    tx: Tx,
    o: { id: string; status: string; history: Prisma.JsonValue },
    saleId: string,
    invoiceNo: string,
    tenders: Tender[],
    userId: string,
  ) {
    const LABEL = {
      CASH: 'Cash',
      UPI: 'UPI',
      CARD: 'Card',
      CREDIT: 'Khata',
    } as const;
    const main = [...tenders].sort(
      (a, b) => Number(b.amount) - Number(a.amount),
    )[0];
    await tx.customerOrder.update({
      where: { id: o.id },
      data: {
        saleId,
        paid: true,
        collectedBy: main ? LABEL[main.method] : null,
        history: [
          ...(o.history as Prisma.JsonArray),
          {
            status: o.status,
            at: new Date().toISOString(),
            note: `Billed ${invoiceNo}`,
            userId,
          },
        ],
      },
    });
  }

  /** The issued document (frozen as JSON with the invoice). */
  async document(
    tx: Tx,
    s: SaleRow,
    tenant: Tenant,
    store: Store,
  ): Promise<InvoiceDocument> {
    const cashier = await tx.user.findUnique({
      where: { id: s.cashierUserId },
      select: { name: true },
    });
    const bos = s.documentType === 'BILL_OF_SUPPLY';
    const slabs = new Map<
      string,
      {
        rate: number;
        taxable: Decimal;
        gst: Decimal;
        igst: Decimal;
        cess: Decimal;
      }
    >();
    for (const i of s.items) {
      const k = i.gstRate.toFixed(2);
      const x = slabs.get(k) ?? {
        rate: Number(i.gstRate),
        taxable: ZERO,
        gst: ZERO,
        igst: ZERO,
        cess: ZERO,
      };
      x.taxable = x.taxable.plus(i.taxable);
      x.gst = x.gst.plus(i.cgst).plus(i.sgst);
      x.igst = x.igst.plus(i.igst);
      x.cess = x.cess.plus(i.cess);
      slabs.set(k, x);
    }
    return {
      kind: s.documentType,
      title: bos ? 'BILL OF SUPPLY' : 'TAX INVOICE',
      number: s.invoiceNo,
      against: null,
      issuedAt: s.issuedAt.toISOString(),
      seller: {
        name: tenant.displayName,
        legalName: tenant.legalName,
        gstin: store.gstin ?? tenant.gstin,
        address: [
          store.addressLine1,
          store.addressLine2,
          store.city,
          store.pincode,
        ]
          .filter(Boolean)
          .join(', '),
        phone: store.phone ?? tenant.phone,
        branch: store.name,
        counter: s.counter.name,
      },
      buyer:
        s.buyerName || s.buyerPhone || s.buyerGstin
          ? { name: s.buyerName, phone: s.buyerPhone, gstin: s.buyerGstin }
          : null,
      placeOfSupply: s.placeOfSupply,
      interState: s.interState,
      cashier: cashier?.name ?? '',
      lines: s.items.map((i) => ({
        lineNo: i.lineNo,
        name: i.name,
        sku: i.sku,
        hsn: i.hsnCode,
        qty: i.qty.toFixed(Number(i.qty.decimalPlaces() ? 3 : 0)),
        unit: i.unitCode,
        unitPrice: i.unitPrice.toFixed(2),
        mrp: i.mrp?.toFixed(2) ?? null,
        discount: i.lineDiscount.plus(i.billShare).toFixed(2),
        amount: i.final.toFixed(2),
        gstRate: Number(i.gstRate),
      })),
      slabs: [...slabs.values()].map((x) => {
        const cgst = r2(x.gst.dividedBy(2));
        return {
          rate: x.rate,
          taxable: x.taxable.toFixed(2),
          cgst: cgst.toFixed(2),
          sgst: x.gst.minus(cgst).toFixed(2),
          igst: x.igst.toFixed(2),
          cess: x.cess.toFixed(2),
        };
      }),
      totals: {
        gross: s.gross.toFixed(2),
        discount: s.lineDiscounts.plus(s.billDiscount).toFixed(2),
        taxable: s.taxable.toFixed(2),
        cgst: s.cgst.toFixed(2),
        sgst: s.sgst.toFixed(2),
        igst: s.igst.toFixed(2),
        cess: s.cess.toFixed(2),
        roundOff: s.roundOff.toFixed(2),
        total: s.payable.toFixed(2),
      },
      payments: s.payments.map((p) => ({
        method: p.method,
        amount: p.amount.toFixed(2),
        status: p.status,
        reference: p.reference,
      })),
      change: s.changeGiven.toFixed(2),
      footer: [
        ...(bos
          ? [
              'Composition taxable person / not registered — not eligible to collect tax on supplies.',
            ]
          : []),
        'Prices are inclusive of all taxes.',
        'Thank you — please visit again.',
      ],
    };
  }

  /** A sale with lines, payments and returns — no visibility check (callers decide). */
  async loadRow(tx: Tx, tenantId: string, id: string) {
    const s = await tx.sale.findFirst({
      where: { id, tenantId },
      include: saleInclude,
    });
    if (!s) throw notFound('Sale');
    return s;
  }

  async load(tx: Tx, auth: AuthContext, id: string) {
    const s = await tx.sale.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: saleInclude,
    });
    if (!s || !canAccessStore(auth, s.storeId)) throw notFound('Sale');
    // Cashiers (no sales reports) see their own bills only.
    if (!can(auth, 'reports:sales') && s.cashierUserId !== auth.userId)
      throw notFound('Sale');
    return s;
  }

  view(auth: AuthContext, s: SaleRow) {
    const showCost = can(auth, 'reports:finance');
    return {
      id: s.id,
      invoiceNo: s.invoiceNo,
      documentType: s.documentType,
      status: s.status,
      paymentStatus: s.paymentStatus,
      store: { id: s.storeId, code: s.store.code, name: s.store.name },
      counter: {
        id: s.counterId,
        number: s.counter.number,
        name: s.counter.name,
      },
      cashSessionId: s.cashSessionId,
      cashierUserId: s.cashierUserId,
      customerId: s.customerId,
      issuedAt: s.issuedAt,
      businessDate: dateStr(s.businessDate),
      buyer:
        s.buyerName || s.buyerPhone || s.buyerGstin
          ? { name: s.buyerName, phone: s.buyerPhone, gstin: s.buyerGstin }
          : null,
      placeOfSupply: s.placeOfSupply,
      interState: s.interState,
      billDiscount: s.billDiscountKind
        ? { kind: s.billDiscountKind, value: s.billDiscountValue?.toFixed(2) }
        : null,
      totals: {
        gross: s.gross.toFixed(2),
        lineDiscounts: s.lineDiscounts.toFixed(2),
        billDiscount: s.billDiscount.toFixed(2),
        taxable: s.taxable.toFixed(2),
        cgst: s.cgst.toFixed(2),
        sgst: s.sgst.toFixed(2),
        igst: s.igst.toFixed(2),
        cess: s.cess.toFixed(2),
        total: s.total.toFixed(2),
        roundOff: s.roundOff.toFixed(2),
        payable: s.payable.toFixed(2),
      },
      changeGiven: s.changeGiven.toFixed(2),
      refunded: s.refunded.toFixed(2),
      items: s.items.map((i) => ({
        id: i.id,
        lineNo: i.lineNo,
        productId: i.productId,
        sku: i.sku,
        name: i.name,
        hsnCode: i.hsnCode,
        unit: i.unitCode,
        qty: i.qty.toFixed(3),
        unitPrice: i.unitPrice.toFixed(2),
        mrp: i.mrp?.toFixed(2) ?? null,
        priceSource: i.priceSource,
        discount: i.discountKind
          ? { kind: i.discountKind, value: i.discountValue?.toFixed(2) }
          : null,
        gross: i.gross.toFixed(2),
        lineDiscount: i.lineDiscount.toFixed(2),
        billShare: i.billShare.toFixed(2),
        final: i.final.toFixed(2),
        taxable: i.taxable.toFixed(2),
        gstRate: Number(i.gstRate),
        cessRate: Number(i.cessRate),
        cgst: i.cgst.toFixed(2),
        sgst: i.sgst.toFixed(2),
        igst: i.igst.toFixed(2),
        cess: i.cess.toFixed(2),
        returnedQty: i.returnedQty.toFixed(3),
        ...(showCost ? { unitCost: i.unitCost.toFixed(4) } : {}),
      })),
      payments: s.payments.map((p) => ({
        id: p.id,
        method: p.method,
        amount: p.amount.toFixed(2),
        status: p.status,
        tendered: p.tendered?.toFixed(2) ?? null,
        reference: p.reference,
        verifiedAt: p.verifiedAt,
      })),
      returns: s.returns.map((r) => ({
        id: r.id,
        creditNoteNo: r.creditNoteNo,
        refundAmount: r.refundAmount.toFixed(2),
        createdAt: r.createdAt,
      })),
      voided: s.voidedAt
        ? { at: s.voidedAt, byUserId: s.voidedByUserId, reason: s.voidReason }
        : null,
    };
  }

  list(auth: AuthContext, q: ListSalesQuery) {
    assertPermission(auth, 'sales:read');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      if (q.storeId && !canAccessStore(auth, q.storeId))
        throw notFound('Branch');
      const own = !can(auth, 'reports:sales');
      const where: Prisma.SaleWhereInput = {
        tenantId: auth.tenantId,
        ...(q.storeId
          ? { storeId: q.storeId }
          : auth.storeIds === 'ALL'
            ? {}
            : { storeId: { in: [...auth.storeIds] } }),
        ...(q.counterId && { counterId: q.counterId }),
        ...(own
          ? { cashierUserId: auth.userId }
          : q.cashierId
            ? { cashierUserId: q.cashierId }
            : {}),
        ...(q.date && { businessDate: dateOnly(q.date) }),
        ...(q.q && { invoiceNo: { startsWith: q.q.toUpperCase() } }),
        ...(q.status && { status: q.status }),
        ...(q.paymentStatus && { paymentStatus: q.paymentStatus }),
      };
      const rows = await tx.sale.findMany({
        where,
        include: saleInclude,
        orderBy: { issuedAt: 'desc' },
        ...skipTake(q),
      });
      const total = await tx.sale.count({ where });
      return page(
        rows.map((s) => this.view(auth, s)),
        total,
        q,
      );
    });
  }

  get(auth: AuthContext, id: string) {
    assertPermission(auth, 'sales:read');
    return this.prisma.withTenant(auth.tenantId, async (tx) =>
      this.view(auth, await this.load(tx, auth, id)),
    );
  }

  /** The printed invoice and its credit notes, as issued. */
  receipt(auth: AuthContext, id: string) {
    assertPermission(auth, 'sales:read');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const s = await this.load(tx, auth, id);
      const docs = await tx.invoice.findMany({
        where: { tenantId: auth.tenantId, saleId: s.id },
        orderBy: { issuedAt: 'asc' },
      });
      const invoice = docs.find((d) => d.kind !== 'CREDIT_NOTE');
      if (!invoice) throw notFound('Invoice');
      return {
        status: invoice.status,
        invoice: invoice.document as unknown as InvoiceDocument,
        creditNotes: docs
          .filter((d) => d.kind === 'CREDIT_NOTE')
          .map((d) => d.document as unknown as InvoiceDocument),
      };
    });
  }

  /**
   * Cancels a sale the same business day, before any return, while its drawer is still open:
   * stock goes back (at the cost it left), payments are refunded, the invoice is marked cancelled
   * and its number stays used.
   */
  async void(
    auth: AuthContext,
    id: string,
    input: VoidInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'sales:read');
    const approver = input.approval
      ? await verifyApprover(this.prisma, auth.tenantId, input.approval)
      : null;
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const s = await this.load(tx, auth, id);
      const by = authorise(
        auth,
        approver,
        'sales:void',
        s.storeId,
        'Voiding a sale',
      );
      if (s.status !== 'COMPLETED')
        throw conflict('INVALID_STATE', 'This sale is already voided.');
      if (s.returns.length)
        throw conflict(
          'HAS_RETURNS',
          'Items were returned from this sale — return the rest instead.',
        );
      const store = await tx.store.findUniqueOrThrow({
        where: { id: s.storeId },
      });
      if (dateStr(s.businessDate) !== todayIn(store.timezone))
        throw conflict(
          'NOT_TODAY',
          'Only today’s sales can be voided — use a return for older ones.',
        );
      const session = await tx.cashSession.findUniqueOrThrow({
        where: { id: s.cashSessionId },
      });
      if (session.status !== 'OPEN')
        throw conflict(
          'SESSION_CLOSED',
          'The drawer this sale was taken in is closed — use a return.',
        );
      const claimed = await tx.sale.updateMany({
        where: { id: s.id, tenantId: auth.tenantId, status: 'COMPLETED' },
        data: {
          status: 'VOIDED',
          paymentStatus: 'REFUNDED',
          voidedAt: new Date(),
          voidedByUserId: by,
          voidReason: input.reason,
        },
      });
      if (!claimed.count)
        throw conflict('INVALID_STATE', 'This sale was just changed.');
      const out = await tx.stockMovement.findMany({
        where: { tenantId: auth.tenantId, refType: 'SALE', refId: s.id },
      });
      await this.ledger.post(tx, {
        tenantId: auth.tenantId,
        storeId: s.storeId,
        refType: 'SALE_VOID',
        refId: s.id,
        userId: auth.userId,
        lines: out.map((m) => ({
          productId: m.productId,
          batchId: m.batchId,
          qty: m.qty.negated(),
          type: 'SALE_RETURN' as const,
          unitCost: m.unitCost,
          note: `Void ${s.invoiceNo}`,
        })),
      });
      for (const p of s.payments.filter(
        (p) => p.status !== 'FAILED' && p.status !== 'REFUNDED',
      )) {
        await tx.salePayment.update({
          where: { id: p.id },
          data: { status: 'REFUNDED' },
        });
        if (p.method === 'CREDIT' && s.customerId)
          await postCustomerTxn(tx, {
            tenantId: auth.tenantId,
            customerId: s.customerId,
            type: 'VOID',
            amount: p.amount.negated(),
            date: dateOnly(todayIn(store.timezone)),
            refType: 'SALE_VOID',
            refId: s.id,
            refNo: s.invoiceNo,
            note: input.reason,
            userId: auth.userId,
          });
        await tx.paymentTransaction.create({
          data: {
            tenantId: auth.tenantId,
            paymentId: p.id,
            event: 'VOIDED',
            amount: p.amount,
            note: input.reason,
            userId: auth.userId,
          },
        });
      }
      await tx.invoice.updateMany({
        where: {
          tenantId: auth.tenantId,
          saleId: s.id,
          kind: { not: 'CREDIT_NOTE' },
        },
        data: { status: 'CANCELLED' },
      });
      const linked = await tx.customerOrder.findFirst({
        where: { tenantId: auth.tenantId, saleId: s.id },
      });
      if (linked)
        await tx.customerOrder.update({
          where: { id: linked.id },
          data: {
            saleId: null,
            paid: linked.payment !== 'CASH_ON_DELIVERY',
            collectedBy: null,
            history: [
              ...(linked.history as Prisma.JsonArray),
              {
                status: linked.status,
                at: new Date().toISOString(),
                note: `Bill ${s.invoiceNo} voided`,
                userId: auth.userId,
              },
            ],
          },
        });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'sale.voided',
          entity: 'sale',
          entityId: s.id,
          data: {
            invoiceNo: s.invoiceNo,
            approvedBy: by,
            reason: input.reason,
          },
          meta,
        },
        tx,
      );
      return this.view(auth, await this.load(tx, auth, s.id));
    });
  }

  /* ---------- payment verification ---------- */

  /** A UPI/card payment seen in the bank / terminal statement (or, later, a provider callback). */
  confirmPayment(
    auth: AuthContext,
    paymentId: string,
    input: PaymentDecisionInput,
    meta: RequestMeta,
  ) {
    return this.decidePayment(auth, paymentId, 'SUCCEEDED', input, meta);
  }

  failPayment(
    auth: AuthContext,
    paymentId: string,
    input: PaymentDecisionInput,
    meta: RequestMeta,
  ) {
    return this.decidePayment(auth, paymentId, 'FAILED', input, meta);
  }

  private decidePayment(
    auth: AuthContext,
    paymentId: string,
    to: 'SUCCEEDED' | 'FAILED',
    input: PaymentDecisionInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'cash:reconcile');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const p = await tx.salePayment.findFirst({
        where: { id: paymentId, tenantId: auth.tenantId },
        include: { sale: true },
      });
      if (!p || !canAccessStore(auth, p.sale.storeId))
        throw notFound('Payment');
      const done = await tx.salePayment.updateMany({
        where: {
          id: p.id,
          tenantId: auth.tenantId,
          status: 'PENDING_VERIFICATION',
        },
        data: {
          status: to,
          verifiedByUserId: auth.userId,
          verifiedAt: new Date(),
          ...(input.reference && { reference: input.reference }),
        },
      });
      if (!done.count)
        throw conflict(
          'INVALID_STATE',
          `This payment is ${p.status.toLowerCase().replace('_', ' ')}.`,
        );
      await tx.paymentTransaction.create({
        data: {
          tenantId: auth.tenantId,
          paymentId: p.id,
          event: to === 'SUCCEEDED' ? 'CONFIRMED' : 'FAILED',
          amount: p.amount,
          reference: input.reference ?? p.reference,
          note: input.note ?? null,
          userId: auth.userId,
        },
      });
      if (p.sale.status === 'COMPLETED') {
        const all = await tx.salePayment.findMany({
          where: { tenantId: auth.tenantId, saleId: p.saleId },
        });
        const status =
          p.sale.refunded.gt(0) && p.sale.refunded.gte(p.sale.payable)
            ? 'REFUNDED'
            : paymentStatusOf(all, p.sale.payable);
        await tx.sale.update({
          where: { id: p.saleId },
          data: { paymentStatus: status },
        });
      }
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: to === 'SUCCEEDED' ? 'payment.confirmed' : 'payment.failed',
          entity: 'sale_payment',
          entityId: p.id,
          data: {
            saleId: p.saleId,
            amount: p.amount.toFixed(2),
            method: p.method,
          },
          meta,
        },
        tx,
      );
      return this.view(auth, await this.load(tx, auth, p.saleId));
    });
  }

  /** Managers who can approve `permission` at a branch with their PIN (the till's "ask a manager"). */
  approvers(auth: AuthContext, q: ApproversQuery) {
    assertPermission(auth, 'sales:create');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      let storeId = q.storeId;
      if (storeId) {
        const store = await tx.store.findFirst({
          where: { id: storeId, tenantId: auth.tenantId },
          select: { id: true },
        });
        if (!store || !canAccessStore(auth, storeId)) throw notFound('Branch');
      } else storeId = (await resolveCounter(tx, auth, q.counterId)).storeId;
      return {
        data: await listApprovers(tx, auth.tenantId, q.permission, storeId),
      };
    });
  }

  /** UPI/card payments awaiting verification in the caller's branches. */
  pendingPayments(auth: AuthContext) {
    assertPermission(auth, 'cash:reconcile');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.salePayment.findMany({
        where: {
          tenantId: auth.tenantId,
          status: 'PENDING_VERIFICATION',
          sale:
            auth.storeIds === 'ALL'
              ? {}
              : { storeId: { in: [...auth.storeIds] } },
        },
        include: {
          sale: { select: { invoiceNo: true, storeId: true, issuedAt: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 500,
      });
      return {
        data: rows.map((p) => ({
          id: p.id,
          saleId: p.saleId,
          invoiceNo: p.sale.invoiceNo,
          storeId: p.sale.storeId,
          method: p.method,
          amount: p.amount.toFixed(2),
          reference: p.reference,
          createdAt: p.createdAt,
        })),
      };
    });
  }
}
