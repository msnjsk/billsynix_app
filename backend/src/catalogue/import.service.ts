import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService, inOrder, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppException } from '../common/errors/app-exception.js';
import { CsvError, parseCsv, toCsv, unguardCell } from '../common/csv.js';
import { moneyInput, qtyInput } from '../common/decimal.js';
import { assertPermission, type AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type {
  Brand,
  Prisma,
  ProductStatus,
  TaxRate,
  Unit,
} from '../generated/prisma/client.js';
import { SKU_PATTERN, barcodeProblem, normaliseCode } from './barcode.js';
import { priceAboveMrp } from './pricing.js';
import {
  CategoryTree,
  MAX_CATEGORY_DEPTH,
  TaxonomyService,
} from './taxonomy.service.js';

/**
 * Catalogue CSV. One row per product, matched to existing products by SKU (update) or created.
 * On update, a column that is absent or a cell that is empty leaves that field unchanged.
 */
export const CSV_COLUMNS = [
  'sku',
  'name',
  'receipt_name',
  'category',
  'brand',
  'unit',
  'tax',
  'hsn',
  'mrp',
  'selling_price',
  'purchase_cost',
  'price_includes_tax',
  'barcodes',
  'parent_sku',
  'variant_label',
  'track_inventory',
  'tracks_batches',
  'allow_open_price',
  'status',
  'description',
] as const;
type Column = (typeof CSV_COLUMNS)[number];

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_REPORTED_ERRORS = 1000;

export type ImportError = { row: number; column?: Column; message: string };

export type ImportResult = {
  dryRun: boolean;
  /** true only when the file was valid and written. */
  committed: boolean;
  rows: number;
  created: number;
  updated: number;
  categoriesCreated: string[];
  brandsCreated: string[];
  errorCount: number;
  /** Row numbers are spreadsheet line numbers (the header is row 1). */
  errors: ImportError[];
};

type Barcode = { code: string; packQty: string };

/** One valid row, ready to write. Fields are only present when the file gave them. */
type Plan = {
  line: number;
  sku: string;
  existingId?: string;
  categoryPath?: string[];
  brandName?: string;
  barcodes?: Barcode[];
  parentSku?: string;
  data: {
    name?: string;
    receiptName?: string;
    description?: string;
    unitId?: string;
    taxRateId?: string;
    hsnCode?: string;
    mrp?: string;
    sellingPrice?: string;
    purchaseCost?: string;
    priceIncludesTax?: boolean;
    trackInventory?: boolean;
    tracksBatches?: boolean;
    allowOpenPrice?: boolean;
    variantLabel?: string;
    status?: ProductStatus;
  };
};

const BOOL: Record<string, boolean> = {
  yes: true,
  y: true,
  true: true,
  '1': true,
  no: false,
  n: false,
  false: false,
  '0': false,
};

const bad = (message: string) =>
  new AppException('VALIDATION_FAILED', message, HttpStatus.BAD_REQUEST);

const pathKey = (path: string[]) =>
  path.map((p) => p.toLowerCase()).join('\u0000');

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  /* ---------- import ---------- */

  async importCsv(
    auth: AuthContext,
    file: { buffer: Buffer } | undefined,
    dryRun: boolean,
    meta: RequestMeta,
  ): Promise<ImportResult> {
    assertPermission(auth, 'products:write');
    if (!file?.buffer?.length)
      throw bad('Attach the CSV file as the multipart field "file".');
    const text = file.buffer.toString('utf8');
    if (text.includes('�'))
      throw bad('The file is not UTF-8. In Excel use "Save as → CSV UTF-8".');
    let table: string[][];
    try {
      table = parseCsv(text);
    } catch (e) {
      if (e instanceof CsvError) throw bad(`CSV line ${e.line}: ${e.message}`);
      throw e;
    }
    const [header, ...body] = table;
    if (!header) throw bad('The file is empty.');
    const cols = header.map((h) =>
      h
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_'),
    );
    const unknown = cols.filter(
      (c) => !(CSV_COLUMNS as readonly string[]).includes(c),
    );
    if (unknown.length)
      throw bad(
        `Unknown column(s): ${unknown.join(', ')}. Download the template for the expected columns.`,
      );
    const dupCol = cols.find((c, i) => cols.indexOf(c) !== i);
    if (dupCol) throw bad(`Column ${dupCol} appears twice.`);
    if (!cols.includes('sku')) throw bad('The file needs a "sku" column.');
    if (!body.length) throw bad('The file has a header but no products.');
    if (body.length > MAX_IMPORT_ROWS)
      throw bad(
        `At most ${MAX_IMPORT_ROWS} products per file — split it into several files.`,
      );

    const index = new Map(cols.map((c, i) => [c as Column, i]));
    const cell = (row: string[], c: Column): string | undefined => {
      const i = index.get(c);
      if (i === undefined) return undefined;
      const v = unguardCell((row[i] ?? '').trim());
      return v === '' ? undefined : v;
    };

    return this.prisma.withTenant(
      auth.tenantId,
      async (tx) => {
        const ctx = await this.context(tx, auth.tenantId, body, cell);
        const errors: ImportError[] = [];
        const plans: Plan[] = [];
        body.forEach((row, i) => {
          const plan = this.planRow(row, i + 2, cell, ctx, (column, message) =>
            errors.push({ row: i + 2, ...(column ? { column } : {}), message }),
          );
          if (plan) plans.push(plan);
        });
        this.checkParents(plans, ctx, (row, column, message) =>
          errors.push({ row, column, message }),
        );

        const newCategories = new Map<string, string[]>();
        const newBrands = new Map<string, string>();
        for (const p of plans) {
          if (
            p.categoryPath &&
            !ctx.categoryByPath.has(pathKey(p.categoryPath))
          )
            for (let d = 1; d <= p.categoryPath.length; d++) {
              const sub = p.categoryPath.slice(0, d);
              if (!ctx.categoryByPath.has(pathKey(sub)))
                newCategories.set(pathKey(sub), sub);
            }
          if (p.brandName && !ctx.brandByName.has(p.brandName.toLowerCase()))
            newBrands.set(p.brandName.toLowerCase(), p.brandName);
        }
        const result: ImportResult = {
          dryRun,
          committed: false,
          rows: body.length,
          created: plans.filter((p) => !p.existingId).length,
          updated: plans.filter((p) => p.existingId).length,
          categoriesCreated: [...newCategories.values()].map((p) =>
            p.join(' > '),
          ),
          brandsCreated: [...newBrands.values()],
          errorCount: errors.length,
          errors: errors
            .sort((a, b) => a.row - b.row)
            .slice(0, MAX_REPORTED_ERRORS),
        };
        if (errors.length || dryRun) {
          if (errors.length) {
            result.created = 0;
            result.updated = 0;
          }
          return result;
        }
        await this.commit(
          tx,
          auth,
          ctx,
          plans,
          [...newCategories.values()],
          [...newBrands.values()],
        );
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'products.imported',
            entity: 'product',
            data: {
              rows: result.rows,
              created: result.created,
              updated: result.updated,
              categoriesCreated: result.categoriesCreated.length,
              brandsCreated: result.brandsCreated.length,
            },
            meta,
          },
          tx,
        );
        return { ...result, committed: true };
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }

  /** Everything rows are checked against, loaded once. */
  private async context(
    tx: Tx,
    tenantId: string,
    body: string[][],
    cell: (row: string[], c: Column) => string | undefined,
  ) {
    const skus = [
      ...new Set(
        body.map((r) => (cell(r, 'sku') ?? '').toUpperCase()).filter(Boolean),
      ),
    ];
    const codes = [
      ...new Set(
        body.flatMap((r) =>
          (cell(r, 'barcodes') ?? '')
            .split('|')
            .map((b) => normaliseCode(b.split('*')[0] ?? ''))
            .filter(Boolean),
        ),
      ),
    ];
    const parentSkus = [
      ...new Set(
        body
          .map((r) => (cell(r, 'parent_sku') ?? '').toUpperCase())
          .filter(Boolean),
      ),
    ];
    const [
      units,
      taxRates,
      tree,
      brands,
      existing,
      barcodeOwners,
      skuOwners,
      parents,
    ] = await inOrder(
      () => tx.unit.findMany({ where: { tenantId, isActive: true } }),
      () =>
        tx.taxRate.findMany({
          where: { tenantId, isActive: true },
          orderBy: { createdAt: 'asc' },
        }),
      () => this.taxonomy.categoryTree(tx, tenantId),
      () => tx.brand.findMany({ where: { tenantId } }),
      () =>
        tx.product.findMany({
          where: { tenantId, sku: { in: skus } },
          include: {
            taxRate: true,
            prices: { include: { priceList: { select: { name: true } } } },
            _count: { select: { variants: true } },
          },
        }),
      () =>
        tx.productBarcode.findMany({
          where: { tenantId, code: { in: [...codes, ...skus] } },
          include: { product: { select: { sku: true } } },
        }),
      () =>
        tx.product.findMany({
          where: { tenantId, sku: { in: codes } },
          select: { id: true, sku: true },
        }),
      () =>
        tx.product.findMany({
          where: { tenantId, sku: { in: parentSkus } },
          select: { id: true, sku: true, parentId: true },
        }),
    );
    const stocked = new Set(
      (
        await tx.stockBalance.findMany({
          where: {
            tenantId,
            productId: { in: existing.map((p) => p.id) },
            qty: { not: 0 },
          },
          select: { productId: true },
        })
      ).map((b) => b.productId),
    );
    const categoryByPath = new Map<string, string>();
    for (const c of tree.all)
      categoryByPath.set(pathKey(tree.path(c.id)), c.id);
    return {
      tree,
      categoryByPath,
      unitByCode: new Map(units.map((u) => [u.code, u])),
      taxRates,
      brandByName: new Map(brands.map((b) => [b.name.toLowerCase(), b])),
      existingBySku: new Map(existing.map((p) => [p.sku, p])),
      barcodeOwner: new Map(barcodeOwners.map((b) => [b.code, b.product.sku])),
      skuOwnerOfCode: new Map(skuOwners.map((p) => [p.sku, p.id])),
      parentsInDb: new Map(parents.map((p) => [p.sku, p])),
      stocked,
      skusInFile: new Map<string, number>(),
      codesInFile: new Map<string, number>(),
    };
  }

  private resolveTax(raw: string, rates: TaxRate[]): TaxRate | undefined {
    const v = raw.trim().toLowerCase();
    const byName = rates.find((r) => r.name.toLowerCase() === v);
    if (byName) return byName;
    if (['nil', 'nil-rated', 'nil rated', '0', '0%'].includes(v))
      return rates.find((r) => r.kind === 'NIL_RATED');
    if (v === 'exempt') return rates.find((r) => r.kind === 'EXEMPT');
    if (['non-gst', 'non gst', 'nongst'].includes(v))
      return rates.find((r) => r.kind === 'NON_GST');
    const m = /^(\d{1,3}(?:\.\d{1,2})?)\s*%?$/.exec(v);
    if (m)
      return rates.find(
        (r) =>
          r.kind === 'TAXABLE' &&
          Number(r.rate) === Number(m[1]) &&
          Number(r.cessRate) === 0,
      );
    return undefined;
  }

  private planRow(
    row: string[],
    line: number,
    cell: (row: string[], c: Column) => string | undefined,
    ctx: Awaited<ReturnType<ImportService['context']>>,
    err: (column: Column | undefined, message: string) => void,
  ): Plan | null {
    const before = { n: 0 };
    const e = (c: Column | undefined, m: string) => {
      before.n++;
      err(c, m);
    };
    const sku = (cell(row, 'sku') ?? '').toUpperCase();
    if (!sku) {
      e('sku', 'SKU is required.');
      return null;
    }
    if (!SKU_PATTERN.test(sku))
      e('sku', 'A SKU is 1–40 letters or digits (also - _ . /).');
    const firstLine = ctx.skusInFile.get(sku);
    if (firstLine) e('sku', `SKU ${sku} is also on row ${firstLine}.`);
    else ctx.skusInFile.set(sku, line);
    if (ctx.barcodeOwner.has(sku) && ctx.barcodeOwner.get(sku) !== sku)
      e('sku', `${sku} is a barcode of ${ctx.barcodeOwner.get(sku)}.`);

    const existing = ctx.existingBySku.get(sku);
    const plan: Plan = {
      line,
      sku,
      data: {},
      ...(existing ? { existingId: existing.id } : {}),
    };
    const d = plan.data;

    const text = (c: Column, max: number) => {
      const v = cell(row, c);
      if (v !== undefined && v.length > max) e(c, `At most ${max} characters.`);
      return v;
    };
    const name = text('name', 120);
    if (name) d.name = name;
    else if (!existing) e('name', 'Name is required for a new product.');
    const receiptName = text('receipt_name', 40);
    if (receiptName) d.receiptName = receiptName;
    const description = text('description', 1000);
    if (description) d.description = description;
    const variantLabel = text('variant_label', 40);
    if (variantLabel) d.variantLabel = variantLabel;

    const amount = (c: Column) => {
      const v = cell(row, c);
      if (v === undefined) return undefined;
      const r = moneyInput.safeParse(v.replace(/[₹,\s]/g, ''));
      if (!r.success) {
        e(c, `"${v}" is not an amount (use e.g. 45 or 45.50).`);
        return undefined;
      }
      return r.data;
    };
    const mrp = amount('mrp');
    if (mrp !== undefined) {
      if (Number(mrp) <= 0) e('mrp', 'MRP must be more than 0.');
      else d.mrp = mrp;
    }
    const sp = amount('selling_price');
    if (sp !== undefined) d.sellingPrice = sp;
    else if (!existing && cell(row, 'selling_price') === undefined)
      e('selling_price', 'Selling price is required for a new product.');
    const pc = amount('purchase_cost');
    if (pc !== undefined) d.purchaseCost = pc;

    const bool = (c: Column) => {
      const v = cell(row, c);
      if (v === undefined) return undefined;
      const b = BOOL[v.toLowerCase()];
      if (b === undefined) e(c, `Use yes or no (got "${v}").`);
      return b;
    };
    const pit = bool('price_includes_tax');
    if (pit !== undefined) d.priceIncludesTax = pit;
    const ti = bool('track_inventory');
    if (ti !== undefined) d.trackInventory = ti;
    const tb = bool('tracks_batches');
    if (tb !== undefined) d.tracksBatches = tb;
    if (
      existing &&
      ((ti !== undefined && ti !== existing.trackInventory) ||
        (tb !== undefined && tb !== existing.tracksBatches)) &&
      ctx.stocked.has(existing.id)
    )
      e(
        ti !== undefined && ti !== existing.trackInventory
          ? 'track_inventory'
          : 'tracks_batches',
        'Stock is held in a branch — bring it to zero before changing how stock is tracked.',
      );
    const aop = bool('allow_open_price');
    if (aop !== undefined) d.allowOpenPrice = aop;

    const status = cell(row, 'status');
    if (status !== undefined) {
      const s = status.toUpperCase();
      if (s === 'ACTIVE' || s === 'INACTIVE') d.status = s;
      else e('status', 'Use active or inactive.');
    }

    let unit: Unit | undefined;
    const unitCode = cell(row, 'unit');
    if (unitCode !== undefined) {
      unit = ctx.unitByCode.get(unitCode.toUpperCase());
      if (unit) d.unitId = unit.id;
      else e('unit', `No active unit ${unitCode.toUpperCase()}.`);
    } else if (!existing) {
      unit = ctx.unitByCode.get('PCS');
      if (unit) d.unitId = unit.id;
      else e('unit', 'Unit is required (there is no PCS unit to default to).');
    }

    let tax: TaxRate | undefined;
    const taxCell = cell(row, 'tax');
    if (taxCell !== undefined) {
      tax = this.resolveTax(taxCell, ctx.taxRates);
      if (tax) d.taxRateId = tax.id;
      else
        e(
          'tax',
          `No active tax rate matches "${taxCell}" — use its name (e.g. "GST 5%") or a rate (5).`,
        );
    } else if (!existing)
      e('tax', 'Tax is required for a new product (e.g. 5 or GST 5%).');

    const hsn = cell(row, 'hsn');
    if (hsn !== undefined) {
      // Spreadsheets drop leading zeros (0401 → 401).
      const h = /^\d{3}$|^\d{5}$|^\d{7}$/.test(hsn) ? `0${hsn}` : hsn;
      if (/^(\d{4}|\d{6}|\d{8})$/.test(h)) d.hsnCode = h;
      else e('hsn', 'An HSN/SAC code is 4, 6 or 8 digits.');
    }

    const category = cell(row, 'category');
    if (category !== undefined) {
      const path = category.split('>').map((s) => s.trim());
      if (path.some((p) => !p || p.length > 60))
        e(
          'category',
          'Write nested categories as "Grocery > Rice" (each name 1–60 characters).',
        );
      else if (path.length > MAX_CATEGORY_DEPTH)
        e(
          'category',
          `Categories can be nested ${MAX_CATEGORY_DEPTH} levels deep.`,
        );
      else plan.categoryPath = path;
    }
    const brand = cell(row, 'brand');
    if (brand !== undefined) {
      if (brand.length > 60) e('brand', 'At most 60 characters.');
      else plan.brandName = brand;
    }

    const barcodes = cell(row, 'barcodes');
    if (barcodes !== undefined) {
      plan.barcodes = [];
      for (const part of barcodes
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean)) {
        const [rawCode = '', rawQty] = part.split('*').map((s) => s.trim());
        const code = normaliseCode(rawCode);
        if (/^\d(\.\d+)?E\+\d+$/i.test(code)) {
          e(
            'barcodes',
            `${rawCode} looks like a number Excel shortened — format the column as Text and re-enter it.`,
          );
          continue;
        }
        const problem = barcodeProblem(code);
        if (problem) {
          e('barcodes', problem);
          continue;
        }
        let packQty = '1.000';
        if (rawQty !== undefined) {
          const q = qtyInput.safeParse(rawQty);
          if (!q.success || Number(q.data) <= 0) {
            e(
              'barcodes',
              `Pack quantity "${rawQty}" for ${code} must be a number above 0.`,
            );
            continue;
          }
          packQty = q.data;
        }
        if (code === sku) {
          e(
            'barcodes',
            'The SKU is matched by lookups already — leave it out of barcodes.',
          );
          continue;
        }
        const seenOn = ctx.codesInFile.get(code);
        if (seenOn) e('barcodes', `Barcode ${code} is also on row ${seenOn}.`);
        else ctx.codesInFile.set(code, line);
        const owner = ctx.barcodeOwner.get(code);
        if (owner && owner !== sku)
          e('barcodes', `Barcode ${code} belongs to ${owner}.`);
        if (ctx.skuOwnerOfCode.has(code) && code !== sku)
          e('barcodes', `${code} is the SKU of another product.`);
        plan.barcodes.push({ code, packQty });
      }
    }

    const parentSku = cell(row, 'parent_sku')?.toUpperCase();
    if (parentSku) {
      if (parentSku === sku)
        e('parent_sku', "A product can't be its own variant.");
      else if (existing && existing._count.variants)
        e(
          'parent_sku',
          'This product has variants, so it cannot become a variant itself.',
        );
      else plan.parentSku = parentSku;
      if (!variantLabel && !existing?.variantLabel)
        e(
          'variant_label',
          'Say what makes this variant different, e.g. "5 kg".',
        );
    }

    // Price within MRP, on the values the product will have after the import.
    const taxForCheck = tax ?? existing?.taxRate;
    const sellForCheck = d.sellingPrice ?? existing?.sellingPrice;
    if (taxForCheck && sellForCheck !== undefined) {
      const mrpForCheck = d.mrp ?? existing?.mrp ?? null;
      const includes = d.priceIncludesTax ?? existing?.priceIncludesTax ?? true;
      const problem = priceAboveMrp(
        {
          mrp: mrpForCheck,
          sellingPrice: sellForCheck,
          priceIncludesTax: includes,
        },
        taxForCheck,
      );
      if (problem) e('selling_price', problem);
      const over = existing?.prices.find((p) =>
        priceAboveMrp(
          {
            mrp: mrpForCheck,
            sellingPrice: p.sellingPrice,
            priceIncludesTax: includes,
          },
          taxForCheck,
        ),
      );
      if (over)
        e(
          'mrp',
          `Price list "${over.priceList.name}" sells this at ₹${over.sellingPrice.toFixed(2)}, above this MRP.`,
        );
    }

    return before.n ? null : plan;
  }

  /** Parents must exist (in the catalogue or in this file) and not be variants themselves. */
  private checkParents(
    plans: Plan[],
    ctx: Awaited<ReturnType<ImportService['context']>>,
    err: (row: number, column: Column, message: string) => void,
  ) {
    const inFile = new Map(plans.map((p) => [p.sku, p]));
    for (const p of plans) {
      if (!p.parentSku) continue;
      const filed = inFile.get(p.parentSku);
      const db = ctx.parentsInDb.get(p.parentSku);
      if (filed) {
        if (filed.parentSku)
          err(
            p.line,
            'parent_sku',
            `${p.parentSku} is itself a variant — use its main product.`,
          );
      } else if (db) {
        if (db.parentId)
          err(
            p.line,
            'parent_sku',
            `${p.parentSku} is itself a variant — use its main product.`,
          );
      } else if (!ctx.skusInFile.has(p.parentSku)) {
        err(p.line, 'parent_sku', `No product with SKU ${p.parentSku}.`);
      } else {
        err(
          p.line,
          'parent_sku',
          `Product ${p.parentSku} has errors in this file.`,
        );
      }
    }
  }

  private async commit(
    tx: Tx,
    auth: AuthContext,
    ctx: Awaited<ReturnType<ImportService['context']>>,
    plans: Plan[],
    newCategories: string[][],
    newBrands: string[],
  ) {
    const tenantId = auth.tenantId;
    // Parents before children: shorter paths first.
    for (const path of newCategories.sort((a, b) => a.length - b.length)) {
      const parentId =
        path.length > 1
          ? ctx.categoryByPath.get(pathKey(path.slice(0, -1)))
          : undefined;
      const c = await this.taxonomy.insertCategory(tx, ctx.tree, tenantId, {
        name: path[path.length - 1] ?? '',
        ...(parentId ? { parentId } : {}),
      });
      ctx.categoryByPath.set(pathKey(path), c.id);
    }
    const brandIds = new Map<string, string>(
      [...ctx.brandByName.entries()].map(([k, b]: [string, Brand]) => [
        k,
        b.id,
      ]),
    );
    for (const name of newBrands) {
      const b = await this.taxonomy.insertBrand(tx, tenantId, name);
      brandIds.set(name.toLowerCase(), b.id);
    }

    const ids = new Map<string, string>();
    for (const p of plans) ids.set(p.sku, p.existingId ?? randomUUID());
    for (const [sku, parent] of ctx.parentsInDb)
      ids.set(sku, ids.get(sku) ?? parent.id);

    const refs = (p: Plan) => ({
      ...(p.categoryPath && {
        categoryId: ctx.categoryByPath.get(pathKey(p.categoryPath)) ?? null,
      }),
      ...(p.brandName && {
        brandId: brandIds.get(p.brandName.toLowerCase()) ?? null,
      }),
      ...(p.parentSku && { parentId: ids.get(p.parentSku) ?? null }),
    });

    const creates = plans.filter((p) => !p.existingId);
    // Main products first so variants' parent rows exist.
    for (const batch of [
      creates.filter((p) => !p.parentSku),
      creates.filter((p) => p.parentSku),
    ]) {
      if (!batch.length) continue;
      await tx.product.createMany({
        data: batch.map((p): Prisma.ProductCreateManyInput => ({
          id: ids.get(p.sku) ?? randomUUID(),
          tenantId,
          sku: p.sku,
          name: p.data.name ?? p.sku,
          unitId: p.data.unitId ?? '',
          taxRateId: p.data.taxRateId ?? '',
          sellingPrice: p.data.sellingPrice ?? '0',
          ...p.data,
          ...refs(p),
        })),
      });
    }
    for (const p of plans.filter((x) => x.existingId)) {
      await tx.product.update({
        where: { id: p.existingId },
        data: { ...p.data, ...refs(p), version: { increment: 1 } },
      });
    }
    const withBarcodes = plans.filter((p) => p.barcodes);
    const replaced = withBarcodes
      .filter((p) => p.existingId)
      .map((p) => p.existingId as string);
    if (replaced.length)
      await tx.productBarcode.deleteMany({
        where: { tenantId, productId: { in: replaced } },
      });
    const barcodeRows = withBarcodes.flatMap((p) =>
      (p.barcodes ?? []).map((b, i) => ({
        tenantId,
        productId: ids.get(p.sku) ?? '',
        code: b.code,
        packQty: b.packQty,
        isPrimary: i === 0,
      })),
    );
    if (barcodeRows.length)
      await tx.productBarcode.createMany({ data: barcodeRows });
  }

  /* ---------- export ---------- */

  export(auth: AuthContext): Promise<string> {
    return this.prisma.withTenant(
      auth.tenantId,
      async (tx) => {
        const tree: CategoryTree = await this.taxonomy.categoryTree(
          tx,
          auth.tenantId,
        );
        const rows = await tx.product.findMany({
          where: { tenantId: auth.tenantId },
          include: {
            brand: true,
            unit: true,
            taxRate: true,
            parent: { select: { sku: true } },
            barcodes: {
              orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            },
          },
          orderBy: [
            { parentId: { sort: 'asc', nulls: 'first' } },
            { sku: 'asc' },
          ],
        });
        const yn = (b: boolean) => (b ? 'yes' : 'no');
        return toCsv([
          [...CSV_COLUMNS],
          ...rows.map((p) => [
            p.sku,
            p.name,
            p.receiptName,
            p.categoryId ? tree.path(p.categoryId).join(' > ') : null,
            p.brand?.name,
            p.unit.code,
            p.taxRate.name,
            p.hsnCode,
            p.mrp?.toFixed(2),
            p.sellingPrice.toFixed(2),
            p.purchaseCost?.toFixed(2),
            yn(p.priceIncludesTax),
            p.barcodes
              .map((b) =>
                b.packQty.eq(1) ? b.code : `${b.code}*${Number(b.packQty)}`,
              )
              .join('|'),
            p.parent?.sku,
            p.variantLabel,
            yn(p.trackInventory),
            yn(p.tracksBatches),
            yn(p.allowOpenPrice),
            p.status.toLowerCase(),
            p.description,
          ]),
        ]);
      },
      { timeout: 60_000 },
    );
  }

  /** Header plus two example rows. */
  template(): string {
    return toCsv([
      [...CSV_COLUMNS],
      [
        'ATTA-5KG',
        'Gehu Gold Atta 5kg',
        'Atta 5kg',
        'Grocery > Flour',
        'Gehu Gold',
        'PCS',
        '5',
        '1101',
        '320.00',
        '299.00',
        '255.00',
        'yes',
        '8901234100011|8901234100028*6',
        '',
        '',
        'yes',
        'no',
        'no',
        'active',
        '',
      ],
      [
        'TOMATO',
        'Tomato (loose)',
        '',
        'Vegetables',
        '',
        'KG',
        'nil',
        '0702',
        '',
        '40.00',
        '28.00',
        'yes',
        '',
        '',
        '',
        'yes',
        'no',
        'yes',
        'active',
        'Sold by weight',
      ],
    ]);
  }
}
