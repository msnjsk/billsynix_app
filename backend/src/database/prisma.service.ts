import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export type Tx = Prisma.TransactionClient;

/**
 * `Promise.all` for queries on one transaction: a transaction has a single connection, so they
 * run one after another anyway, and node-postgres is dropping support for overlapping queries.
 * Pass thunks: Prisma queries start when awaited.
 */
export async function inOrder<
  T extends readonly (() => PromiseLike<unknown> | null)[],
>(
  ...steps: T
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const step of steps) out.push(await step());
  return out as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

/** The single Prisma client for the process (connection pool via node-postgres). */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(@Inject(ENV) env: Env) {
    super({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** Cheap round-trip used by the readiness probe. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  /**
   * Runs `fn` in a transaction scoped to one business. Row-level security on branch tables
   * only exposes rows of `tenantId` inside it (ADR-004); application queries must still filter
   * by tenant — this is the second lock, not the first.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: Tx) => Promise<T>,
    options?: {
      isolationLevel?: Prisma.TransactionIsolationLevel;
      /** ms; Prisma's default is 5 s — bulk work (CSV import) passes more. */
      timeout?: number;
      maxWait?: number;
    },
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    }, options);
  }
}
