import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import {
  PurchaseOrdersController,
  ReceivingController,
  SuppliersController,
} from './purchasing.controller.js';
import { SuppliersService } from './suppliers.service.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import { ReceiptsService } from './receipts.service.js';
import { ReturnsService } from './returns.service.js';
import { PaymentsService } from './payments.service.js';

/** Suppliers, purchase orders, goods receipts, returns and supplier payments (Phase 6). */
@Module({
  imports: [InventoryModule],
  controllers: [
    SuppliersController,
    PurchaseOrdersController,
    ReceivingController,
  ],
  providers: [
    SuppliersService,
    PurchaseOrdersService,
    ReceiptsService,
    ReturnsService,
    PaymentsService,
  ],
})
export class PurchasingModule {}
