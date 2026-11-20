import { Module } from '@nestjs/common';
import { CatalogueModule } from '../catalogue/catalogue.module.js';
import {
  AdjustmentsController,
  CountsController,
  StockController,
  TransfersController,
} from './inventory.controller.js';
import { LedgerService } from './ledger.service.js';
import { StockService } from './stock.service.js';
import { AdjustmentsService } from './adjustments.service.js';
import { CountsService } from './counts.service.js';
import { TransfersService } from './transfers.service.js';

/** Stock ledger, branch balances, batches, adjustments, counts and transfers (Phase 5). */
@Module({
  imports: [CatalogueModule],
  controllers: [
    StockController,
    AdjustmentsController,
    CountsController,
    TransfersController,
  ],
  providers: [
    LedgerService,
    StockService,
    AdjustmentsService,
    CountsService,
    TransfersService,
  ],
  exports: [LedgerService],
})
export class InventoryModule {}
