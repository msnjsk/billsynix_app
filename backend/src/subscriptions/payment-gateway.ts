import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/errors/app-exception.js';
import type { Env } from '../config/env.js';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** A provider webhook, verified and reduced to what billing needs. */
export type GatewayEvent = {
  /** The provider's id for this event (idempotency). */
  id: string;
  type: string;
  kind: 'PAID' | 'FAILED' | 'IGNORED';
  orderId?: string;
  paymentId?: string;
  /** Smallest currency unit (paise). */
  amount?: number;
  currency?: string;
  /** What we attached when creating the order (tenantId, invoiceId). */
  notes: Record<string, string>;
  reason?: string;
};

export interface PaymentGateway {
  readonly name: string;
  readonly configured: boolean;
  /** Creates a payment order; `checkout` is what the browser's payment widget needs. */
  createOrder(o: {
    amount: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<{ orderId: string; checkout: Record<string, unknown> }>;
  /** null when the signature doesn't match (the request is not from the provider). */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): GatewayEvent | null;
}

const header = (
  h: Record<string, string | string[] | undefined>,
  k: string,
) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

/** No gateway yet: checkout explains that, and no webhook is trusted. */
export class NoGateway implements PaymentGateway {
  readonly name = 'none';
  readonly configured = false;
  createOrder(): Promise<never> {
    return Promise.reject(
      new AppException(
        'PAYMENTS_NOT_CONFIGURED',
        'Online payment is not set up yet. Contact support to renew.',
        HttpStatus.SERVICE_UNAVAILABLE,
      ),
    );
  }
  parseWebhook(): null {
    return null;
  }
}

type RzpEntity = {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  notes?: Record<string, string> | unknown[];
  error_description?: string;
};

/**
 * Razorpay: orders through its REST API; webhooks signed with HMAC-SHA256 of the raw body using
 * the webhook secret (`X-Razorpay-Signature`). A browser "payment succeeded" callback is never
 * treated as proof — only a verified webhook marks an invoice paid.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay';
  readonly configured = true;

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
  ) {}

  async createOrder(o: {
    amount: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }) {
    let res: Response;
    try {
      res = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
        },
        body: JSON.stringify(o),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AppException(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        'The payment provider could not be reached. Try again in a minute.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    if (!res.ok || !body.id)
      throw new AppException(
        'PAYMENT_PROVIDER_ERROR',
        'The payment provider refused to start this payment.',
        HttpStatus.BAD_GATEWAY,
      );
    return {
      orderId: body.id,
      checkout: {
        keyId: this.keyId,
        orderId: body.id,
        amount: o.amount,
        currency: o.currency,
      },
    };
  }

  /** Signature over the exact bytes received (re-serialised JSON would not match). */
  sign(rawBody: Buffer) {
    return createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): GatewayEvent | null {
    const given = header(headers, 'x-razorpay-signature') ?? '';
    const expected = Buffer.from(this.sign(rawBody), 'hex');
    const got = /^[0-9a-f]{64}$/i.test(given)
      ? Buffer.from(given, 'hex')
      : Buffer.alloc(0);
    if (got.length !== expected.length || !timingSafeEqual(got, expected))
      return null;

    let body: {
      event?: string;
      payload?: {
        payment?: { entity?: RzpEntity };
        order?: { entity?: RzpEntity };
      };
    };
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    const type = body.event ?? 'unknown';
    const payment = body.payload?.payment?.entity ?? {};
    const order = body.payload?.order?.entity ?? {};
    const notesOf = (e: RzpEntity) =>
      e.notes && !Array.isArray(e.notes)
        ? (e.notes as Record<string, string>)
        : {};
    const id =
      header(headers, 'x-razorpay-event-id') ??
      createHash('sha256').update(rawBody).digest('hex');
    const base = {
      id,
      type,
      ...(payment.id ? { paymentId: payment.id } : {}),
      ...((payment.order_id ?? order.id)
        ? { orderId: (payment.order_id ?? order.id)! }
        : {}),
      ...((payment.amount ?? order.amount) !== undefined
        ? { amount: (payment.amount ?? order.amount)! }
        : {}),
      ...((payment.currency ?? order.currency)
        ? { currency: (payment.currency ?? order.currency)! }
        : {}),
      notes: { ...notesOf(order), ...notesOf(payment) },
    };
    if (type === 'payment.captured' || type === 'order.paid')
      return { ...base, kind: 'PAID' };
    if (type === 'payment.failed')
      return {
        ...base,
        kind: 'FAILED',
        reason: payment.error_description ?? 'Payment failed',
      };
    return { ...base, kind: 'IGNORED' };
  }
}

export function gatewayFromEnv(env: Env): PaymentGateway {
  return env.PAYMENT_PROVIDER === 'razorpay'
    ? new RazorpayGateway(
        env.RAZORPAY_KEY_ID!,
        env.RAZORPAY_KEY_SECRET!,
        env.RAZORPAY_WEBHOOK_SECRET!,
      )
    : new NoGateway();
}
