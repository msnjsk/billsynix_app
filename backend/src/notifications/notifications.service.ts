import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { Decimal } from '../common/decimal.js';
import { can, canAccessStore, type AuthContext } from '../auth/auth-context.js';
import type { PermissionKey } from '../access/permissions.js';
import { AppException } from '../common/errors/app-exception.js';
import { HttpStatus } from '@nestjs/common';
import { receiptOutstanding } from '../purchasing/purchasing.common.js';
import { standing } from '../subscriptions/subscription-policy.js';

const DAY = 86_400_000;
/** How long a refresh is reused (per business) — the bell polls every ~30 s. */
const REFRESH_MS = process.env.NODE_ENV === 'test' ? 0 : 20_000;
const EXPIRY_DAYS = 14;
const KEEP_HISTORY_DAYS = 30;

export const listNotificationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(40),
  unread: z.coerce.boolean().optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;

type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

/** A condition found in the business's data right now. */
type Found = {
  key: string;
  kind: string;
  severity: Severity;
  title: string;
  body: string;
  link: string | null;
  permission: PermissionKey;
  storeId: string | null;
  /** Grows with the condition (items low, bills pending…); growing re-raises it. */
  weight: number;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const inr = (d: Decimal | number) => `₹${Number(d).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const listNames = (names: string[], max = 3) =>
  names.slice(0, max).join(', ') + (names.length > max ? ` and ${names.length - max} more` : '');

/**
 * Notifications for the bell and desktop pop-ups.
 *
 * Rather than every module writing notifications, this reads the business's own data (stock,
 * orders, drawers, payments, supplier bills, subscription, staff) and keeps one row per condition
 * in step with it: raised when it appears, updated as it changes, re-raised when it grows, and
 * resolved when it clears. A refresh runs at most every 20 s per business, when someone checks.
 */
@Injectable()
export class NotificationsService {
  private readonly lastRefresh = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  /* ---------- reading ---------- */

  async list(auth: AuthContext, q: ListNotificationsQuery) {
    await this.refresh(auth.tenantId);
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const since = new Date(Date.now() - KEEP_HISTORY_DAYS * DAY);
      const rows = await tx.notification.findMany({
        where: { tenantId: auth.tenantId, OR: [{ resolvedAt: null }, { raisedAt: { gte: since } }] },
        include: { reads: { where: { userId: auth.userId } } },
        orderBy: [{ raisedAt: 'desc' }, { id: 'asc' }],
        take: 300,
      });
      const mine = rows.filter((n) => this.visible(auth, n));
      const view = mine.map((n) => {
        const read = n.reads.some((r) => r.readAt >= n.raisedAt);
        return {
          id: n.id,
          kind: n.kind,
          severity: n.severity,
          title: n.title,
          body: n.body,
          link: n.link,
          storeId: n.storeId,
          raisedAt: n.raisedAt,
          resolvedAt: n.resolvedAt,
          active: n.resolvedAt === null,
          read,
        };
      });
      const unread = view.filter((n) => n.active && !n.read).length;
      const data = (q.unread ? view.filter((n) => n.active && !n.read) : view).slice(0, q.limit);
      return { data, unread, serverTime: new Date() };
    });
  }

  async markRead(auth: AuthContext, id: string) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const n = await tx.notification.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!n || !this.visible(auth, n))
        throw new AppException('NOT_FOUND', 'Notification not found.', HttpStatus.NOT_FOUND);
      await tx.notificationRead.upsert({
        where: { notificationId_userId: { notificationId: id, userId: auth.userId } },
        create: { tenantId: auth.tenantId, notificationId: id, userId: auth.userId },
        update: { readAt: new Date() },
      });
      return { id, read: true };
    });
  }

  async markAllRead(auth: AuthContext) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.notification.findMany({ where: { tenantId: auth.tenantId, resolvedAt: null } });
      const ids = rows.filter((n) => this.visible(auth, n)).map((n) => n.id);
      const now = new Date();
      for (const notificationId of ids)
        await tx.notificationRead.upsert({
          where: { notificationId_userId: { notificationId, userId: auth.userId } },
          create: { tenantId: auth.tenantId, notificationId, userId: auth.userId, readAt: now },
          update: { readAt: now },
        });
      return { read: ids.length };
    });
  }

  private visible(auth: AuthContext, n: { permission: string; storeId: string | null }) {
    return can(auth, n.permission as PermissionKey) && (n.storeId === null || canAccessStore(auth, n.storeId));
  }

  /* ---------- keeping them in step with the data ---------- */

  /** Re-checks the business's data (at most every 20 s). `force` skips the wait. */
  async refresh(tenantId: string, force = false) {
    const last = this.lastRefresh.get(tenantId) ?? 0;
    if (!force && Date.now() - last < REFRESH_MS) return;
    this.lastRefresh.set(tenantId, Date.now());
    await this.prisma.withTenant(
      tenantId,
      async (tx) => {
        // One refresh at a time per business (two browsers polling at once).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'notifications:' + tenantId}))`;
        const found = await this.detect(tx, tenantId);
        const now = new Date();
        const existing = await tx.notification.findMany({ where: { tenantId } });
        const byKey = new Map(existing.map((n) => [n.dedupeKey, n]));
        for (const f of found) {
          const cur = byKey.get(f.key);
          const text = {
            kind: f.kind,
            severity: f.severity,
            title: f.title,
            body: f.body,
            link: f.link,
            permission: f.permission,
            storeId: f.storeId,
            weight: f.weight,
          };
          if (!cur) {
            await tx.notification.create({ data: { tenantId, dedupeKey: f.key, raisedAt: now, ...text } });
          } else if (cur.resolvedAt || f.weight > cur.weight || (f.severity === 'CRITICAL' && cur.severity !== 'CRITICAL')) {
            // Back again, or worse than before: raise it as new (unread for everyone, pops up).
            await tx.notification.update({ where: { id: cur.id }, data: { ...text, raisedAt: now, resolvedAt: null } });
          } else if (cur.title !== f.title || cur.body !== f.body || cur.weight !== f.weight || cur.severity !== f.severity) {
            await tx.notification.update({ where: { id: cur.id }, data: text });
          }
        }
        const live = new Set(found.map((f) => f.key));
        const cleared = existing.filter((n) => !n.resolvedAt && !live.has(n.dedupeKey)).map((n) => n.id);
        if (cleared.length) await tx.notification.updateMany({ where: { tenantId, id: { in: cleared } }, data: { resolvedAt: now } });
        await tx.notification.deleteMany({
          where: { tenantId, resolvedAt: { lt: new Date(now.getTime() - KEEP_HISTORY_DAYS * DAY) } },
        });
      },
      { timeout: 20_000 },
    );
  }

  /** Everything that deserves a notification right now. */
  private async detect(tx: Tx, tenantId: string): Promise<Found[]> {
    const out: Found[] = [];
    const now = new Date();
    const stores = await tx.store.findMany({ where: { tenantId }, select: { id: true, name: true, status: true } });
    const storeName = new Map(stores.map((s) => [s.id, s.name]));
    const at = (storeId: string) => (stores.length > 1 ? ` at ${storeName.get(storeId) ?? 'a branch'}` : '');
    const activeStores = new Set(stores.filter((s) => s.status === 'ACTIVE').map((s) => s.id));

    /* ----- stock: out of stock, low, expiring (per branch) ----- */
    const balances = await tx.stockBalance.findMany({
      where: { tenantId, product: { status: 'ACTIVE' } },
      select: { storeId: true, qty: true, reorderLevel: true, product: { select: { name: true } } },
    });
    const outBy = new Map<string, string[]>();
    const lowBy = new Map<string, string[]>();
    for (const b of balances) {
      if (!activeStores.has(b.storeId)) continue;
      if (b.qty.lte(0)) outBy.set(b.storeId, [...(outBy.get(b.storeId) ?? []), b.product.name]);
      else if (b.reorderLevel !== null && b.qty.lte(b.reorderLevel)) lowBy.set(b.storeId, [...(lowBy.get(b.storeId) ?? []), b.product.name]);
    }
    for (const [storeId, names] of outBy)
      out.push({
        key: `stock.out:${storeId}`,
        kind: 'stock.out',
        severity: 'CRITICAL',
        title: `${plural(names.length, 'product')} out of stock${at(storeId)}`,
        body: listNames(names.sort()),
        link: '/inventory',
        permission: 'inventory:adjust',
        storeId,
        weight: names.length,
      });
    for (const [storeId, names] of lowBy)
      out.push({
        key: `stock.low:${storeId}`,
        kind: 'stock.low',
        severity: 'WARNING',
        title: `${plural(names.length, 'product')} running low${at(storeId)}`,
        body: `${listNames(names.sort())} — at or below the reorder level.`,
        link: '/purchases',
        permission: 'inventory:adjust',
        storeId,
        weight: names.length,
      });

    const soon = new Date(now.getTime() + EXPIRY_DAYS * DAY);
    const batches = await tx.batchStock.findMany({
      where: { tenantId, qty: { gt: 0 }, batch: { expiryDate: { not: null, lte: soon } } },
      select: { storeId: true, batch: { select: { batchNo: true, expiryDate: true, product: { select: { name: true } } } } },
    });
    const expBy = new Map<string, { expired: string[]; soon: string[] }>();
    for (const b of batches) {
      if (!activeStores.has(b.storeId)) continue;
      const e = expBy.get(b.storeId) ?? { expired: [], soon: [] };
      const label = `${b.batch.product.name} (${b.batch.batchNo})`;
      if (b.batch.expiryDate! < now) e.expired.push(label);
      else e.soon.push(label);
      expBy.set(b.storeId, e);
    }
    for (const [storeId, e] of expBy) {
      const n = e.expired.length + e.soon.length;
      out.push({
        key: `stock.expiry:${storeId}`,
        kind: 'stock.expiry',
        severity: e.expired.length ? 'CRITICAL' : 'WARNING',
        title: e.expired.length
          ? `${plural(e.expired.length, 'batch', 'batches')} expired${at(storeId)}`
          : `${plural(n, 'batch', 'batches')} expire within ${EXPIRY_DAYS} days${at(storeId)}`,
        body: listNames([...e.expired, ...e.soon]) + (e.expired.length ? ' — take expired stock off the shelf.' : ' — sell these first.'),
        link: '/inventory',
        permission: 'inventory:read',
        storeId,
        weight: n,
      });
    }

    /* ----- orders & customers ----- */
    const orders = await tx.customerOrder.findMany({
      where: { tenantId, status: 'NEW', createdAt: { gte: new Date(now.getTime() - 3 * DAY) } },
      select: { id: true, number: true, storeId: true, customerName: true, total: true, fulfilment: true, slot: true },
    });
    for (const o of orders)
      out.push({
        key: `order.new:${o.id}`,
        kind: 'order.new',
        severity: 'INFO',
        title: `New ${o.fulfilment === 'DELIVERY' ? 'delivery' : 'pickup'} order ${o.number}`,
        body: `${o.customerName} · ${inr(o.total)} · ${o.slot}${at(o.storeId)}`,
        link: '/orders',
        permission: 'sales:read',
        storeId: o.storeId,
        weight: 1,
      });

    const overLimit = await tx.$queryRaw<{ name: string }[]>`
      SELECT name FROM customers
      WHERE tenant_id = ${tenantId}::uuid AND status = 'ACTIVE' AND credit_limit > 0 AND balance > credit_limit
      ORDER BY balance - credit_limit DESC LIMIT 50`;
    if (overLimit.length)
      out.push({
        key: 'khata.over_limit',
        kind: 'khata.over_limit',
        severity: 'WARNING',
        title: `${plural(overLimit.length, 'customer')} over their credit limit`,
        body: `${listNames(overLimit.map((c) => c.name))} — collect a payment before more credit.`,
        link: '/customers',
        permission: 'cash:reconcile',
        storeId: null,
        weight: overLimit.length,
      });

    /* ----- money & counters ----- */
    const review = await tx.cashSession.findMany({
      where: { tenantId, status: 'PENDING_REVIEW' },
      select: { id: true, storeId: true, variance: true, closedAt: true },
    });
    for (const s of review)
      out.push({
        key: `drawer.review:${s.id}`,
        kind: 'drawer.review',
        severity: 'WARNING',
        title: `Cash drawer closed ${s.variance?.isNegative() ? 'short' : 'over'} by ${inr(s.variance?.abs() ?? 0)}`,
        body: `Needs a manager to review and sign off${at(s.storeId)}.`,
        link: '/sales',
        permission: 'cash:reconcile',
        storeId: s.storeId,
        weight: 1,
      });

    const pending = await tx.salePayment.findMany({
      where: { tenantId, status: 'PENDING_VERIFICATION', sale: { status: 'COMPLETED' } },
      select: { amount: true, method: true, sale: { select: { storeId: true } } },
    });
    const pendBy = new Map<string, { n: number; sum: Decimal }>();
    for (const p of pending) {
      const e = pendBy.get(p.sale.storeId) ?? { n: 0, sum: new Decimal(0) };
      e.n++;
      e.sum = e.sum.plus(p.amount);
      pendBy.set(p.sale.storeId, e);
    }
    for (const [storeId, e] of pendBy)
      out.push({
        key: `payments.pending:${storeId}`,
        kind: 'payments.pending',
        severity: 'WARNING',
        title: `${plural(e.n, 'UPI/card payment')} waiting to be verified${at(storeId)}`,
        body: `${inr(e.sum)} isn't counted as received until it's checked against the bank.`,
        link: '/sales',
        permission: 'cash:reconcile',
        storeId,
        weight: e.n,
      });

    const failed = await tx.syncEvent.findMany({ where: { tenantId, status: 'FAILED' }, select: { storeId: true } });
    const failBy = new Map<string, number>();
    for (const f of failed) failBy.set(f.storeId, (failBy.get(f.storeId) ?? 0) + 1);
    for (const [storeId, n] of failBy)
      out.push({
        key: `sync.failed:${storeId}`,
        kind: 'sync.failed',
        severity: 'CRITICAL',
        title: `${plural(n, 'offline bill')} couldn't be recorded${at(storeId)}`,
        body: 'Made on a counter while offline and refused when it synced. Review and re-run or discard them.',
        link: '/pos',
        permission: 'cash:reconcile',
        storeId,
        weight: n,
      });

    /* ----- purchases & account ----- */
    const dueBy = new Date(now.getTime() + 3 * DAY);
    const grns = await tx.goodsReceipt.findMany({
      where: { tenantId, dueDate: { lte: dueBy } },
      select: { id: true, dueDate: true, supplier: { select: { name: true } } },
      orderBy: { dueDate: 'asc' },
      take: 500,
    });
    if (grns.length) {
      const owed = await receiptOutstanding(tx, tenantId, grns.map((g) => g.id));
      const open = grns.filter((g) => (owed.get(g.id) ?? new Decimal(0)).gt(0));
      const overdue = open.filter((g) => g.dueDate < new Date(now.toISOString().slice(0, 10)));
      const total = open.reduce((s, g) => s.plus(owed.get(g.id) ?? 0), new Decimal(0));
      if (open.length)
        out.push({
          key: 'supplier.due',
          kind: 'supplier.due',
          severity: overdue.length ? 'CRITICAL' : 'WARNING',
          title: overdue.length
            ? `${plural(overdue.length, 'supplier bill')} overdue`
            : `${plural(open.length, 'supplier bill')} due within 3 days`,
          body: `${inr(total)} to pay — ${listNames([...new Set(open.map((g) => g.supplier.name))])}.`,
          link: '/suppliers',
          permission: 'supplier-payments:write',
          storeId: null,
          weight: open.length + overdue.length,
        });
    }

    const received = await tx.goodsReceipt.findMany({
      where: { tenantId, createdAt: { gte: new Date(now.getTime() - 2 * DAY) } },
      select: { id: true, number: true, storeId: true, total: true, supplier: { select: { name: true } } },
    });
    for (const g of received)
      out.push({
        key: `grn.received:${g.id}`,
        kind: 'grn.received',
        severity: 'INFO',
        title: `Goods received from ${g.supplier.name}`,
        body: `${g.number} · ${inr(g.total)} added to stock${at(g.storeId)}.`,
        link: '/purchases',
        permission: 'purchases:write',
        storeId: g.storeId,
        weight: 1,
      });

    const sub = await tx.subscription.findUnique({ where: { tenantId }, include: { plan: { select: { name: true } } } });
    if (sub) {
      const st = standing(sub, now);
      const days = st.endsAt ? Math.ceil((st.endsAt.getTime() - now.getTime()) / DAY) : null;
      if (st.status === 'PAST_DUE' || st.status === 'EXPIRED' || st.status === 'SUSPENDED')
        out.push({
          key: 'subscription',
          kind: 'subscription',
          severity: 'CRITICAL',
          title: st.status === 'PAST_DUE' ? 'Subscription payment is overdue' : 'Subscription has lapsed — the app is read-only',
          body:
            st.status === 'PAST_DUE' && st.graceEndsAt
              ? `Renew by ${st.graceEndsAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} to keep billing.`
              : 'Renew the plan to bill and make changes again.',
          link: '/business-profile',
          permission: 'subscription:manage',
          storeId: null,
          weight: 2,
        });
      else if (days !== null && days <= 7 && !(sub.status === 'ACTIVE' && !sub.cancelAtPeriodEnd))
        out.push({
          key: 'subscription',
          kind: 'subscription',
          severity: 'WARNING',
          title: sub.status === 'TRIALING' ? `Free trial ends in ${plural(Math.max(days, 0), 'day')}` : `${sub.plan.name} plan ends in ${plural(Math.max(days, 0), 'day')}`,
          body: 'Choose a plan to keep billing without a break.',
          link: '/business-profile',
          permission: 'subscription:manage',
          storeId: null,
          weight: 1,
        });
    }

    const staff = await tx.membership.findMany({
      where: { tenantId, status: 'ACTIVE', createdAt: { gte: new Date(now.getTime() - 3 * DAY) } },
      select: { id: true, createdAt: true, user: { select: { name: true } }, roles: { select: { role: { select: { name: true, key: true } } } } },
    });
    for (const m of staff) {
      if (m.roles.some((r) => r.role.key === 'owner')) continue;
      out.push({
        key: `staff.added:${m.id}`,
        kind: 'staff.added',
        severity: 'INFO',
        title: `${m.user.name} joined the team`,
        body: `Added as ${m.roles.map((r) => r.role.name).join(', ') || 'staff'}.`,
        link: '/staff',
        permission: 'users:manage',
        storeId: null,
        weight: 1,
      });
    }
    return out;
  }
}
