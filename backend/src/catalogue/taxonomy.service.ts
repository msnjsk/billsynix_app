import { Injectable } from '@nestjs/common';
import { PrismaService, inOrder, type Tx } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { assertPermission, type AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Category } from '../generated/prisma/client.js';
import {
  alreadyExists,
  inUse,
  isUniqueViolation,
  notFound,
  unprocessable,
} from './catalogue.errors.js';
import {
  brandView,
  categoryView,
  taxRateView,
  unitView,
} from './catalogue.views.js';
import type {
  ActiveFilterQuery,
  CreateBrandInput,
  CreateCategoryInput,
  CreateTaxRateInput,
  CreateUnitInput,
  UpdateBrandInput,
  UpdateCategoryInput,
  UpdateTaxRateInput,
  UpdateUnitInput,
} from './catalogue.schemas.js';

export const MAX_CATEGORY_DEPTH = 3;

/** In-memory view of a business's category tree (categories number in the tens or hundreds). */
export class CategoryTree {
  readonly byId: Map<string, Category>;
  constructor(readonly all: Category[]) {
    this.byId = new Map(all.map((c) => [c.id, c]));
  }
  path(id: string): string[] {
    const names: string[] = [];
    let c = this.byId.get(id);
    while (c && names.length <= MAX_CATEGORY_DEPTH) {
      names.unshift(c.name);
      c = c.parentId ? this.byId.get(c.parentId) : undefined;
    }
    return names;
  }
  depth(id: string) {
    return this.path(id).length;
  }
  /** The category and everything below it. */
  subtree(id: string): string[] {
    const out = [id];
    for (let i = 0; i < out.length; i++)
      for (const c of this.all) if (c.parentId === out[i]) out.push(c.id);
    return out;
  }
  height(id: string): number {
    const kids = this.all.filter((c) => c.parentId === id);
    return 1 + Math.max(0, ...kids.map((k) => this.height(k.id)));
  }
}

const auditOf = (auth: AuthContext, meta: RequestMeta) => ({
  tenantId: auth.tenantId,
  actorUserId: auth.userId,
  meta,
});

