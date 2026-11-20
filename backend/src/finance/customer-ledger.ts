import { HttpStatus } from '@nestjs/common';
import type { Tx } from '../database/prisma.service.js';
import { Decimal } from '../common/decimal.js';
import { AppException } from '../common/errors/app-exception.js';
import type { CustomerTxnType } from '../generated/prisma/client.js';

/**
 * The only code that changes what a customer owes: appends a ledger row and moves the balance,
 * in the caller's transaction. `amount` is signed (+ they owe more).
 */
export async function postCustomerTxn(
  tx: Tx,
  e: {
    tenantId: string;
    customerId: string;
    type: CustomerTxnType;
    amount: Decimal;
    date: Date;
    refType: string;
    refId: string;
    refNo: string;
    note?: string | null;
    userId?: string | null;
  },
) {
  const [row] = await tx.$queryRaw<{ balance: Decimal }[]>`
    UPDATE customers SET balance = balance + ${e.amount.toFixed(2)}::numeric, updated_at = now()
    WHERE id = ${e.customerId}::uuid AND tenant_id = ${e.tenantId}::uuid
    RETURNING balance`;
  if (!row)
    throw new AppException(
      'NOT_FOUND',
      'Customer not found.',
      HttpStatus.NOT_FOUND,
    );
  return tx.customerTransaction.create({
    data: {
      tenantId: e.tenantId,
      customerId: e.customerId,
      type: e.type,
      amount: e.amount,
      balanceAfter: row.balance,
      date: e.date,
      refType: e.refType,
      refId: e.refId,
      refNo: e.refNo,
      note: e.note ?? null,
      userId: e.userId ?? null,
    },
  });
}

/**
 * The customer a sale is for, locked; with a credit amount, checks they may owe that much more
 * (balance + credit ≤ credit limit).
 */
export async function customerForSale(
  tx: Tx,
  tenantId: string,
  customerId: string,
  credit: Decimal,
) {
  const [c] = await tx.$queryRaw<
    {
      id: string;
      name: string;
      phone: string | null;
      gstin: string | null;
      status: string;
      balance: Decimal;
      credit_limit: Decimal;
    }[]
  >`SELECT id::text, name, phone, gstin, status::text, balance, credit_limit FROM customers
    WHERE id = ${customerId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
  if (!c)
    throw new AppException(
      'INVALID_REFERENCE',
      'Customer not found.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      [{ field: 'customerId', issue: 'not found' }],
    );
  if (credit.gt(0)) {
    if (c.status !== 'ACTIVE')
      throw new AppException(
        'CUSTOMER_INACTIVE',
        `${c.name}'s account is closed.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    const balance = new Decimal(c.balance);
    const limit = new Decimal(c.credit_limit);
    if (balance.plus(credit).gt(limit))
      throw new AppException(
        'CREDIT_LIMIT',
        limit.isZero()
          ? `${c.name} has no credit allowed.`
          : `${c.name} can owe at most ₹${limit.toFixed(2)} and already owes ₹${balance.toFixed(2)}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'payments', issue: 'over credit limit' }],
      );
  }
  return c;
}
