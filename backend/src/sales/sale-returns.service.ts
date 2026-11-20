import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Decimal } from '../common/decimal.js';
import { idempotent } from '../common/idempotency.js';
import { assertPermission, type AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { LedgerLine } from '../inventory/ledger.service.js';
import { LedgerService } from '../inventory/ledger.service.js';
import { r2 } from './bill-math.js';
import type { InvoiceDocument } from './receipt.js';
import { SalesService } from './sales.service.js';
import { postCustomerTxn } from '../finance/customer-ledger.js';
import {
  authorise,
  conflict,
  dateOnly,
  nextDocumentNo,
  openSessionFor,
  resolveCounter,
  salesLimits,
  todayIn,
  unprocessable,
  verifyApprover,
} from './sales.common.js';
import type { CreateReturnInput } from './sales.schemas.js';

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);
const NOT_RESALEABLE = new Set(['DAMAGED', 'EXPIRED']);

/**
 * Returns against an invoice, with a credit note from the returning counter's series.
 *   • Quantity per line ≤ sold − already returned.
 *   • Value from the original line snapshot (what was charged per unit after all discounts), never
 *     today's price; the return that empties the invoice refunds exactly what is left of the payable,
 *     otherwise the refund is rounded to the rupee like the invoice was.
 *   • Stock: SALE_RETURN back at the cost it left with; damaged / expired goods are then written
 *     off (WRITE_OFF), so the loss is on record and the shelf count is right.
 *   • Money: cash comes out of the cashier's open drawer; UPI/card refunds are PENDING until sent.
 *   • Refunds above the business's limit (₹2,000 by default) need a manager (sales:void).
 */
