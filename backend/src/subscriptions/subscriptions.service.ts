import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Decimal } from '../common/decimal.js';
import { AppException } from '../common/errors/app-exception.js';
import { assertPermission, type AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type {
  BillingInterval,
  Plan,
  Prisma,
  Subscription,
  SubscriptionInvoice,
} from '../generated/prisma/client.js';
import { fyOf } from '../sales/bill-math.js';
import { todayIn } from '../sales/sales.common.js';
import {
  GRACE_DAYS,
  limitsOf,
  standing,
  usage,
} from './subscription-policy.js';
import {
  PAYMENT_GATEWAY,
  type GatewayEvent,
  type PaymentGateway,
} from './payment-gateway.js';

/** GST on the SaaS fee (software services, SAC 998314). */
const GST_PCT = new Decimal(18);
const DAY = 86_400_000;

const money = (d: Decimal) => d.toFixed(2);
const priceOf = (p: Plan, interval: BillingInterval) =>
  interval === 'YEARLY' ? p.priceYearly : p.priceMonthly;

export function addInterval(from: Date, interval: BillingInterval) {
  const d = new Date(from);
  if (interval === 'YEARLY') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

const planView = (p: Plan) => ({
  code: p.code,
  name: p.name,
  description: p.description,
  priceMonthly: money(p.priceMonthly),
  priceYearly: money(p.priceYearly),
  gstPct: Number(GST_PCT),
  limits: limitsOf(p),
  features: p.features,
});

const invoiceView = (i: SubscriptionInvoice & { plan: Plan }) => ({
  id: i.id,
  number: i.number,
  plan: { code: i.plan.code, name: i.plan.name },
  interval: i.interval,
  amount: money(i.amount),
  gst: money(i.gst),
  total: money(i.total),
  currency: i.currency,
  status: i.status,
  periodStart: i.periodStart,
  periodEnd: i.periodEnd,
  provider: i.provider,
  paidAt: i.paidAt,
  failureReason: i.failureReason,
  createdAt: i.createdAt,
});

const conflict = (code: string, message: string) =>
  new AppException(code, message, HttpStatus.CONFLICT);

/**
 * SaaS subscription of a business (Phase 10): plan, trial, paid periods, cancellation, invoices.
 *
 * Money is only ever taken as "paid" from a **verified provider webhook** — never from the
 * browser. Paying an invoice for the same plan extends the paid period from its current end;
 * paying for another plan switches at once and carries the unused days of the old period over,
 * valued at the new plan's price. What applies now (trial over, in grace, lapsed) is worked out
 * from the dates on every request (`standing()`), so no scheduler is needed.
 */
@Injectable()
export class SubscriptionsService {
  private readonly log = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async plans() {
    const rows = await this.prisma.plan.findMany({
      where: { isActive: true, isPublic: true },
      orderBy: { sortOrder: 'asc' },
    });
    return { data: rows.map(planView), gateway: this.gateway.name };
  }

  private async load(tx: Tx, tenantId: string) {
    const s = await tx.subscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    if (!s)
      throw new AppException(
        'NOT_FOUND',
        'This business has no subscription.',
        HttpStatus.NOT_FOUND,
      );
    return s;
  }

  private async view(
    tx: Tx,
    tenantId: string,
    s: Subscription & { plan: Plan },
  ) {
    const now = standing(s);
    const used = await usage(tx, tenantId);
    const limits = limitsOf(s.plan);
    return {
      plan: planView(s.plan),
      interval: s.interval,
      status: now.status,
      writable: now.writable,
      trialEndsAt: s.trialEndsAt,
      currentPeriodStart: s.currentPeriodStart,
      currentPeriodEnd: s.currentPeriodEnd,
      endsAt: now.endsAt,
      graceEndsAt: now.graceEndsAt,
      graceDays: GRACE_DAYS,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      usage: used,
      limits,
      atLimit: {
        branches: used.branches >= limits.branches,
        counters: used.counters >= limits.counters,
        users: used.users >= limits.users,
      },
    };
  }

  /** The plan, what applies now, and usage against the plan's limits. Any member may see it. */
  current(auth: AuthContext) {
    assertPermission(auth, 'tenant:read');
    return this.prisma.withTenant(auth.tenantId, async (tx) =>
      this.view(tx, auth.tenantId, await this.load(tx, auth.tenantId)),
    );
  }

  invoices(auth: AuthContext) {
    assertPermission(auth, 'subscription:manage');
    return this.prisma.withTenant(auth.tenantId, async (tx) => ({
      data: (
        await tx.subscriptionInvoice.findMany({
          where: { tenantId: auth.tenantId },
          include: { plan: true },
          orderBy: { createdAt: 'desc' },
          take: 100,
        })
      ).map(invoiceView),
    }));
  }

  /**
   * Starts paying for a plan and interval: an invoice (plan price + 18% GST) and a provider order
   * the browser completes. Moving to a smaller plan than what's in use is refused.
   */
  async checkout(
    auth: AuthContext,
    input: { plan: string; interval: BillingInterval },
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'subscription:manage');
    const prepared = await this.prisma.withTenant(auth.tenantId, async (tx) => {
      const sub = await this.load(tx, auth.tenantId);
      const plan = await tx.plan.findUnique({ where: { code: input.plan } });
      if (!plan?.isActive)
        throw new AppException(
          'NOT_FOUND',
          'No such plan.',
          HttpStatus.NOT_FOUND,
        );
      const used = await usage(tx, auth.tenantId);
      const limits = limitsOf(plan);
      const over = (Object.keys(limits) as (keyof typeof limits)[]).filter(
        (k) => used[k] > limits[k],
      );
      if (over.length)
        throw new AppException(
          'PLAN_TOO_SMALL',
          `The ${plan.name} plan allows fewer ${over.join(', ')} than the business uses now. Close some first.`,
          HttpStatus.CONFLICT,
          over.map((k) => ({
            field: k,
            issue: `uses ${used[k]}, plan allows ${limits[k]}`,
          })),
        );
      // An unfinished checkout is replaced by this one.
      await tx.subscriptionInvoice.updateMany({
        where: { tenantId: auth.tenantId, status: 'OPEN' },
        data: { status: 'VOID' },
      });
      const amount = priceOf(plan, input.interval);
      const gst = amount
        .times(GST_PCT)
        .dividedBy(100)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const [seq] = await tx.$queryRaw<
        { n: bigint }[]
      >`SELECT nextval('subscription_invoice_seq') AS n`;
      const number = `SUB/${fyOf(todayIn('Asia/Kolkata'))}/${String(seq!.n).padStart(6, '0')}`;
      return tx.subscriptionInvoice.create({
        data: {
          tenantId: auth.tenantId,
          subscriptionId: sub.id,
          number,
          planId: plan.id,
          interval: input.interval,
          amount,
          gst,
          total: amount.plus(gst),
          provider: this.gateway.name,
          createdByUserId: auth.userId,
        },
        include: { plan: true },
      });
    });

    // Outside the transaction: an external call. If it fails the invoice stays OPEN without an
    // order, and the next checkout voids it.
    const order = await this.gateway.createOrder({
      amount: Number(prepared.total.times(100).toFixed(0)),
      currency: prepared.currency,
      receipt: prepared.number,
      notes: { tenantId: auth.tenantId, invoiceId: prepared.id },
    });
    const invoice = await this.prisma.withTenant(auth.tenantId, async (tx) => {
      const i = await tx.subscriptionInvoice.update({
        where: { id: prepared.id },
        data: { providerOrderId: order.orderId },
        include: { plan: true },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'subscription.checkout',
          entity: 'subscription_invoice',
          entityId: i.id,
          data: {
            number: i.number,
            plan: input.plan,
            interval: input.interval,
            total: money(i.total),
          },
          meta,
        },
        tx,
      );
      return i;
    });
    return {
      invoice: invoiceView(invoice),
      checkout: { provider: this.gateway.name, ...order.checkout },
    };
  }

  /** Don't renew: everything works until the end of the trial or paid period, then read-only. */
  cancel(auth: AuthContext, meta: RequestMeta) {
    return this.setRenewal(auth, true, meta);
  }

  /** Changed one's mind before the period ended. */
  resume(auth: AuthContext, meta: RequestMeta) {
    return this.setRenewal(auth, false, meta);
  }

  private setRenewal(auth: AuthContext, cancel: boolean, meta: RequestMeta) {
    assertPermission(auth, 'subscription:manage');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.load(tx, auth.tenantId);
      const now = standing(cur);
      if (!cancel && !['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(now.status))
        throw conflict(
          'INVALID_STATE',
          'The subscription has ended — renew it by paying instead.',
        );
      if (cancel && !['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(now.status))
        throw conflict('INVALID_STATE', 'The subscription has already ended.');
      const s = await tx.subscription.update({
        where: { id: cur.id },
        data: {
          cancelAtPeriodEnd: cancel,
          cancelledAt: cancel ? new Date() : null,
        },
        include: { plan: true },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: cancel
            ? 'subscription.cancel_requested'
            : 'subscription.resumed',
          entity: 'subscription',
          entityId: s.id,
          data: { endsAt: now.endsAt?.toISOString() ?? null },
          meta,
        },
        tx,
      );
      return this.view(tx, auth.tenantId, s);
    });
  }

  /* ---------- provider webhooks ---------- */

  /**
   * A webhook from the payment provider. Unverifiable ones are recorded and refused (401). Each
   * provider event is processed once (`payment_webhook_events`): a redelivery returns 200 without
   * doing anything again; an event whose processing failed is processed again on redelivery.
   */
  async webhook(
    provider: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ) {
    if (provider !== this.gateway.name || !rawBody)
      throw new AppException(
        'NOT_FOUND',
        'Unknown payment provider.',
        HttpStatus.NOT_FOUND,
      );
    const event = this.gateway.parseWebhook(rawBody, headers);
    let payload: Prisma.InputJsonValue;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue;
    } catch {
      payload = { raw: rawBody.toString('utf8').slice(0, 2000) };
    }
    if (!event) {
      await this.prisma.paymentWebhookEvent.create({
        data: {
          provider,
          eventId: `unverified-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type: 'unverified',
          signatureValid: false,
          payload,
          result: 'refused: bad signature',
        },
      });
      throw new AppException(
        'INVALID_SIGNATURE',
        'Signature check failed.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.prisma.$executeRaw`
      INSERT INTO payment_webhook_events (id, provider, event_id, type, signature_valid, payload)
      VALUES (gen_random_uuid(), ${provider}, ${event.id}, ${event.type}, true, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (provider, event_id) DO NOTHING`;
    const row = await this.prisma.paymentWebhookEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider, eventId: event.id } },
    });
    if (row.processedAt)
      return { received: true, duplicate: true, result: row.result };

    let result: string;
    try {
      result = await this.apply(event);
    } catch (e) {
      await this.prisma.paymentWebhookEvent.update({
        where: { id: row.id },
        data: { error: (e as Error).message.slice(0, 500) },
      });
      this.log.error(
        `webhook ${provider}/${event.id} failed: ${(e as Error).message}`,
      );
      throw e; // 5xx: the provider redelivers, and it's processed again
    }
    await this.prisma.paymentWebhookEvent.update({
      where: { id: row.id },
      data: { processedAt: new Date(), result, error: null },
    });
    return { received: true, duplicate: false, result };
  }

  private async apply(e: GatewayEvent): Promise<string> {
    if (e.kind === 'IGNORED') return `ignored: ${e.type}`;
    const tenantId = e.notes['tenantId'];
    if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId) || !e.orderId)
      return 'ignored: not a subscription payment';
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM subscription_invoices
        WHERE tenant_id = ${tenantId}::uuid AND provider_order_id = ${e.orderId} FOR UPDATE`;
      if (!locked) return `ignored: no invoice for order ${e.orderId}`;
      const inv = await tx.subscriptionInvoice.findUniqueOrThrow({
        where: { id: locked.id },
        include: { plan: true, subscription: { include: { plan: true } } },
      });

      if (e.kind === 'FAILED') {
        if (inv.status !== 'OPEN')
          return `ignored: ${inv.number} is ${inv.status}`;
        await tx.subscriptionInvoice.update({
          where: { id: inv.id },
          data: {
            status: 'FAILED',
            failureReason: e.reason ?? null,
            providerPaymentId: e.paymentId ?? null,
          },
        });
        await this.audit.record(
          {
            tenantId,
            action: 'subscription.payment_failed',
            entity: 'subscription_invoice',
            entityId: inv.id,
            data: { number: inv.number, reason: e.reason ?? null },
          },
          tx,
        );
        return `${inv.number} payment failed`;
      }

      // PAID — once per invoice, for the exact amount.
      if (inv.status === 'PAID') return `ignored: ${inv.number} already paid`;
      const expected = Number(inv.total.times(100).toFixed(0));
      if (e.amount !== expected || (e.currency ?? 'INR') !== inv.currency) {
        await this.audit.record(
          {
            tenantId,
            action: 'subscription.payment_mismatch',
            entity: 'subscription_invoice',
            entityId: inv.id,
            data: {
              number: inv.number,
              expected,
              got: e.amount ?? null,
              currency: e.currency ?? null,
            },
          },
          tx,
        );
        return `refused: ${inv.number} expected ${expected} paise, got ${e.amount ?? '?'}`;
      }

      const sub = inv.subscription;
      const now = new Date();
      const live = standing(sub, now);
      const paidUntil =
        sub.status === 'ACTIVE' &&
        sub.currentPeriodEnd &&
        sub.currentPeriodEnd > now
          ? sub.currentPeriodEnd
          : null;
      let start = now;
      let end: Date;
      if (
        paidUntil &&
        inv.planId === sub.planId &&
        inv.interval === sub.interval
      ) {
        // Renewal: the new period follows the current one.
        start = paidUntil;
        end = addInterval(start, inv.interval);
      } else {
        end = addInterval(now, inv.interval);
        // Switching plan: unused paid days carry over, valued at the new plan's price.
        if (paidUntil) {
          const oldDaily = priceOf(sub.plan, sub.interval).dividedBy(
            (addInterval(now, sub.interval).getTime() - now.getTime()) / DAY,
          );
          const newDaily = priceOf(inv.plan, inv.interval).dividedBy(
            (end.getTime() - now.getTime()) / DAY,
          );
          const leftDays = (paidUntil.getTime() - now.getTime()) / DAY;
          const credit = newDaily.gt(0)
            ? oldDaily.times(leftDays).dividedBy(newDaily)
            : new Decimal(0);
          end = new Date(end.getTime() + Math.floor(Number(credit)) * DAY);
        }
      }
      await tx.subscriptionInvoice.update({
        where: { id: inv.id },
        data: {
          status: 'PAID',
          paidAt: now,
          providerPaymentId: e.paymentId ?? null,
          periodStart: start,
          periodEnd: end,
        },
      });
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          planId: inv.planId,
          interval: inv.interval,
          status: 'ACTIVE',
          currentPeriodStart: start,
          currentPeriodEnd: end,
          cancelAtPeriodEnd: false,
          cancelledAt: null,
        },
      });
      await this.audit.record(
        {
          tenantId,
          action: 'subscription.paid',
          entity: 'subscription_invoice',
          entityId: inv.id,
          data: {
            number: inv.number,
            plan: inv.plan.code,
            interval: inv.interval,
            periodEnd: end.toISOString(),
            was: live.status,
          },
        },
        tx,
      );
      return `${inv.number} paid: ${inv.plan.code} until ${end.toISOString().slice(0, 10)}`;
    });
  }
}
