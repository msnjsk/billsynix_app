import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
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
import {
  paginationQuery,
  uuidParam,
  type PaginationQuery,
} from '../common/schemas.js';
import { PriceListsService } from './price-lists.service.js';
import {
  assignPriceListSchema,
  createPriceListSchema,
  setPricesSchema,
  updatePriceListSchema,
  type AssignPriceListInput,
  type CreatePriceListInput,
  type SetPricesInput,
  type UpdatePriceListInput,
} from './catalogue.schemas.js';

@ApiTags('pricing')
@ApiBearerAuth()
@Controller()
export class PriceListsController {
  constructor(private readonly lists: PriceListsService) {}

  @Get('price-lists')
  @RequirePermissions('products:read')
  @ApiOperation({ summary: 'Price lists and the branches using each' })
  list(@CurrentAuth() auth: AuthContext) {
    return this.lists.list(auth);
  }

  @Post('price-lists')
  @RequirePermissions('prices:write')
  @ApiOperation({ summary: 'Create a price list' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createPriceListSchema }) body: CreatePriceListInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.lists.create(auth, body, meta);
  }

  @Get('price-lists/:id')
  @RequirePermissions('products:read')
  @ApiOperation({ summary: 'One price list' })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.lists.get(auth, id);
  }

  @Patch('price-lists/:id')
  @RequirePermissions('prices:write')
  @ApiOperation({ summary: 'Rename or (de)activate a price list' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updatePriceListSchema }) body: UpdatePriceListInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.lists.update(auth, id, body, meta);
  }

  @Get('price-lists/:id/prices')
  @RequirePermissions('products:read')
  @ApiOperation({ summary: 'Prices in a list' })
  prices(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Query({ schema: paginationQuery }) q: PaginationQuery,
  ) {
    return this.lists.prices(auth, id, q);
  }

  @Put('price-lists/:id/prices')
  @RequirePermissions('prices:write')
  @ApiOperation({
    summary: 'Set up to 500 prices (all or nothing; each within MRP)',
  })
  setPrices(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: setPricesSchema }) body: SetPricesInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.lists.setPrices(auth, id, body, meta);
  }

  @Delete('price-lists/:id/prices/:productId')
  @HttpCode(204)
  @RequirePermissions('prices:write')
  @ApiOperation({
    summary: "Remove a product's price (it goes back to the default)",
  })
  removePrice(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Param('productId', { schema: uuidParam }) productId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.lists.removePrice(auth, id, productId, meta);
  }

  @Put('stores/:storeId/price-list')
  @RequirePermissions('prices:write')
  @ApiOperation({
    summary: 'Choose the price list a branch bills with (null for none)',
  })
  assign(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', { schema: uuidParam }) storeId: string,
    @Body({ schema: assignPriceListSchema }) body: AssignPriceListInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.lists.assign(auth, storeId, body, meta);
  }
}
