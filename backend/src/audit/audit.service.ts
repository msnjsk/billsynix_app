import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../database/prisma.service.js';
import type { RequestMeta } from '../auth/decorators.js';

export type AuditEntry = {
  tenantId?: string | null;
  actorUserId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  data?: Prisma.InputJsonValue;
  meta?: RequestMeta;
};

/** Append-only audit trail. Pass the surrounding transaction so the record commits with the change. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        tenantId: entry.tenantId ?? null,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        entity: entry.entity ?? null,
        entityId: entry.entityId ?? null,
        data: entry.data ?? Prisma.JsonNull,
        requestId: entry.meta?.requestId ?? null,
        ip: entry.meta?.ip ?? null,
      },
    });
  }
}
