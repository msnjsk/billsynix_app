import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppException } from '../common/errors/app-exception.js';
import type { SessionKind } from '../generated/prisma/client.js';
import type { RequestMeta } from './decorators.js';
import { ACCESS_TOKEN_TTL_SECONDS, TokenService } from './token.service.js';
import { newSecret, sameHash, sha256 } from './secrets.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Refresh lifetimes (ADR-005). PIN sessions last one shift on one device. */
export const SESSION_POLICY: Record<
  SessionKind,
  { refreshMs: number; familyMs: number }
> = {
  PASSWORD: { refreshMs: 14 * DAY, familyMs: 30 * DAY },
  PIN: { refreshMs: 12 * HOUR, familyMs: 16 * HOUR },
};

export type IssuedSession = {
  sessionId: string;
  familyId: string;
  kind: SessionKind;
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
};

type IssueInput = {
  userId: string;
  tenantId: string;
  membershipId: string;
  kind: SessionKind;
  deviceId?: string | null;
  meta: RequestMeta;
  /** Continue an existing family (rotation) instead of starting one. */
  family?: { id: string; expiresAt: Date };
};

const refreshFailed = (
  code = 'INVALID_REFRESH_TOKEN',
  message = 'Please sign in again.',
) => new AppException(code, message, HttpStatus.UNAUTHORIZED);

/** Refresh tokens are `<sessionId>.<secret>`; only SHA-256(secret) is stored. */
function parseRefresh(token: string): { id: string; secret: string } | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
  return m ? { id: m[1]!, secret: m[2]! } : null;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async issue(input: IssueInput, tx?: Tx): Promise<IssuedSession> {
    const db = tx ?? this.prisma;
    const now = Date.now();
    const policy = SESSION_POLICY[input.kind];
    const familyExpiresAt =
      input.family?.expiresAt ?? new Date(now + policy.familyMs);
    const expiresAt = new Date(
      Math.min(now + policy.refreshMs, familyExpiresAt.getTime()),
    );
    const id = randomUUID();
    const secret = newSecret();
    const familyId = input.family?.id ?? randomUUID();
    await db.session.create({
      data: {
        id,
        familyId,
        userId: input.userId,
        tenantId: input.tenantId,
        membershipId: input.membershipId,
        kind: input.kind,
        deviceId: input.deviceId ?? null,
        tokenHash: sha256(secret),
        expiresAt,
        familyExpiresAt,
        userAgent: input.meta.userAgent?.slice(0, 300) ?? null,
        ip: input.meta.ip ?? null,
      },
    });
    return {
      sessionId: id,
      familyId,
      kind: input.kind,
      accessToken: this.tokens.signAccess({
        sub: input.userId,
        tid: input.tenantId,
        mid: input.membershipId,
        sid: id,
      }),
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: `${id}.${secret}`,
      refreshExpiresAt: expiresAt,
    };
  }

  /**
   * Exchanges a refresh token for a new pair. Each token works once: presenting an already-used
   * token means it was copied, so the whole family is revoked and everyone must sign in again.
   */
  async rotate(
    refreshToken: string,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const parsed = parseRefresh(refreshToken);
    if (!parsed) throw refreshFailed();
    const s = await this.prisma.session.findUnique({
      where: { id: parsed.id },
      include: {
        user: { select: { status: true } },
        membership: {
          select: { status: true, tenant: { select: { status: true } } },
        },
      },
    });
    if (!s || !sameHash(s.tokenHash, sha256(parsed.secret)))
      throw refreshFailed();
    if (s.revokedAt)
      throw refreshFailed('SESSION_REVOKED', 'This session was signed out.');

    if (s.rotatedAt) {
      await this.revokeFamily(s.familyId, 'REFRESH_REUSE');
      await this.audit.record({
        tenantId: s.tenantId,
        actorUserId: s.userId,
        action: 'auth.refresh_reuse_detected',
        entity: 'session',
        entityId: s.familyId,
        meta,
      });
      throw refreshFailed(
        'REFRESH_TOKEN_REUSED',
        'This sign-in was used elsewhere. Please sign in again.',
      );
    }
    const now = new Date();
    if (s.expiresAt <= now || s.familyExpiresAt <= now) {
      throw refreshFailed(
        'SESSION_EXPIRED',
        'Your session has expired. Please sign in again.',
      );
    }
    if (
      s.user.status !== 'ACTIVE' ||
      s.membership.status !== 'ACTIVE' ||
      s.membership.tenant.status !== 'ACTIVE'
    ) {
      await this.revokeFamily(s.familyId, 'ACCESS_REMOVED');
      throw refreshFailed();
    }

    return this.prisma.$transaction(async (tx) => {
      // Conditional update: of two concurrent refreshes with the same token, only one wins.
      const won = await tx.session.updateMany({
        where: { id: s.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now, lastUsedAt: now },
      });
      if (won.count !== 1)
        throw refreshFailed(
          'REFRESH_TOKEN_REUSED',
          'This sign-in was used elsewhere. Please sign in again.',
        );
      return this.issue(
        {
          userId: s.userId,
          tenantId: s.tenantId,
          membershipId: s.membershipId,
          kind: s.kind,
          deviceId: s.deviceId,
          meta,
          family: { id: s.familyId, expiresAt: s.familyExpiresAt },
        },
        tx,
      );
    });
  }

  /** Signs out the session behind a refresh token (its whole family). Unknown tokens are ignored. */
  async revokeByRefreshToken(
    refreshToken: string,
  ): Promise<{ userId: string; tenantId: string; familyId: string } | null> {
    const parsed = parseRefresh(refreshToken);
    if (!parsed) return null;
    const s = await this.prisma.session.findUnique({
      where: { id: parsed.id },
    });
    if (!s || !sameHash(s.tokenHash, sha256(parsed.secret))) return null;
    await this.revokeFamily(s.familyId, 'LOGOUT');
    return { userId: s.userId, tenantId: s.tenantId, familyId: s.familyId };
  }

  async revokeFamily(familyId: string, reason: string, tx?: Tx) {
    await (tx ?? this.prisma).session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /**
   * A cashier works at one counter at a time: their PIN sessions in this business on any computer
   * end (reason PIN_ELSEWHERE) when they sign in with their PIN somewhere. Returns the devices.
   */
  async revokePinSessions(userId: string, tenantId: string, tx?: Tx) {
    const db = tx ?? this.prisma;
    const open = await db.session.findMany({
      where: {
        userId,
        tenantId,
        kind: 'PIN',
        revokedAt: null,
        familyExpiresAt: { gt: new Date() },
      },
      select: { deviceId: true },
    });
    if (!open.length) return [];
    await db.session.updateMany({
      where: { userId, tenantId, kind: 'PIN', revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'PIN_ELSEWHERE' },
    });
    return [
      ...new Set(open.map((s) => s.deviceId).filter((d): d is string => !!d)),
    ];
  }

  /** Every session of a user (all businesses), optionally keeping one family — e.g. the current one. */
  async revokeAllForUser(
    userId: string,
    reason: string,
    keepFamilyId?: string,
    tx?: Tx,
  ) {
    const r = await (tx ?? this.prisma).session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(keepFamilyId ? { familyId: { not: keepFamilyId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return r.count;
  }
}
