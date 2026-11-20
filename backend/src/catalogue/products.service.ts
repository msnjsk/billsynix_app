import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService, inOrder, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { AppException } from '../common/errors/app-exception.js';
import { page, skipTake } from '../common/schemas.js';
import {
  assertPermission,
  can,
  canAccessStore,
  type AuthContext,
} from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { PermissionKey } from '../access/permissions.js';
import type { Prisma } from '../generated/prisma/client.js';
import { barcodeProblem } from './barcode.js';
import {
  alreadyExists,
  isUniqueViolation,
  notFound,
  unprocessable,
} from './catalogue.errors.js';
import {
  barcodeView,
  productInclude,
  productView,
  type ProductRow,
} from './catalogue.views.js';
import { priceAboveMrp, storePrices, type StorePrice } from './pricing.js';
import { TaxonomyService } from './taxonomy.service.js';
import type {
  BarcodeInput,
  CreateProductInput,
  ListProductsQuery,
  LookupQuery,
  UpdateProductInput,
} from './catalogue.schemas.js';

/** People who buy or price stock see purchase costs; cashiers don't. */
const COST_VIEWERS: PermissionKey[] = [
  'products:write',
  'prices:write',
  'purchases:write',
  'reports:finance',
];

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const IMAGE_TYPES = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;
export type ImageExt = keyof typeof IMAGE_TYPES;

/** The file's real type from its first bytes — the client's declared type is ignored. */
export function sniffImage(buf: Buffer): ImageExt | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return 'jpg';
  if (
    buf.length >= 8 &&
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'webp';
  return null;
}

