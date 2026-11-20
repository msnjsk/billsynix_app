import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
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
import {
  advanceSchema,
  createOrderSchema,
  listOrdersQuery,
  OrdersService,
  type AdvanceInput,
  type CreateOrderInput,
  type ListOrdersQuery,
} from './orders.service.js';

@ApiTags('customer-orders')
@ApiBearerAuth()
@Controller('customer-orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermissions('sales:read')
  @ApiOperation({
    summary: 'Open orders, and the day’s completed and cancelled ones',
  })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listOrdersQuery }) q: ListOrdersQuery,
  ) {
    return this.orders.list(auth, q);
  }

  @Get(':id')
  @RequirePermissions('sales:read')
  @ApiOperation({
    summary: 'One order (with its bill, once billed at the POS)',
  })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.orders.get(auth, id);
  }

  @Post()
  @RequirePermissions('sales:create')
  @ApiOperation({
    summary: 'Take a delivery or pickup order (phone, WhatsApp, in store)',
  })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createOrderSchema }) body: CreateOrderInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.create(auth, body, meta);
  }

  @Post(':id/advance')
  @HttpCode(200)
  @RequirePermissions('sales:create')
  @ApiOperation({
    summary:
      'Move an order on: packing → ready → dispatched (rider) → completed (collection), or cancel (reason)',
  })
  advance(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: advanceSchema }) body: AdvanceInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.orders.advance(auth, id, body, meta);
  }
}

/** Delivery and pickup orders from customers. */
@Module({ controllers: [OrdersController], providers: [OrdersService] })
export class OrdersModule {}
