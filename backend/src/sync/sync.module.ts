import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module.js';
import { SyncController, SyncReviewController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { SyncReviewService } from './sync-review.service.js';
import { CatalogueFeedService } from './catalogue-feed.service.js';

/** Offline POS: catalogue cache, reserved invoice numbers, batch sync and its review (Phase 9). */
@Module({
  imports: [SalesModule],
  controllers: [SyncController, SyncReviewController],
  providers: [SyncService, SyncReviewService, CatalogueFeedService],
})
export class SyncModule {}