export const typeOfKey = (key: string) =>
  IMAGE_TYPES[(key.split('.').pop() ?? '') as ImageExt] ??
  'application/octet-stream';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly taxonomy: TaxonomyService,
    private readonly storage: StorageService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  view(auth: AuthContext, p: ProductRow, storePrice?: StorePrice) {
    return productView(p, {
      showCost: COST_VIEWERS.some((k) => can(auth, k)),
      apiPrefix: this.env.API_PREFIX,
      ...(storePrice ? { storePrice } : {}),
    });
  }

  private async load(tx: Tx, auth: AuthContext, id: string) {
    const p = await tx.product.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: productInclude,
    });
    if (!p) throw notFound('Product');
    return p;
  }

  /** A branch the caller may use (404 otherwise), for branch prices. */
  private async visibleStore(tx: Tx, auth: AuthContext, storeId: string) {
    const store = await tx.store.findFirst({
      where: { id: storeId, tenantId: auth.tenantId },
      select: { id: true, priceListId: true },
    });
    if (!store || !canAccessStore(auth, store.id)) throw notFound('Branch');
    return store;
  }

  /* ---------- validation shared with CSV import ---------- */

  /** Category, brand, unit, tax rate and parent must belong to this business and be active. */
  private async resolveRefs(
    tx: Tx,
    tenantId: string,
    refs: {
      categoryId?: string | null | undefined;
      brandId?: string | null | undefined;
      unitId?: string | undefined;
      taxRateId?: string | undefined;
    },
  ) {
    const bad = (field: string, what: string) =>
      unprocessable(
        'INVALID_REFERENCE',
        `${what} not found or inactive.`,
        field,
      );
    const [category, brand, unit, taxRate] = await inOrder(
      () =>
        refs.categoryId
          ? tx.category.findFirst({
              where: { id: refs.categoryId, tenantId, isActive: true },
            })
          : null,
      () =>
        refs.brandId
          ? tx.brand.findFirst({
              where: { id: refs.brandId, tenantId, isActive: true },
            })
          : null,
      () =>
        refs.unitId
          ? tx.unit.findFirst({
              where: { id: refs.unitId, tenantId, isActive: true },
            })
          : null,
      () =>
        refs.taxRateId
          ? tx.taxRate.findFirst({
              where: { id: refs.taxRateId, tenantId, isActive: true },
            })
          : null,
    );
    if (refs.categoryId && !category) throw bad('categoryId', 'Category');
    if (refs.brandId && !brand) throw bad('brandId', 'Brand');
    if (refs.unitId && !unit) throw bad('unitId', 'Unit');
    if (refs.taxRateId && !taxRate) throw bad('taxRateId', 'Tax rate');
    return { unit, taxRate };
  }

  /** Variants are one level deep: a parent can't itself be a variant, and a parent can't become one. */
  private async checkParent(
    tx: Tx,
    tenantId: string,
    parentId: string,
    selfId?: string,
  ) {
    if (parentId === selfId)
      throw unprocessable(
        'INVALID_VARIANT',
        "A product can't be its own variant.",
        'parentId',
      );
    const parent = await tx.product.findFirst({
      where: { id: parentId, tenantId },
      select: { id: true, parentId: true },
    });
    if (!parent)
      throw unprocessable(
        'INVALID_REFERENCE',
        'Parent product not found.',
        'parentId',
      );
    if (parent.parentId)
      throw unprocessable(
        'INVALID_VARIANT',
        'That product is itself a variant — pick its main product.',
        'parentId',
      );
    if (selfId) {
      const kids = await tx.product.count({
        where: { tenantId, parentId: selfId },
      });
      if (kids)
        throw unprocessable(
          'INVALID_VARIANT',
          'This product has variants, so it cannot become a variant itself.',
          'parentId',
        );
    }
  }

  /** SKU free, and not a barcode of a different product (lookups match both). */
  private async checkSku(
    tx: Tx,
    tenantId: string,
    sku: string,
    selfId?: string,
  ) {
    const [p, b] = await inOrder(
      () =>
        tx.product.findFirst({
          where: { tenantId, sku },
          select: { id: true },
        }),
      () =>
        tx.productBarcode.findFirst({
          where: { tenantId, code: sku },
          select: { productId: true },
        }),
    );
    if (p && p.id !== selfId)
      throw alreadyExists(`SKU ${sku} is already used.`, 'sku');
    if (b && b.productId !== selfId)
      throw alreadyExists(
        `${sku} is already a barcode of another product.`,
        'sku',
      );
  }

  private async checkBarcodes(
    tx: Tx,
    tenantId: string,
    barcodes: ReadonlyArray<Pick<BarcodeInput, 'code'>>,
    field: (i: number) => string,
    selfId?: string,
    selfSku?: string,
  ) {
    const seen = new Set<string>();
    barcodes.forEach((b, i) => {
      const problem = barcodeProblem(b.code);
      if (problem) throw unprocessable('INVALID_BARCODE', problem, field(i));
      if (seen.has(b.code))
        throw unprocessable(
          'INVALID_BARCODE',
          `${b.code} is listed twice.`,
          field(i),
        );
      seen.add(b.code);
    });
    if (!barcodes.length) return;
    const codes = [...seen];
    const [taken, skus] = await inOrder(
      () =>
        tx.productBarcode.findMany({
          where: { tenantId, code: { in: codes } },
          include: { product: { select: { name: true, sku: true } } },
        }),
      () =>
        tx.product.findMany({
          where: { tenantId, sku: { in: codes } },
          select: { id: true, sku: true, name: true },
        }),
    );
    for (const t of taken)
      if (t.productId !== selfId)
        throw alreadyExists(
          `Barcode ${t.code} is already used by ${t.product.name} (${t.product.sku}).`,
          field(codes.indexOf(t.code)),
        );
    for (const s of skus)
      if (s.id !== selfId && s.sku !== selfSku)
        throw alreadyExists(
          `${s.sku} is the SKU of ${s.name}.`,
          field(codes.indexOf(s.sku)),
        );
  }

  private primaryIndex(barcodes: ReadonlyArray<BarcodeInput>) {
    const flagged = barcodes.flatMap((b, i) => (b.isPrimary ? [i] : []));
    if (flagged.length > 1)
      throw unprocessable(
        'INVALID_BARCODE',
        'Only one barcode can be primary.',
        'barcodes',
      );
    return flagged[0] ?? 0;
  }

  /* ---------- reads ---------- */

  list(auth: AuthContext, q: ListProductsQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const where: Prisma.ProductWhereInput = {
        tenantId: auth.tenantId,
        ...(q.status !== 'ALL' && { status: q.status }),
        ...(q.brandId && { brandId: q.brandId }),
        ...(q.parentId && { parentId: q.parentId }),
        ...(q.ids && { id: { in: q.ids } }),
      };
      if (q.categoryId) {
        const tree = await this.taxonomy.categoryTree(tx, auth.tenantId);
        where.categoryId = tree.byId.has(q.categoryId)
          ? { in: tree.subtree(q.categoryId) }
          : q.categoryId;
      }
      const words = (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 8);
      if (words.length) {
        where.AND = words.map((w) => ({
          OR: [
            { name: { contains: w, mode: 'insensitive' as const } },
            { sku: { startsWith: w.toUpperCase() } },
            { barcodes: { some: { code: w.toUpperCase() } } },
          ],
        }));
      }
      const store = q.storeId
        ? await this.visibleStore(tx, auth, q.storeId)
        : null;
      const desc = q.sort.startsWith('-');
      const field = q.sort.replace('-', '') as 'name' | 'sku' | 'updatedAt';
      const [rows, total] = await inOrder(
        () =>
          tx.product.findMany({
            where,
            include: productInclude,
            orderBy: [{ [field]: desc ? 'desc' : 'asc' }, { id: 'asc' }],
            ...skipTake(q),
          }),
        () => tx.product.count({ where }),
      );
      const prices = store
        ? await storePrices(tx, auth.tenantId, store.priceListId, rows)
        : null;
      return page(
        rows.map((p) => this.view(auth, p, prices?.get(p.id))),
        total,
        q,
      );
    });
  }

  get(auth: AuthContext, id: string, storeId?: string) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const p = await this.load(tx, auth, id);
      if (!storeId) return this.view(auth, p);
      const store = await this.visibleStore(tx, auth, storeId);
      const prices = await storePrices(tx, auth.tenantId, store.priceListId, [
        p,
      ]);
      return this.view(auth, p, prices.get(p.id));
    });
  }

  /**
   * What a scanner or typed code hits: a barcode first, then a SKU. A pack barcode says how many
   * units one scan sells (`packQty`). Archived products are not found unless asked for.
   */
  lookup(auth: AuthContext, q: LookupQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const barcode = await tx.productBarcode.findFirst({
        where: { tenantId: auth.tenantId, code: q.code },
      });
      const product = await tx.product.findFirst({
        where: barcode
          ? { tenantId: auth.tenantId, id: barcode.productId }
          : { tenantId: auth.tenantId, sku: q.code },
        include: productInclude,
      });
      if (!product || (product.status !== 'ACTIVE' && !q.includeInactive))
        throw notFound(`No product with code ${q.code}`);
      const store = q.storeId
        ? await this.visibleStore(tx, auth, q.storeId)
        : null;
      const prices = store
        ? await storePrices(tx, auth.tenantId, store.priceListId, [product])
        : null;
      return {
        matchedBy: barcode ? 'BARCODE' : 'SKU',
        barcode: barcode ? barcodeView(barcode) : null,
        packQty: barcode ? barcode.packQty.toFixed(3) : '1.000',
        product: this.view(auth, product, prices?.get(product.id)),
      };
    });
  }

  /* ---------- writes ---------- */

  create(auth: AuthContext, input: CreateProductInput, meta: RequestMeta) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const { taxRate } = await this.resolveRefs(tx, auth.tenantId, input);
      if (!taxRate) throw notFound('Tax rate');
      const problem = priceAboveMrp(
        {
          mrp: input.mrp ?? null,
          sellingPrice: input.sellingPrice,
          priceIncludesTax: input.priceIncludesTax,
        },
        taxRate,
      );
      if (problem)
        throw unprocessable('PRICE_ABOVE_MRP', problem, 'sellingPrice');
      if (input.parentId) {
        await this.checkParent(tx, auth.tenantId, input.parentId);
        if (!input.variantLabel)
          throw unprocessable(
            'INVALID_VARIANT',
            'Say what makes this variant different, e.g. "5 kg".',
            'variantLabel',
          );
      }
      await this.checkSku(tx, auth.tenantId, input.sku);
      await this.checkBarcodes(
        tx,
        auth.tenantId,
        input.barcodes,
        (i) => `barcodes.${i}.code`,
        undefined,
        input.sku,
      );
      if (input.barcodes.some((b) => b.code === input.sku))
        throw unprocessable(
          'INVALID_BARCODE',
          'The SKU is matched by lookups already — no need to add it as a barcode.',
          'barcodes',
        );
      const primary = this.primaryIndex(input.barcodes);
      const { barcodes, ...fields } = input;
      try {
        const created = await tx.product.create({
          data: { tenantId: auth.tenantId, ...fields },
        });
        if (barcodes.length)
          await tx.productBarcode.createMany({
            data: barcodes.map((b, i) => ({
              tenantId: auth.tenantId,
              productId: created.id,
              code: b.code,
              packQty: b.packQty,
              label: b.label ?? null,
              isPrimary: i === primary,
            })),
          });
        const row = await this.load(tx, auth, created.id);
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'product.created',
            entity: 'product',
            entityId: row.id,
            data: {
              sku: row.sku,
              name: row.name,
              sellingPrice: input.sellingPrice,
              mrp: input.mrp ?? null,
            },
            meta,
          },
          tx,
        );
        return this.view(auth, row);
      } catch (e) {
        if (isUniqueViolation(e))
          throw alreadyExists('The SKU or a barcode was just taken.', 'sku');
        throw e;
      }
    });
  }

  update(
    auth: AuthContext,
    id: string,
    patch: UpdateProductInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.load(tx, auth, id);
      const { version, ...changes } = patch;
      if (version !== undefined && version !== cur.version)
        throw new AppException(
          'VERSION_CONFLICT',
          'Someone else changed this product. Reload it and try again.',
          HttpStatus.CONFLICT,
        );
      const { taxRate: newTax } = await this.resolveRefs(tx, auth.tenantId, {
        categoryId: changes.categoryId,
        brandId: changes.brandId,
        unitId: changes.unitId,
        taxRateId: changes.taxRateId,
      });
      const taxRate = newTax ?? cur.taxRate;
      const mrp = changes.mrp !== undefined ? changes.mrp : cur.mrp;
      const priceIncludesTax = changes.priceIncludesTax ?? cur.priceIncludesTax;
      const problem = priceAboveMrp(
        {
          mrp,
          sellingPrice: changes.sellingPrice ?? cur.sellingPrice,
          priceIncludesTax,
        },
        taxRate,
      );
      if (problem)
        throw unprocessable('PRICE_ABOVE_MRP', problem, 'sellingPrice');
      if (
        changes.mrp !== undefined ||
        changes.priceIncludesTax !== undefined ||
        changes.taxRateId !== undefined
      ) {
        const listed = await tx.productPrice.findMany({
          where: { tenantId: auth.tenantId, productId: cur.id },
          include: { priceList: { select: { name: true } } },
        });
        const over = listed.find((l) =>
          priceAboveMrp(
            { mrp, sellingPrice: l.sellingPrice, priceIncludesTax },
            taxRate,
          ),
        );
        if (over)
          throw unprocessable(
            'PRICE_LIST_ABOVE_MRP',
            `Price list "${over.priceList.name}" sells this at ₹${over.sellingPrice.toFixed(2)}, above the new MRP. Lower that price first.`,
            'mrp',
          );
      }
      const parentId =
        changes.parentId !== undefined ? changes.parentId : cur.parentId;
      if (changes.parentId)
        await this.checkParent(tx, auth.tenantId, changes.parentId, cur.id);
      const variantLabel =
        changes.variantLabel !== undefined
          ? changes.variantLabel
          : cur.variantLabel;
      if (parentId && !variantLabel)
        throw unprocessable(
          'INVALID_VARIANT',
          'Say what makes this variant different, e.g. "5 kg".',
          'variantLabel',
        );
      if (
        (changes.trackInventory !== undefined &&
          changes.trackInventory !== cur.trackInventory) ||
        (changes.tracksBatches !== undefined &&
          changes.tracksBatches !== cur.tracksBatches)
      ) {
        const held = await tx.stockBalance.count({
          where: {
            tenantId: auth.tenantId,
            productId: cur.id,
            qty: { not: 0 },
          },
        });
        if (held)
          throw unprocessable(
            'STOCK_HELD',
            'Stock of this product is held in a branch — bring it to zero before changing how its stock is tracked.',
            changes.tracksBatches !== undefined
              ? 'tracksBatches'
              : 'trackInventory',
          );
      }
      if (changes.sku && changes.sku !== cur.sku)
        await this.checkSku(tx, auth.tenantId, changes.sku, cur.id);
      try {
        const row = await tx.product.update({
          where: { id: cur.id },
          data: {
            ...changes,
            ...(parentId === null && { variantLabel: null }),
            version: { increment: 1 },
          },
          include: productInclude,
        });
        const priceFields = [
          'mrp',
          'sellingPrice',
          'purchaseCost',
          'taxRateId',
          'priceIncludesTax',
        ] as const;
        const priceChange = Object.fromEntries(
          priceFields
            .filter((f) => changes[f] !== undefined)
            .map((f) => [
              f,
              { from: String(cur[f] ?? ''), to: String(changes[f] ?? '') },
            ]),
        );
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'product.updated',
            entity: 'product',
            entityId: row.id,
            data: {
              fields: Object.keys(changes),
              ...(Object.keys(priceChange).length && { prices: priceChange }),
            },
            meta,
          },
          tx,
        );
        return this.view(auth, row);
      } catch (e) {
        if (isUniqueViolation(e))
          throw alreadyExists('The SKU was just taken.', 'sku');
        throw e;
      }
    });
  }

  /** Archiving hides a product from billing and search but keeps it for history. */
  setStatus(
    auth: AuthContext,
    id: string,
    status: 'ACTIVE' | 'INACTIVE',
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.load(tx, auth, id);
      if (cur.status === status) return this.view(auth, cur);
      const row = await tx.product.update({
        where: { id: cur.id },
        data: { status, version: { increment: 1 } },
        include: productInclude,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action:
            status === 'INACTIVE' ? 'product.archived' : 'product.restored',
          entity: 'product',
          entityId: row.id,
          meta,
        },
        tx,
      );
      return this.view(auth, row);
    });
  }

  addBarcode(
    auth: AuthContext,
    id: string,
    input: BarcodeInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.load(tx, auth, id);
      if (cur.barcodes.length >= 20)
        throw unprocessable(
          'TOO_MANY_BARCODES',
          'A product can have up to 20 barcodes.',
        );
      if (input.code === cur.sku)
        throw unprocessable(
          'INVALID_BARCODE',
          'The SKU is matched by lookups already — no need to add it as a barcode.',
          'code',
        );
      await this.checkBarcodes(
        tx,
        auth.tenantId,
        [input],
        () => 'code',
        cur.id,
        cur.sku,
      );
      if (cur.barcodes.some((b) => b.code === input.code))
        throw alreadyExists(
          `${input.code} is already on this product.`,
          'code',
        );
      const isPrimary = input.isPrimary || cur.barcodes.length === 0;
      if (isPrimary)
        await tx.productBarcode.updateMany({
          where: { tenantId: auth.tenantId, productId: cur.id },
          data: { isPrimary: false },
        });
      try {
        await tx.productBarcode.create({
          data: {
            tenantId: auth.tenantId,
            productId: cur.id,
            code: input.code,
            packQty: input.packQty,
            label: input.label ?? null,
            isPrimary,
          },
        });
      } catch (e) {
        if (isUniqueViolation(e))
          throw alreadyExists(`Barcode ${input.code} was just taken.`, 'code');
        throw e;
      }
      const row = await tx.product.update({
        where: { id: cur.id },
        data: { version: { increment: 1 } },
        include: productInclude,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'product.barcode_added',
          entity: 'product',
          entityId: cur.id,
          data: { code: input.code, packQty: input.packQty },
          meta,
        },
        tx,
      );
      return this.view(auth, row);
    });
  }

  removeBarcode(
    auth: AuthContext,
    id: string,
    barcodeId: string,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.load(tx, auth, id);
      const b = cur.barcodes.find((x) => x.id === barcodeId);
      if (!b) throw notFound('Barcode');
      await tx.productBarcode.delete({ where: { id: b.id } });
      const next = cur.barcodes.find((x) => x.id !== b.id);
      if (b.isPrimary && next)
        await tx.productBarcode.update({
          where: { id: next.id },
          data: { isPrimary: true },
        });
      const row = await tx.product.update({
        where: { id: cur.id },
        data: { version: { increment: 1 } },
        include: productInclude,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'product.barcode_removed',
          entity: 'product',
          entityId: cur.id,
          data: { code: b.code },
          meta,
        },
        tx,
      );
      return this.view(auth, row);
    });
  }

  /* ---------- image ---------- */

  async putImage(
    auth: AuthContext,
    id: string,
    file: { buffer: Buffer; size: number } | undefined,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'products:write');
    if (!file?.buffer?.length)
      throw new AppException(
        'VALIDATION_FAILED',
        'Attach the photo as the multipart field "image".',
        HttpStatus.BAD_REQUEST,
      );
    const ext = sniffImage(file.buffer);
    if (!ext)
      throw new AppException(
        'UNSUPPORTED_MEDIA_TYPE',
        'The photo must be a JPEG, PNG or WebP image.',
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    // Check the product exists before storing anything.
    await this.prisma.withTenant(auth.tenantId, (tx) =>
      this.load(tx, auth, id),
    );
    const key = `t/${auth.tenantId}/products/${id}/${randomUUID()}.${ext}`;
    await this.storage.put(key, file.buffer, IMAGE_TYPES[ext]);
    let old: string | null = null;
    try {
      const view = await this.prisma.withTenant(auth.tenantId, async (tx) => {
        const cur = await this.load(tx, auth, id);
        old = cur.imageKey;
        const row = await tx.product.update({
          where: { id: cur.id },
          data: { imageKey: key, version: { increment: 1 } },
          include: productInclude,
        });
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'product.image_set',
            entity: 'product',
            entityId: cur.id,
            data: { bytes: file.size, type: IMAGE_TYPES[ext] },
            meta,
          },
          tx,
        );
        return this.view(auth, row);
      });
      if (old) await this.deleteQuietly(old);
      return view;
    } catch (e) {
      await this.deleteQuietly(key);
      throw e;
    }
  }

  async getImage(auth: AuthContext, id: string) {
    const p = await this.prisma.withTenant(auth.tenantId, (tx) =>
      this.load(tx, auth, id),
    );
    const found = p.imageKey
      ? await this.storage.get(p.imageKey, typeOfKey(p.imageKey))
      : null;
    if (!found) throw notFound('Product photo');
    return found;
  }

  async deleteImage(auth: AuthContext, id: string, meta: RequestMeta) {
    assertPermission(auth, 'products:write');
    let old: string | null = null;
    const view = await this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await this.load(tx, auth, id);
      old = cur.imageKey;
      if (!old) return this.view(auth, cur);
      const row = await tx.product.update({
        where: { id: cur.id },
        data: { imageKey: null, version: { increment: 1 } },
        include: productInclude,
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'product.image_removed',
          entity: 'product',
          entityId: cur.id,
          meta,
        },
        tx,
      );
      return this.view(auth, row);
    });
    if (old) await this.deleteQuietly(old);
    return view;
  }

  private async deleteQuietly(key: string) {
    try {
      await this.storage.delete(key);
    } catch (err) {
      this.logger.warn({ err, key }, 'Could not delete stored object');
    }
  }
}
