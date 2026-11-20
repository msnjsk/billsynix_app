/**
 * The POS's own database on this computer (IndexedDB via Dexie) — what lets a registered counter
 * keep billing without a connection and survive a browser or computer restart:
 *
 *   outbox    every offline transaction (drawer opened, bill made), written *before* the bill is
 *             shown as done, kept until the server has it — and kept if it refused it;
 *   products  the branch catalogue as the server last sent it (GET /sync/catalogue);
 *   kv        device config, reserved invoice-number blocks, stock, catalogue cursor;
 *   reads     the last answer to each GET the screens load, served when the server is unreachable.
 *
 * Business data is only kept here on a registered counter device. Other computers keep nothing.
 */
import Dexie, { type EntityTable } from 'dexie';

export type SyncError = { code: string; message: string };
export type SyncWarning = { code: string; message: string };

export type OutboxStatus = 'pending' | 'failed' | 'synced' | 'discarded';

export type OutboxRow = {
  /** Local order: transactions are sent in the order they happened. */
  seq?: number;
  /** The transaction's UUID — its idempotency key on the server. */
  id: string;
  type: 'SALE' | 'CASH_SESSION_OPEN';
  payload: Record<string, unknown>;
  status: OutboxStatus;
  createdAt: string;
  /** Upload attempts that didn't get an answer for this transaction. */
  attempts: number;
  /** Don't send before this (epoch ms) — exponential backoff with jitter. */
  nextAttemptAt: number;
  lastError: SyncError | null;
  result: {
    saleId?: string;
    invoiceNo?: string;
    warnings?: SyncWarning[];
  } | null;
  syncedAt: string | null;
  /** What the operator sees in the queue: "SYN1/2627/00042 · ₹353". */
  label: string;
};

/** A product as GET /sync/catalogue sends it, plus its scan codes for lookup. */
export type CachedProduct = {
  id: string;
  sku: string;
  name: string;
  receiptName: string | null;
  categoryId: string | null;
  hsnCode: string | null;
  unitId: string;
  taxRateId: string;
  gstRate: number;
  cessRate: number;
  mrp: string | null;
  sellingPrice: string;
  priceIncludesTax: boolean;
  billPrice: string;
  priceSource: 'PRICE_LIST' | 'PRODUCT';
  allowOpenPrice: boolean;
  trackInventory: boolean;
  tracksBatches: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  version: number;
  changedAt: string;
  barcodes: { code: string; packQty: string; isPrimary: boolean }[];
  codes: string[];
};

type Kv = { key: string; value: unknown };
type Read = { key: string; value: unknown; at: string };

export class PosDatabase extends Dexie {
  outbox!: EntityTable<OutboxRow, 'seq'>;
  products!: EntityTable<CachedProduct, 'id'>;
  kv!: EntityTable<Kv, 'key'>;
  reads!: EntityTable<Read, 'key'>;

  constructor(name = 'kirana-pos') {
    super(name);
    this.version(1).stores({
      outbox: '++seq, &id, status, createdAt',
      products: 'id, sku, *codes, changedAt',
      kv: 'key',
      reads: 'key',
    });
  }
}

let instance: PosDatabase | null = null;

/** The database, opened on first use. */
export function posDb(): PosDatabase {
  instance ??= new PosDatabase();
  return instance;
}

/** Closes it (tests use this to simulate a restart: the next posDb() opens it afresh). */
export function closePosDb() {
  instance?.close();
  instance = null;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await posDb().kv.get(key))?.value as T | undefined;
}
export async function kvSet(key: string, value: unknown) {
  await posDb().kv.put({ key, value });
}
