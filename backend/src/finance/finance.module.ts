import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module.js';
import {
  CustomersController,
  ExpensesController,
} from './finance.controller.js';
import { CustomersService } from './customers.service.js';
import { ExpensesService } from './expenses.service.js';

/** Customers and credit (khata), expenses (Phase 10). Reports live in ReportsModule. */
@Module({
  imports: [SalesModule],
  controllers: [CustomersController, ExpensesController],
  providers: [CustomersService, ExpensesService],
})
export class FinanceModule {}
