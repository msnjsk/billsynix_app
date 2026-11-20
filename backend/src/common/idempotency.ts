import { createHash } from 'node:crypto';
import {
  createParamDecorator,
  HttpStatus,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Tx } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AppException } from './errors/app-exception.js';

const KEY = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * The request's `Idempotency-Key` header, required (api-conventions: stock-changing POSTs).
 * Clients send a fresh UUID per action and the same one when retrying it.
 */
export const IdempotencyKey = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = req.header('idempotency-key');
    if (!key || !KEY.test(key))
      throw new AppException(
        'IDEMPOTENCY_KEY_REQUIRED',
        'Send an Idempotency-Key header (8–100 letters, digits, - or _; a UUID is ideal).',
        HttpStatus.BAD_REQUEST,
        [{ field: 'Idempotency-Key', issue: 'required' }],
      );
    return key;
  },
);

/** JSON with sorted keys, so equal bodies hash equally whatever their key order. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

export type Idempotent<T> = { replayed: boolean; status: number; body: T };

/**
 * Runs `work` once per (business, key). Must be called inside the transaction that does the work:
 * the key row is inserted first, so a concurrent retry waits on it and then replays the stored
 * answer; if the work fails the transaction rolls back and the key is free again.
 */
export async function idempotent<T>(
  tx: Tx,
  tenantId: string,
  key: string,
  request: { route: string; body: unknown },
  status: number,
  work: () => Promise<T>,
): Promise<Idempotent<T>> {
  const requestHash = createHash('sha256')
    .update(`${request.route}\n${stable(request.body)}`)
    .digest('hex');
  const inserted = await tx.$executeRaw`
    INSERT INTO idempotency_records (tenant_id, key, request_hash, status_code, response)
    VALUES (${tenantId}::uuid, ${key}, ${requestHash}, 0, 'null'::jsonb)
    ON CONFLICT DO NOTHING`;
  if (inserted === 0) {
    const prior = await tx.idempotencyRecord.findUniqueOrThrow({
      where: { tenantId_key: { tenantId, key } },
    });
    if (prior.requestHash !== requestHash)
      throw new AppException(
        'IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used for a different request.',
        HttpStatus.CONFLICT,
      );
    return {
      replayed: true,
      status: prior.statusCode,
      body: prior.response as T,
    };
  }
  const body = await work();
  await tx.idempotencyRecord.update({
    where: { tenantId_key: { tenantId, key } },
    data: {
      statusCode: status,
      response: JSON.parse(
        JSON.stringify(body ?? null),
      ) as Prisma.InputJsonValue,
    },
  });
  return { replayed: false, status, body };
}

/** Sets the status and, for a replay, `Idempotent-Replayed: true` (use with `@Res({ passthrough: true })`). */
export function reply<T>(res: Response, r: Idempotent<T>): T {
  res.status(r.replayed ? HttpStatus.OK : r.status);
  if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return r.body;
}