@Injectable()
export class SaleReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly sales: SalesService,
  ) {}

  async create(
    auth: AuthContext,
    saleId: string,
    input: CreateReturnInput,
    key: string,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'sales:return');
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
          { route: `POST sales/${saleId}/returns`, body: input },
          201,
          async () => {
            // Lock the sale so two returns can't both take the same quantity.
            await tx.$queryRaw`SELECT id FROM sales WHERE id = ${saleId}::uuid AND tenant_id = ${auth.tenantId}::uuid FOR UPDATE`;
            const sale = await this.sales.load(tx, auth, saleId);
            if (sale.status !== 'COMPLETED')
              throw conflict(
                'INVALID_STATE',
                'A voided sale cannot be returned.',
              );
            const counter = await resolveCounter(tx, auth, input.counterId);
            if (counter.storeId !== sale.storeId)
              throw unprocessable(
                'OTHER_BRANCH',
                'Return goods at the branch that sold them.',
                'counterId',
              );
            const session =
              input.refundMethod === 'CASH'
                ? await openSessionFor(tx, auth, counter.id)
                : null;
            if (input.refundMethod === 'CREDIT' && !sale.customerId)
              throw unprocessable(
                'NO_CUSTOMER_ACCOUNT',
                'This sale has no customer account to credit — refund it another way.',
                'refundMethod',
              );

            const lines = input.items.map((it, n) => {
              const item = sale.items.find((i) => i.id === it.saleItemId);
              if (!item)
                throw unprocessable(
                  'INVALID_REFERENCE',
                  'Not a line of this sale.',
                  `items.${n}.saleItemId`,
                );
              const qty = new Decimal(it.qty);
              if (
                qty.decimalPlaces() > 3 ||
                (item.qty.decimalPlaces() === 0 && qty.decimalPlaces() > 0)
              )
                throw unprocessable(
                  'INVALID_QTY',
                  `${item.name} was sold in whole units.`,
                  `items.${n}.qty`,
                );
              const left = item.qty.minus(item.returnedQty);
              if (qty.gt(left))
                throw unprocessable(
                  'OVER_RETURN',
                  `Only ${left.toFixed(3)} of ${item.name} can still be returned.`,
                  `items.${n}.qty`,
                );
              const amount = r2(item.final.times(qty).dividedBy(item.qty));
              const rate = item.gstRate.plus(item.cessRate);
              const taxable = rate.isZero()
                ? amount
                : r2(amount.times(HUNDRED).dividedBy(HUNDRED.plus(rate)));
              const tax = amount.minus(taxable);
              const gst = rate.isZero()
                ? ZERO
                : r2(tax.times(item.gstRate).dividedBy(rate));
              return {
                item,
                qty,
                amount,
                taxable,
                gst,
                cess: tax.minus(gst),
                resaleable: it.resaleable ?? !NOT_RESALEABLE.has(input.reason),
              };
            });

            const exact = lines.reduce((s, l) => s.plus(l.amount), ZERO);
            const emptiesInvoice = sale.items.every((i) => {
              const l = lines.find((x) => x.item.id === i.id);
              return i.qty
                .minus(i.returnedQty)
                .minus(l?.qty ?? 0)
                .lte(0);
            });
            const refund = emptiesInvoice
              ? sale.payable.minus(sale.refunded)
              : Decimal.min(
                  exact.toDecimalPlaces(0, Decimal.ROUND_HALF_UP),
                  sale.payable.minus(sale.refunded),
                );
            const limits = await salesLimits(tx, auth.tenantId);
            const approvedBy = refund.gt(limits.returnWithoutManager)
              ? authorise(
                  auth,
                  approver,
                  'sales:void',
                  sale.storeId,
                  `A refund above ₹${limits.returnWithoutManager.toFixed(0)}`,
                )
              : null;

            const gst = lines.reduce((s, l) => s.plus(l.gst), ZERO);
            const cgst = sale.interState ? ZERO : r2(gst.dividedBy(2));
            const store = counter.store;
            const businessDate = todayIn(store.timezone);
            const creditNoteNo = await nextDocumentNo(
              tx,
              auth.tenantId,
              counter,
              businessDate,
              'CN',
            );
            const ret = await tx.saleReturn.create({
              data: {
                tenantId: auth.tenantId,
                saleId: sale.id,
                storeId: sale.storeId,
                counterId: counter.id,
                cashSessionId: session?.id ?? null,
                creditNoteNo,
                reason: input.reason,
                note: input.note ?? null,
                taxable: lines.reduce((s, l) => s.plus(l.taxable), ZERO),
                cgst,
                sgst: sale.interState ? ZERO : gst.minus(cgst),
                igst: sale.interState ? gst : ZERO,
                cess: lines.reduce((s, l) => s.plus(l.cess), ZERO),
                total: exact,
                refundMethod: input.refundMethod,
                refundAmount: refund,
                refundStatus:
                  input.refundMethod === 'CASH' ||
                  input.refundMethod === 'CREDIT'
                    ? 'COMPLETED'
                    : 'PENDING',
                refundReference: input.refundReference ?? null,
                approvedByUserId: approvedBy,
                createdByUserId: auth.userId,
                businessDate: dateOnly(businessDate),
              },
            });
            // Back onto the customer's account (what they owe goes down).
            if (input.refundMethod === 'CREDIT' && refund.gt(0))
              await postCustomerTxn(tx, {
                tenantId: auth.tenantId,
                customerId: sale.customerId!,
                type: 'RETURN',
                amount: refund.negated(),
                date: dateOnly(businessDate),
                refType: 'SALE_RETURN',
                refId: ret.id,
                refNo: creditNoteNo,
                userId: auth.userId,
              });
            await tx.saleReturnItem.createMany({
              data: lines.map((l) => ({
                tenantId: auth.tenantId,
                returnId: ret.id,
                saleItemId: l.item.id,
                qty: l.qty,
                amount: l.amount,
                taxable: l.taxable,
                tax: l.gst.plus(l.cess),
                resaleable: l.resaleable,
              })),
            });
            for (const l of lines)
              await tx.saleItem.update({
                where: { id: l.item.id },
                data: { returnedQty: { increment: l.qty } },
              });
            const refunded = sale.refunded.plus(refund);
            await tx.sale.update({
              where: { id: sale.id },
              data: {
                refunded,
                ...(refunded.gte(sale.payable) && {
                  paymentStatus: 'REFUNDED',
                }),
              },
            });

            // Stock back to the batches it left from, at the cost it left with.
            const products = await tx.product.findMany({
              where: {
                tenantId: auth.tenantId,
                id: { in: lines.map((l) => l.item.productId) },
              },
              select: { id: true, trackInventory: true },
            });
            const stocked = new Set(
              products.filter((p) => p.trackInventory).map((p) => p.id),
            );
            const out = await tx.stockMovement.findMany({
              where: {
                tenantId: auth.tenantId,
                refType: 'SALE',
                refId: sale.id,
              },
              orderBy: { seq: 'asc' },
            });
            const ledgerLines: LedgerLine[] = [];
            for (const l of lines.filter((x) =>
              stocked.has(x.item.productId),
            )) {
              let left = l.qty;
              const sources = out.filter(
                (m) => m.productId === l.item.productId,
              );
              for (const m of sources) {
                if (left.lte(0)) break;
                const take = Decimal.min(left, m.qty.negated());
                ledgerLines.push({
                  productId: m.productId,
                  batchId: m.batchId,
                  qty: take,
                  type: 'SALE_RETURN',
                  unitCost: m.unitCost,
                  reason: input.reason,
                  note: creditNoteNo,
                });
                if (!l.resaleable)
                  ledgerLines.push({
                    productId: m.productId,
                    batchId: m.batchId,
                    qty: take.negated(),
                    type: 'WRITE_OFF',
                    unitCost: m.unitCost,
                    reason: input.reason,
                    note: creditNoteNo,
                  });
                left = left.minus(take);
              }
            }
            await this.ledger.post(tx, {
              tenantId: auth.tenantId,
              storeId: sale.storeId,
              refType: 'SALE_RETURN',
              refId: ret.id,
              userId: auth.userId,
              lines: ledgerLines,
            });

            // The credit note as printed.
            const tenant = await tx.tenant.findUniqueOrThrow({
              where: { id: auth.tenantId },
            });
            const base = await this.sales.document(tx, sale, tenant, store);
            const doc: InvoiceDocument = {
              ...base,
              kind: 'CREDIT_NOTE',
              title: 'CREDIT NOTE',
              number: creditNoteNo,
              against: sale.invoiceNo,
              issuedAt: ret.createdAt.toISOString(),
              lines: lines.map((l) => ({
                lineNo: l.item.lineNo,
                name: l.item.name,
                sku: l.item.sku,
                hsn: l.item.hsnCode,
                qty: l.qty.toFixed(l.qty.decimalPlaces() ? 3 : 0),
                unit: l.item.unitCode,
                unitPrice: r2(l.item.final.dividedBy(l.item.qty)).toFixed(2),
                mrp: l.item.mrp?.toFixed(2) ?? null,
                discount: '0.00',
                amount: l.amount.toFixed(2),
                gstRate: Number(l.item.gstRate),
              })),
              slabs: [],
              totals: {
                gross: exact.toFixed(2),
                discount: '0.00',
                taxable: ret.taxable.toFixed(2),
                cgst: ret.cgst.toFixed(2),
                sgst: ret.sgst.toFixed(2),
                igst: ret.igst.toFixed(2),
                cess: ret.cess.toFixed(2),
                roundOff: refund.minus(exact).toFixed(2),
                total: refund.toFixed(2),
              },
              payments: [
                {
                  method: input.refundMethod,
                  amount: refund.toFixed(2),
                  status:
                    input.refundMethod === 'CASH' ||
                    input.refundMethod === 'CREDIT'
                      ? 'SUCCEEDED'
                      : 'PENDING_VERIFICATION',
                  reference: input.refundReference ?? null,
                },
              ],
              change: '0.00',
              footer: [
                `Reason: ${input.reason.toLowerCase().replace('_', ' ')}`,
              ],
            };
            await tx.invoice.create({
              data: {
                tenantId: auth.tenantId,
                kind: 'CREDIT_NOTE',
                number: creditNoteNo,
                saleId: sale.id,
                returnId: ret.id,
                issuedAt: ret.createdAt,
                document: doc as unknown as Prisma.InputJsonValue,
              },
            });
            await this.audit.record(
              {
                tenantId: auth.tenantId,
                actorUserId: auth.userId,
                action: 'sale.returned',
                entity: 'sale',
                entityId: sale.id,
                data: {
                  creditNoteNo,
                  refund: refund.toFixed(2),
                  method: input.refundMethod,
                  approvedBy,
                },
                meta,
              },
              tx,
            );
            return {
              ...(await this.view(tx, ret.id)),
              sale: this.sales.view(
                auth,
                await this.sales.load(tx, auth, sale.id),
              ),
            };
          },
        ),
      { timeout: 30_000 },
    );
  }

  private async view(tx: Tx, id: string) {
    const r = await tx.saleReturn.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });
    return {
      id: r.id,
      creditNoteNo: r.creditNoteNo,
      saleId: r.saleId,
      reason: r.reason,
      note: r.note,
      totals: {
        taxable: r.taxable.toFixed(2),
        cgst: r.cgst.toFixed(2),
        sgst: r.sgst.toFixed(2),
        igst: r.igst.toFixed(2),
        cess: r.cess.toFixed(2),
        total: r.total.toFixed(2),
      },
      refund: {
        method: r.refundMethod,
        amount: r.refundAmount.toFixed(2),
        status: r.refundStatus,
        reference: r.refundReference,
      },
      approvedByUserId: r.approvedByUserId,
      items: r.items.map((i) => ({
        saleItemId: i.saleItemId,
        qty: i.qty.toFixed(3),
        amount: i.amount.toFixed(2),
        resaleable: i.resaleable,
      })),
      createdAt: r.createdAt,
    };
  }
}
