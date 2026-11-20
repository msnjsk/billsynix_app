import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AllowWhenReadOnly,
  CurrentAuth,
  ReqMeta,
  RequirePermissions,
  type RequestMeta,
} from '../auth/decorators.js';
import type { AuthContext } from '../auth/auth-context.js';
import { uuidParam } from '../common/schemas.js';
import { SyncService } from './sync.service.js';
import { SyncReviewService } from './sync-review.service.js';
import { CatalogueFeedService } from './catalogue-feed.service.js';
import {
  acknowledgeSchema,
  batchSchema,
  catalogueQuery,
  discardSchema,
  listIssuesQuery,
  reserveBlockSchema,
  retrySchema,
  storeQuery,
  type BatchInput,
  type CatalogueQuery,
  type ListIssuesQuery,
  type ReserveBlockInput,
  type RetryInput,
  type StoreQuery,
} from './sync.schemas.js';

/** Called by POS devices (cashier PIN session on a registered device). */
@ApiTags('sync')
@ApiBearerAuth()
@Controller('sync')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly feed: CatalogueFeedService,
  ) {}

  @Get('config')
  @RequirePermissions('sales:create')
  @ApiOperation({
    summary:
      'Device, counter, branch and business details, offline limits and number blocks',
  })
  config(@CurrentAuth() auth: AuthContext) {
    return this.sync.config(auth);
  }

  @Get('catalogue')
  @RequirePermissions('products:read')
  @ApiOperation({
    summary:
      'Products with this branch’s prices, tax and barcodes, for the offline cache',
    description:
      'Without `cursor`: everything. With the `cursor` of the previous response: only what changed since. Follow `hasMore`. `reset: true` means drop the cache (the branch’s price list changed).',
  })
  catalogue(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: catalogueQuery }) q: CatalogueQuery,
  ) {
    return this.feed.catalogue(auth, q);
  }

  @Get('stock')
  @RequirePermissions('products:read')
  @ApiOperation({
    summary: 'This branch’s stock now (the device’s local balance)',
  })
  stock(@CurrentAuth() auth: AuthContext) {
    return this.feed.stock(auth);
  }

  @Post('number-blocks')
  @RequirePermissions('sales:create')
  @ApiOperation({
    summary:
      'Reserve the next block of this counter’s invoice numbers for offline bills',
  })
  reserve(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: reserveBlockSchema }) body: ReserveBlockInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.sync.reserveBlock(auth, body, meta);
  }

  @Post('batch')
  @HttpCode(200)
  // Bills a counter already made offline are recorded even if the subscription lapsed since.
  @AllowWhenReadOnly()
  @RequirePermissions('sales:create')
  @ApiOperation({
    summary:
      'Upload offline transactions (drawer openings, bills); one result per transaction',
    description:
      'Each transaction’s `id` (a UUID made on the device) is its idempotency key: resending is always safe. Results: ACCEPTED (maybe with warnings), FAILED (kept for a manager; stop sending it), RETRY (send again later). An empty batch reports the queue as a heartbeat.',
  })
  batch(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: batchSchema }) body: BatchInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.sync.batch(auth, body, meta);
  }
}

/** Managers: what offline synchronisation needs from them. */
@ApiTags('sync')
@ApiBearerAuth()
@Controller('sync')
export class SyncReviewController {
  constructor(private readonly review: SyncReviewService) {}

  @Get('issues')
  @RequirePermissions('cash:reconcile')
  @ApiOperation({
    summary: 'Offline transactions that failed or were accepted with warnings',
  })
  issues(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listIssuesQuery }) q: ListIssuesQuery,
  ) {
    return this.review.issues(auth, q);
  }

  @Post('events/:id/retry')
  @HttpCode(200)
  @RequirePermissions('cash:reconcile')
  @ApiOperation({
    summary: 'Run a failed transaction again (optionally under a new number)',
  })
  retry(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: retrySchema }) body: RetryInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.review.retry(auth, id, body, meta);
  }

  @Post('events/:id/discard')
  @HttpCode(200)
  @RequirePermissions('cash:reconcile')
  @ApiOperation({ summary: 'Decide a failed transaction will not be recorded' })
  discard(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: discardSchema }) body: { note: string },
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.review.discard(auth, id, body.note, meta);
  }

  @Post('events/:id/acknowledge')
  @HttpCode(200)
  @RequirePermissions('cash:reconcile')
  @ApiOperation({
    summary: 'Mark the warnings of an accepted transaction as reviewed',
  })
  acknowledge(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: acknowledgeSchema }) body: { note?: string },
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.review.acknowledge(auth, id, body.note, meta);
  }

  @Get('devices')
  @RequirePermissions('cash:reconcile')
  @ApiOperation({
    summary:
      'POS devices: last contact, offline queue size and age, failures, numbers left',
  })
  devices(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: storeQuery }) q: StoreQuery,
  ) {
    return this.review.devices(auth, q);
  }

  @Get('number-blocks')
  @RequirePermissions('cash:reconcile')
  @ApiOperation({
    summary:
      'Reserved invoice-number blocks with used and unused numbers (GST records)',
  })
  blocks(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: storeQuery }) q: StoreQuery,
  ) {
    return this.review.blocks(auth, q);
  }
}
