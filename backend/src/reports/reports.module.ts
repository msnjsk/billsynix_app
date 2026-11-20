import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import type { AuthContext } from '../auth/auth-context.js';
import {
  ReportsService,
  salesSummaryQuery,
  type SalesSummaryQuery,
} from './reports.service.js';
import {
  AnalyticsService,
  expiryQuery,
  periodQuery,
  productQuery,
  rangeQuery,
  storeOnlyQuery,
  type RangeQuery,
} from './analytics.service.js';
import { Gstr1Service, gstr1Query, type Gstr1Query } from './gstr1.service.js';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly analytics: AnalyticsService,
    private readonly gstr1Builder: Gstr1Service,
  ) {}

  @Get('gstr1')
  @RequirePermissions('reports:finance')
  @ApiOperation({
    summary:
      'GSTR-1 for one registration and month: the JSON the GST offline tool imports, with a summary (does not file)',
  })
  gstr1(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: gstr1Query }) q: Gstr1Query,
  ) {
    return this.gstr1Builder.build(auth, q);
  }

  @Get('sales-summary')
  @RequirePermissions('reports:sales')
  @ApiOperation({
    summary:
      'Dashboard: sales per day, payment method, product and hour (net of returns)',
  })
  salesSummary(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: salesSummaryQuery }) q: SalesSummaryQuery,
  ) {
    return this.reports.salesSummary(auth, q);
  }

  @Get('sales')
  @RequirePermissions('reports:sales')
  @ApiOperation({
    summary: 'Sales by day, week or month: gross, returns, net, tax, margin',
  })
  sales(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: periodQuery }) q: z.infer<typeof periodQuery>,
  ) {
    return this.analytics.sales(auth, q);
  }

  @Get('sales-by-location')
  @RequirePermissions('reports:sales')
  @ApiOperation({ summary: 'Sales by branch and counter' })
  byLocation(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: rangeQuery }) q: RangeQuery,
  ) {
    return this.analytics.byLocation(auth, q);
  }

  @Get('products')
  @RequirePermissions('reports:sales')
  @ApiOperation({
    summary:
      'Product performance (units, revenue, share; cost and margin for finance)',
  })
  products(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: productQuery }) q: z.infer<typeof productQuery>,
  ) {
    return this.analytics.products(auth, q);
  }

  @Get('categories')
  @RequirePermissions('reports:sales')
  @ApiOperation({ summary: 'Department (top-level category) performance' })
  categories(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: rangeQuery }) q: RangeQuery,
  ) {
    return this.analytics.categories(auth, q);
  }

  @Get('inventory-valuation')
  @RequirePermissions('reports:finance')
  @ApiOperation({
    summary:
      'Stock on hand at average cost, selling price and MRP, per branch and department',
  })
  valuation(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: storeOnlyQuery }) q: z.infer<typeof storeOnlyQuery>,
  ) {
    return this.analytics.inventoryValuation(auth, q);
  }

  @Get('stock-movements')
  @RequirePermissions('inventory:read')
  @ApiOperation({
    summary:
      'Stock in and out by movement type and reason, with value and shrinkage',
  })
  movements(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: rangeQuery }) q: RangeQuery,
  ) {
    return this.analytics.stockMovements(auth, q);
  }

  @Get('expiry')
  @RequirePermissions('inventory:read')
  @ApiOperation({
    summary: 'Batches expired or expiring within `days`, valued at cost',
  })
  expiry(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: expiryQuery }) q: z.infer<typeof expiryQuery>,
  ) {
    return this.analytics.expiry(auth, q);
  }

  @Get('purchases')
  @RequirePermissions('reports:finance')
  @ApiOperation({
    summary: 'Per supplier: bought, returned, paid in the period, owed now',
  })
  purchases(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: rangeQuery }) q: RangeQuery,
  ) {
    return this.analytics.purchases(auth, q);
  }

  @Get('cashier-performance')
  @RequirePermissions('cash:reconcile')
  @ApiOperation({
    summary:
      'Per cashier over a period: bills, value, discounts, voids, returns, drawer variance',
  })
  cashiers(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: rangeQuery }) q: RangeQuery,
  ) {
    return this.analytics.cashiers(auth, q);
  }

  @Get('expenses')
  @ApiOperation({
    summary: 'Expenses by category, payment mode, month and branch',
  })
  expenses(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: rangeQuery }) q: RangeQuery,
  ) {
    return this.analytics.expenses(auth, q);
  }

  @Get('gst')
  @RequirePermissions('reports:finance')
  @ApiOperation({
    summary:
      'GST summary: outward by rate net of credit notes, B2B/B2C, HSN, input tax (not a return)',
  })
  gst(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: rangeQuery }) q: RangeQuery,
  ) {
    return this.analytics.gst(auth, q);
  }

  @Get('payment-reconciliation')
  @RequirePermissions('cash:reconcile')
  @ApiOperation({
    summary:
      'Tenders by status, verification queue, refunds, customer receipts, drawers',
  })
  payments(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: rangeQuery }) q: RangeQuery,
  ) {
    return this.analytics.payments(auth, q);
  }

  @Get('business-summary')
  @RequirePermissions('reports:finance')
  @ApiOperation({
    summary:
      'Sales, margin, expenses, purchases, credit, cash and money owed — a management summary, not a ledger',
  })
  business(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: rangeQuery }) q: RangeQuery,
  ) {
    return this.analytics.business(auth, q);
  }
}

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, AnalyticsService, Gstr1Service],
})
export class ReportsModule {}
