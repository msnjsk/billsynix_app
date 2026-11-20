import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  CurrentAuth,
  ReqMeta,
  RequirePermissions,
  type RequestMeta,
} from '../auth/decorators.js';
import type { AuthContext } from '../auth/auth-context.js';
import { uuidParam } from '../common/schemas.js';
import { IdempotencyKey, reply } from '../common/idempotency.js';
import { StockService } from './stock.service.js';
import { AdjustmentsService } from './adjustments.service.js';
import { CountsService } from './counts.service.js';
import { TransfersService } from './transfers.service.js';
import {
  alertsQuery,
  countDetailQuery,
  createAdjustmentSchema,
  createBatchSchema,
  createCountSchema,
  createTransferSchema,
  dispatchSchema,
  listAdjustmentsQuery,
  listCountsQuery,
  listTransfersQuery,
  movementsQuery,
  receiveSchema,
  recordCountSchema,
  rejectSchema,
  reorderSchema,
  stockListQuery,
  type AlertsQuery,
  type CreateAdjustmentInput,
  type CreateBatchInput,
  type CreateCountInput,
  type CreateTransferInput,
  type DispatchInput,
  type ListAdjustmentsQuery,
  type ListCountsQuery,
  type ListTransfersQuery,
  type MovementsQuery,
  type ReceiveInput,
  type RecordCountInput,
  type RejectInput,
  type ReorderInput,
  type StockListQuery,
} from './inventory.schemas.js';

const IDEMPOTENCY = ApiHeader({
  name: 'Idempotency-Key',
  required: true,
  description:
    'A fresh UUID per action; resend the same one when retrying. A replay returns the first response with `Idempotent-Replayed: true`.',
});
const storeIdQuery = z.object({ storeId: z.uuid().optional() });

@ApiTags('inventory')
@ApiBearerAuth()
@Controller()
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get('stores/:storeId/stock')
  @RequirePermissions('inventory:read')
  @ApiOperation({
    summary:
      'Stock of a branch: quantity, status, reorder level, in transit (costs for managers)',
  })
  list(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', { schema: uuidParam }) storeId: string,
    @Query({ schema: stockListQuery }) q: StockListQuery,
  ) {
    return this.stock.list(auth, storeId, q);
  }

  @Get('stores/:storeId/stock/:productId')
  @RequirePermissions('inventory:read')
  @ApiOperation({ summary: 'One product in a branch, with its batches' })
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', { schema: uuidParam }) storeId: string,
    @Param('productId', { schema: uuidParam }) productId: string,
  ) {
    return this.stock.detail(auth, storeId, productId);
  }

  @Put('stores/:storeId/stock/:productId/reorder')
  @RequirePermissions('inventory:adjust')
  @ApiOperation({
    summary: 'Set the reorder level / quantity of a product in a branch',
  })
  reorder(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', { schema: uuidParam }) storeId: string,
    @Param('productId', { schema: uuidParam }) productId: string,
    @Body({ schema: reorderSchema }) body: ReorderInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stock.setReorder(auth, storeId, productId, body, meta);
  }

  @Get('stores/:storeId/stock-movements')
  @RequirePermissions('inventory:read')
  @ApiOperation({
    summary:
      'The stock ledger of a branch, newest first (cursor: meta.nextCursor)',
  })
  movements(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', { schema: uuidParam }) storeId: string,
    @Query({ schema: movementsQuery }) q: MovementsQuery,
  ) {
    return this.stock.movements(auth, storeId, q);
  }

  @Get('stock/alerts/low')
  @RequirePermissions('inventory:read')
  @ApiOperation({
    summary: 'Products at or below their reorder level, in your branches',
  })
  low(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: alertsQuery }) q: AlertsQuery,
  ) {
    return this.stock.lowStock(auth, q);
  }

  @Get('stock/alerts/expiry')
  @RequirePermissions('inventory:read')
  @ApiOperation({
    summary: 'Batches in stock that expire within `days` (or already have)',
  })
  expiry(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: alertsQuery }) q: AlertsQuery,
  ) {
    return this.stock.expiring(auth, q);
  }

  @Get('stock/reconciliation')
  @RequirePermissions('inventory:approve')
  @ApiOperation({
    summary: 'Check that every balance equals the sum of its ledger movements',
  })
  reconcile(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: storeIdQuery }) q: { storeId?: string },
  ) {
    return this.stock.reconcile(auth, q.storeId);
  }

  @Get('products/:productId/batches')
  @RequirePermissions('inventory:read')
  @ApiOperation({ summary: 'Batches of a product with stock per branch' })
  batches(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', { schema: uuidParam }) productId: string,
  ) {
    return this.stock.listBatches(auth, productId);
  }

  @Post('products/:productId/batches')
  @RequirePermissions('inventory:adjust')
  @ApiOperation({
    summary: 'Add a batch (number, expiry) to a batch-tracked product',
  })
  createBatch(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', { schema: uuidParam }) productId: string,
    @Body({ schema: createBatchSchema }) body: CreateBatchInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.stock.createBatch(auth, productId, body, meta);
  }
}

@ApiTags('inventory')
@ApiBearerAuth()
@Controller()
export class AdjustmentsController {
  constructor(private readonly adjustments: AdjustmentsService) {}