/** Tax rates, units, categories and brands — the reference data products point at. */
@Injectable()
export class TaxonomyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async categoryTree(tx: Tx, tenantId: string) {
    return new CategoryTree(
      await tx.category.findMany({ where: { tenantId } }),
    );
  }

  /* ---------- tax rates ---------- */

  listTaxRates(auth: AuthContext, q: ActiveFilterQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.taxRate.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(q.includeInactive ? {} : { isActive: true }),
        },
        orderBy: [{ rate: 'asc' }, { name: 'asc' }],
      });
      return { data: rows.map(taxRateView) };
    });
  }

  createTaxRate(
    auth: AuthContext,
    input: CreateTaxRateInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      await this.assertTaxNameFree(tx, auth.tenantId, input.name);
      const row = await tx.taxRate.create({
        data: { tenantId: auth.tenantId, ...input },
      });
      await this.audit.record(
        {
          ...auditOf(auth, meta),
          action: 'tax_rate.created',
          entity: 'tax_rate',
          entityId: row.id,
          data: {
            name: row.name,
            kind: row.kind,
            rate: input.rate,
            cessRate: input.cessRate,
          },
        },
        tx,
      );
      return taxRateView(row);
    });
  }

  /**
   * Changing a rate affects bills issued from now on only: sales keep a snapshot of the rate they
   * were billed at (Phase 7), so issued invoices never change.
   */
  updateTaxRate(
    auth: AuthContext,
    id: string,
    patch: UpdateTaxRateInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await tx.taxRate.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!cur) throw notFound('Tax rate');
      const kind = patch.kind ?? cur.kind;
      const rate = patch.rate ?? Number(cur.rate);
      const cessRate = patch.cessRate ?? Number(cur.cessRate);
      if (kind === 'TAXABLE' && rate <= 0)
        throw unprocessable(
          'INVALID_TAX_RATE',
          'A taxable rate is above 0% — use NIL_RATED for 0%.',
          'rate',
        );
      if (kind !== 'TAXABLE' && (rate !== 0 || cessRate !== 0))
        throw unprocessable(
          'INVALID_TAX_RATE',
          `${kind} supplies carry no GST or cess.`,
          'rate',
        );
      if (patch.name && patch.name.toLowerCase() !== cur.name.toLowerCase())
        await this.assertTaxNameFree(tx, auth.tenantId, patch.name);
      if (patch.isActive === false && cur.isActive) {
        const used = await tx.product.count({
          where: {
            tenantId: auth.tenantId,
            taxRateId: cur.id,
            status: 'ACTIVE',
          },
        });
        if (used)
          throw inUse(
            `${used} active product(s) use this tax rate — move them to another rate first.`,
          );
      }
      const row = await tx.taxRate.update({
        where: { id: cur.id },
        data: { ...patch, kind, rate, cessRate },
      });
      await this.audit.record(
        {
          ...auditOf(auth, meta),
          action: 'tax_rate.updated',
          entity: 'tax_rate',
          entityId: row.id,
          data: {
            before: taxRateView(cur),
            after: taxRateView(row),
          },
        },
        tx,
      );
      return taxRateView(row);
    });
  }

  private async assertTaxNameFree(tx: Tx, tenantId: string, name: string) {
    const clash = await tx.taxRate.findFirst({
      where: { tenantId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash)
      throw alreadyExists(`A tax rate named "${name}" exists.`, 'name');
  }

  /* ---------- units ---------- */

  listUnits(auth: AuthContext, q: ActiveFilterQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.unit.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(q.includeInactive ? {} : { isActive: true }),
        },
        orderBy: { code: 'asc' },
      });
      return { data: rows.map(unitView) };
    });
  }

  createUnit(auth: AuthContext, input: CreateUnitInput, meta: RequestMeta) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const clash = await tx.unit.findFirst({
        where: { tenantId: auth.tenantId, code: input.code },
        select: { id: true },
      });
      if (clash) throw alreadyExists(`Unit ${input.code} exists.`, 'code');
      const row = await tx.unit.create({
        data: { tenantId: auth.tenantId, ...input },
      });
      await this.audit.record(
        {
          ...auditOf(auth, meta),
          action: 'unit.created',
          entity: 'unit',
          entityId: row.id,
          data: { code: row.code },
        },
        tx,
      );
      return unitView(row);
    });
  }

  updateUnit(
    auth: AuthContext,
    id: string,
    patch: UpdateUnitInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await tx.unit.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!cur) throw notFound('Unit');
      if (patch.isActive === false && cur.isActive) {
        const used = await tx.product.count({
          where: { tenantId: auth.tenantId, unitId: cur.id, status: 'ACTIVE' },
        });
        if (used)
          throw inUse(`${used} active product(s) are sold in ${cur.code}.`);
      }
      const row = await tx.unit.update({ where: { id: cur.id }, data: patch });
      await this.audit.record(
        {
          ...auditOf(auth, meta),
          action: 'unit.updated',
          entity: 'unit',
          entityId: row.id,
          data: patch,
        },
        tx,
      );
      return unitView(row);
    });
  }

  /* ---------- categories ---------- */

  listCategories(auth: AuthContext, q: ActiveFilterQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const tree = await this.categoryTree(tx, auth.tenantId);
      const rows = tree.all
        .filter((c) => q.includeInactive || c.isActive)
        .map((c) => categoryView(c, tree.path(c.id)))
        .sort((a, b) =>
          a.path.join('\u0000').localeCompare(b.path.join('\u0000'), 'en', {
            sensitivity: 'base',
          }),
        );
      return { data: rows };
    });
  }

  createCategory(
    auth: AuthContext,
    input: CreateCategoryInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const tree = await this.categoryTree(tx, auth.tenantId);
      const row = await this.insertCategory(tx, tree, auth.tenantId, input);
      await this.audit.record(
        {
          ...auditOf(auth, meta),
          action: 'category.created',
          entity: 'category',
          entityId: row.id,
          data: { name: row.name, parentId: row.parentId },
        },
        tx,
      );
      return categoryView(row, tree.path(row.id));
    });
  }

  /** Also used by CSV import (which creates missing categories). Adds the row to `tree`. */
  async insertCategory(
    tx: Tx,
    tree: CategoryTree,
    tenantId: string,
    input: CreateCategoryInput,
  ) {
    if (input.parentId) {
      const parent = tree.byId.get(input.parentId);
      if (!parent)
        throw unprocessable(
          'INVALID_REFERENCE',
          'Parent category not found.',
          'parentId',
        );
      if (tree.depth(parent.id) >= MAX_CATEGORY_DEPTH)
        throw unprocessable(
          'CATEGORY_TOO_DEEP',
          `Categories can be nested ${MAX_CATEGORY_DEPTH} levels deep.`,
          'parentId',
        );
    }
    this.assertSiblingNameFree(tree, input.parentId ?? null, input.name);
    try {
      const row = await tx.category.create({
        data: { tenantId, name: input.name, parentId: input.parentId ?? null },
      });
      tree.all.push(row);
      tree.byId.set(row.id, row);
      return row;
    } catch (e) {
      if (isUniqueViolation(e))
        throw alreadyExists(`Category "${input.name}" exists here.`, 'name');
      throw e;
    }
  }

  private assertSiblingNameFree(
    tree: CategoryTree,
    parentId: string | null,
    name: string,
    exceptId?: string,
  ) {
    const lower = name.toLowerCase();
    if (
      tree.all.some(
        (c) =>
          c.id !== exceptId &&
          c.parentId === parentId &&
          c.name.toLowerCase() === lower,
      )
    )
      throw alreadyExists(`Category "${name}" exists here.`, 'name');
  }

  updateCategory(
    auth: AuthContext,
    id: string,
    patch: UpdateCategoryInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const tree = await this.categoryTree(tx, auth.tenantId);
      const cur = tree.byId.get(id);
      if (!cur) throw notFound('Category');
      const parentId =
        patch.parentId === undefined ? cur.parentId : patch.parentId;
      if (parentId !== cur.parentId && parentId !== null) {
        if (!tree.byId.has(parentId))
          throw unprocessable(
            'INVALID_REFERENCE',
            'Parent category not found.',
            'parentId',
          );
        if (tree.subtree(cur.id).includes(parentId))
          throw unprocessable(
            'CATEGORY_CYCLE',
            "A category can't be moved under itself or one of its subcategories.",
            'parentId',
          );
        if (tree.depth(parentId) + tree.height(cur.id) > MAX_CATEGORY_DEPTH)
          throw unprocessable(
            'CATEGORY_TOO_DEEP',
            `Categories can be nested ${MAX_CATEGORY_DEPTH} levels deep.`,
            'parentId',
          );
      }
      this.assertSiblingNameFree(
        tree,
        parentId,
        patch.name ?? cur.name,
        cur.id,
      );
      const row = await tx.category.update({
        where: { id: cur.id },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.isActive !== undefined && { isActive: patch.isActive }),
          parentId,
        },
      });
      tree.byId.set(row.id, row);
      await this.audit.record(
        {
          ...auditOf(auth, meta),
          action: 'category.updated',
          entity: 'category',
          entityId: row.id,
          data: patch,
        },
        tx,
      );
      return categoryView(row, tree.path(row.id));
    });
  }

  deleteCategory(auth: AuthContext, id: string, meta: RequestMeta) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await tx.category.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!cur) throw notFound('Category');
      const [children, products] = await inOrder(
        () =>
          tx.category.count({
            where: { tenantId: auth.tenantId, parentId: cur.id },
          }),
        () =>
          tx.product.count({
            where: { tenantId: auth.tenantId, categoryId: cur.id },
          }),
      );
      if (children || products)
        throw inUse(
          'This category still has subcategories or products — move them, or deactivate it instead.',
        );
      await tx.category.delete({ where: { id: cur.id } });
      await this.audit.record(
        {
          ...auditOf(auth, meta),
          action: 'category.deleted',
          entity: 'category',
          entityId: cur.id,
          data: { name: cur.name },
        },
        tx,
      );
    });
  }

  /* ---------- brands ---------- */

  listBrands(auth: AuthContext, q: ActiveFilterQuery) {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const rows = await tx.brand.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(q.includeInactive ? {} : { isActive: true }),
        },
        orderBy: { name: 'asc' },
      });
      return { data: rows.map(brandView) };
    });
  }

  createBrand(auth: AuthContext, input: CreateBrandInput, meta: RequestMeta) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const row = await this.insertBrand(tx, auth.tenantId, input.name);
      await this.audit.record(
        {
          ...auditOf(auth, meta),
          action: 'brand.created',
          entity: 'brand',
          entityId: row.id,
          data: { name: row.name },
        },
        tx,
      );
      return brandView(row);
    });
  }

  async insertBrand(tx: Tx, tenantId: string, name: string) {
    const clash = await tx.brand.findFirst({
      where: { tenantId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) throw alreadyExists(`Brand "${name}" exists.`, 'name');
    try {
      return await tx.brand.create({ data: { tenantId, name } });
    } catch (e) {
      if (isUniqueViolation(e))
        throw alreadyExists(`Brand "${name}" exists.`, 'name');
      throw e;
    }
  }

  updateBrand(
    auth: AuthContext,
    id: string,
    patch: UpdateBrandInput,
    meta: RequestMeta,
  ) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await tx.brand.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!cur) throw notFound('Brand');
      if (patch.name && patch.name.toLowerCase() !== cur.name.toLowerCase()) {
        const clash = await tx.brand.findFirst({
          where: {
            tenantId: auth.tenantId,
            name: { equals: patch.name, mode: 'insensitive' },
          },
          select: { id: true },
        });
        if (clash) throw alreadyExists(`Brand "${patch.name}" exists.`, 'name');
      }
      const row = await tx.brand.update({ where: { id: cur.id }, data: patch });
      await this.audit.record(
        {
          ...auditOf(auth, meta),
          action: 'brand.updated',
          entity: 'brand',
          entityId: row.id,
          data: patch,
        },
        tx,
      );
      return brandView(row);
    });
  }

  deleteBrand(auth: AuthContext, id: string, meta: RequestMeta) {
    assertPermission(auth, 'products:write');
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      const cur = await tx.brand.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!cur) throw notFound('Brand');
      const used = await tx.product.count({
        where: { tenantId: auth.tenantId, brandId: cur.id },
      });
      if (used)
        throw inUse(
          `${used} product(s) use this brand — deactivate it instead.`,
        );
      await tx.brand.delete({ where: { id: cur.id } });
      await this.audit.record(
        {
          ...auditOf(auth, meta),
          action: 'brand.deleted',
          entity: 'brand',
          entityId: cur.id,
          data: { name: cur.name },
        },
        tx,
      );
    });
  }
}
