import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { CashSessionsController, SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';
import { SaleReturnsService } from './sale-returns.service.js';
import { CashSessionsService } from './cash-sessions.service.js';

/** POS sales, invoices, payments, returns and cash drawers (Phase 7). */
@Module({
  imports: [InventoryModule],
  controllers: [SalesController, CashSessionsController],
  providers: [SalesService, SaleReturnsService, CashSessionsService],
  exports: [SalesService, CashSessionsService],
})
export class SalesModule {}
