import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentAuth,
  ReqMeta,
  RequirePermissions,
  type RequestMeta,
} from '../auth/decorators.js';
import type { AuthContext } from '../auth/auth-context.js';
import { uuidParam } from '../common/schemas.js';
import { TaxonomyService } from './taxonomy.service.js';
import {
  activeFilterQuery,
  createBrandSchema,
  createCategorySchema,
  createTaxRateSchema,
  createUnitSchema,
  updateBrandSchema,
  updateCategorySchema,
  updateTaxRateSchema,
  updateUnitSchema,
  type ActiveFilterQuery,
  type CreateBrandInput,
  type CreateCategoryInput,
  type CreateTaxRateInput,
  type CreateUnitInput,
  type UpdateBrandInput,
  type UpdateCategoryInput,
  type UpdateTaxRateInput,
  type UpdateUnitInput,
} from './catalogue.schemas.js';

@ApiTags('catalogue')
@ApiBearerAuth()
@Controller()
export class TaxonomyController {
  constructor(private readonly taxonomy: TaxonomyService) {}

  /* tax rates */

  @Get('tax-rates')
  @RequirePermissions('products:read')
  @ApiOperation({ summary: 'Tax classifications (GST rate + cess)' })
  listTaxRates(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: activeFilterQuery }) q: ActiveFilterQuery,
  ) {
    return this.taxonomy.listTaxRates(auth, q);
  }

  @Post('tax-rates')
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Add a tax rate' })
  createTaxRate(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createTaxRateSchema }) body: CreateTaxRateInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.taxonomy.createTaxRate(auth, body, meta);
  }

  @Patch('tax-rates/:id')
  @RequirePermissions('products:write')
  @ApiOperation({
    summary:
      'Change a tax rate (applies to bills from now on; issued invoices keep their rate)',
  })
  updateTaxRate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updateTaxRateSchema }) body: UpdateTaxRateInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.taxonomy.updateTaxRate(auth, id, body, meta);
  }

  /* units */

  @Get('units')
  @RequirePermissions('products:read')
  @ApiOperation({ summary: 'Units of measure' })
  listUnits(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: activeFilterQuery }) q: ActiveFilterQuery,
  ) {
    return this.taxonomy.listUnits(auth, q);
  }

  @Post('units')
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Add a unit of measure' })
  createUnit(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createUnitSchema }) body: CreateUnitInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.taxonomy.createUnit(auth, body, meta);
  }

  @Patch('units/:id')
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Edit a unit of measure' })
  updateUnit(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updateUnitSchema }) body: UpdateUnitInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.taxonomy.updateUnit(auth, id, body, meta);
  }

  /* categories */

  @Get('categories')
  @RequirePermissions('products:read')
  @ApiOperation({
    summary: 'All categories, flat, each with its path from the top',
  })
  listCategories(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: activeFilterQuery }) q: ActiveFilterQuery,
  ) {
    return this.taxonomy.listCategories(auth, q);
  }

  @Post('categories')
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Add a category (up to 3 levels deep)' })
  createCategory(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createCategorySchema }) body: CreateCategoryInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.taxonomy.createCategory(auth, body, meta);
  }

  @Patch('categories/:id')
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Rename, move or deactivate a category' })
  updateCategory(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updateCategorySchema }) body: UpdateCategoryInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.taxonomy.updateCategory(auth, id, body, meta);
  }

  @Delete('categories/:id')
  @HttpCode(204)
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Delete an unused category' })
  deleteCategory(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.taxonomy.deleteCategory(auth, id, meta);
  }

  /* brands */

  @Get('brands')
  @RequirePermissions('products:read')
  @ApiOperation({ summary: 'Brands' })
  listBrands(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: activeFilterQuery }) q: ActiveFilterQuery,
  ) {
    return this.taxonomy.listBrands(auth, q);
  }

  @Post('brands')
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Add a brand' })
  createBrand(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createBrandSchema }) body: CreateBrandInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.taxonomy.createBrand(auth, body, meta);
  }

  @Patch('brands/:id')
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Rename or deactivate a brand' })
  updateBrand(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updateBrandSchema }) body: UpdateBrandInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.taxonomy.updateBrand(auth, id, body, meta);
  }

  @Delete('brands/:id')
  @HttpCode(204)
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Delete an unused brand' })
  deleteBrand(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.taxonomy.deleteBrand(auth, id, meta);
  }
}