  @Post('stores/:storeId/stock-adjustments')
  @RequirePermissions('inventory:adjust')
  @IDEMPOTENCY
  @ApiOperation({
    summary: 'Opening stock, write-off or correction',
    description:
      'Posts at once when its value is within the approval limit (or you are an owner/admin); otherwise waits as PENDING_APPROVAL.',
  })
  async create(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', { schema: uuidParam }) storeId: string,
    @Body({ schema: createAdjustmentSchema }) body: CreateAdjustmentInput,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(
      res,
      await this.adjustments.create(auth, storeId, body, key, meta),
    );
  }

  @Get('stock-adjustments')
  @RequirePermissions('inventory:read')
  @ApiOperation({
    summary:
      'Adjustments in your branches (filter by status to find pending approvals)',
  })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listAdjustmentsQuery }) q: ListAdjustmentsQuery,
  ) {
    return this.adjustments.list(auth, q);
  }

  @Get('stock-adjustments/:id')
  @RequirePermissions('inventory:read')
  @ApiOperation({ summary: 'One adjustment' })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.adjustments.get(auth, id);
  }

  @Post('stock-adjustments/:id/approve')
  @RequirePermissions('inventory:approve')
  @IDEMPOTENCY
  @ApiOperation({
    summary:
      'Approve and post a pending adjustment (not your own, unless owner/admin)',
  })
  async approve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.adjustments.approve(auth, id, key, meta));
  }

  @Post('stock-adjustments/:id/reject')
  @HttpCode(200)
  @RequirePermissions('inventory:approve')
  @ApiOperation({ summary: 'Reject a pending adjustment' })
  reject(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: rejectSchema }) body: RejectInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.adjustments.reject(auth, id, body, meta);
  }

  @Post('stock-adjustments/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('inventory:adjust')
  @ApiOperation({ summary: 'Withdraw a pending adjustment' })
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.adjustments.cancel(auth, id, meta);
  }
}

@ApiTags('inventory')
@ApiBearerAuth()
@Controller()
export class CountsController {
  constructor(private readonly counts: CountsService) {}

  @Post('stores/:storeId/stock-counts')
  @RequirePermissions('inventory:adjust')
  @ApiOperation({
    summary:
      'Start a physical count (all stocked products, a category, or a list)',
  })
  create(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', { schema: uuidParam }) storeId: string,
    @Body({ schema: createCountSchema }) body: CreateCountInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.counts.create(auth, storeId, body, meta);
  }

  @Get('stock-counts')
  @RequirePermissions('inventory:read')
  @ApiOperation({ summary: 'Counts in your branches' })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listCountsQuery }) q: ListCountsQuery,
  ) {
    return this.counts.list(auth, q);
  }

  @Get('stock-counts/:id')
  @RequirePermissions('inventory:read')
  @ApiOperation({ summary: 'A count sheet with differences' })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Query({ schema: countDetailQuery }) q: { onlyDifferences: boolean },
  ) {
    return this.counts.get(auth, id, q.onlyDifferences);
  }

  @Put('stock-counts/:id/items')
  @RequirePermissions('inventory:adjust')
  @ApiOperation({
    summary: 'Record counted quantities (send again to recount)',
  })
  record(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: recordCountSchema }) body: RecordCountInput,
  ) {
    return this.counts.record(auth, id, body);
  }

  @Post('stock-counts/:id/submit')
  @HttpCode(200)
  @RequirePermissions('inventory:adjust')
  @ApiOperation({ summary: 'Hand the count over for posting' })
  submit(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.counts.submit(auth, id, meta);
  }

  @Post('stock-counts/:id/post')
  @RequirePermissions('inventory:approve')
  @IDEMPOTENCY
  @ApiOperation({
    summary: 'Book the differences into stock (COUNT_ADJUSTMENT)',
  })
  async post(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.counts.post(auth, id, key, meta));
  }

  @Post('stock-counts/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('inventory:adjust')
  @ApiOperation({ summary: 'Abandon a count (nothing is booked)' })
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.counts.cancel(auth, id, meta);
  }
}

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('stock-transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Post()
  @RequirePermissions('transfers:request')
  @ApiOperation({ summary: 'Request stock from one branch to another' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createTransferSchema }) body: CreateTransferInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.transfers.create(auth, body, meta);
  }

  @Get()
  @RequirePermissions('inventory:read')
  @ApiOperation({ summary: 'Transfers into or out of your branches' })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listTransfersQuery }) q: ListTransfersQuery,
  ) {
    return this.transfers.list(auth, q);
  }

  @Get(':id')
  @RequirePermissions('inventory:read')
  @ApiOperation({ summary: 'One transfer' })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.transfers.get(auth, id);
  }

  @Post(':id/dispatch')
  @RequirePermissions('transfers:dispatch')
  @IDEMPOTENCY
  @ApiOperation({
    summary: 'Send it: stock leaves the source and is in transit',
  })
  async dispatch(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: dispatchSchema }) body: DispatchInput,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.transfers.dispatch(auth, id, body, key, meta));
  }

  @Post(':id/receive')
  @RequirePermissions('transfers:receive')
  @IDEMPOTENCY
  @ApiOperation({
    summary: 'Receive it at the destination; any shortfall is booked as a loss',
  })
  async receive(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: receiveSchema }) body: ReceiveInput,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.transfers.receive(auth, id, body, key, meta));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('transfers:request')
  @ApiOperation({ summary: 'Cancel before dispatch' })
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.transfers.cancel(auth, id, meta);
  }
}
