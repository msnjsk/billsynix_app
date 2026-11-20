import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AllowWhenReadOnly,
  CurrentAuth,
  ReqMeta,
  RequirePermissions,
  type RequestMeta,
} from '../auth/decorators.js';
import type { AuthContext } from '../auth/auth-context.js';
import { uuidParam } from '../common/schemas.js';
import { IdempotencyKey, reply } from '../common/idempotency.js';
import { SalesService } from './sales.service.js';
import { SaleReturnsService } from './sale-returns.service.js';
import { CashSessionsService } from './cash-sessions.service.js';
import { renderReceiptHtml } from './receipt.js';
import {
  approversQuery,
  cashierReportQuery,
  cashMovementSchema,
  closeSessionSchema,
  createReturnSchema,
  createSaleSchema,
  listSalesQuery,
  listSessionsQuery,
  openSessionSchema,
  paymentDecisionSchema,
  quoteSchema,
  reviewSessionSchema,
  voidSchema,
  type ApproversQuery,
  type CashierReportQuery,
  type CashMovementInput,
  type CloseSessionInput,
  type CreateReturnInput,
  type CreateSaleInput,
  type ListSalesQuery,
  type ListSessionsQuery,
  type OpenSessionInput,
  type PaymentDecisionInput,
  type QuoteInput,
  type VoidInput,
} from './sales.schemas.js';

const IDEMPOTENCY = ApiHeader({
  name: 'Idempotency-Key',
  required: true,
  description:
    'A fresh UUID per bill; resend the same one when retrying (e.g. after a network error).',
});

@ApiTags('pos')
@ApiBearerAuth()
@Controller()
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly returns: SaleReturnsService,
  ) {}

  @Post('sales/quote')
  @HttpCode(200)
  @RequirePermissions('sales:create')
  @ApiOperation({
    summary:
      'Validate a cart: server prices, discounts, GST, stock — nothing is saved',
  })
  quote(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: quoteSchema }) body: QuoteInput,
  ) {
    return this.sales.quote(auth, body);
  }

  @Post('sales')
  @RequirePermissions('sales:create')
  @IDEMPOTENCY
  @ApiOperation({
    summary: 'Complete a sale',
    description:
      'One transaction: stock out, invoice number, line snapshots, payments, printed document. Retries with the same Idempotency-Key return the same sale.',
  })
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createSaleSchema }) body: CreateSaleInput,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.sales.create(auth, body, key, meta));
  }

  @Get('sales')
  @RequirePermissions('sales:read')
  @ApiOperation({ summary: 'Sales (cashiers see their own)' })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listSalesQuery }) q: ListSalesQuery,
  ) {
    return this.sales.list(auth, q);
  }

  @Get('sales/approvers')
  @RequirePermissions('sales:create')
  @ApiOperation({
    summary: 'Managers who can approve a void or discount here with their PIN',
  })
  approvers(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: approversQuery }) q: ApproversQuery,
  ) {
    return this.sales.approvers(auth, q);
  }

  @Get('sales/pending-payments')
  @RequirePermissions('cash:reconcile')
  @ApiOperation({ summary: 'UPI/card payments waiting to be verified' })
  pending(@CurrentAuth() auth: AuthContext) {
    return this.sales.pendingPayments(auth);
  }

  @Get('sales/:id')
  @RequirePermissions('sales:read')
  @ApiOperation({ summary: 'One sale with lines, payments and returns' })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.sales.get(auth, id);
  }

  @Get('sales/:id/receipt')
  @RequirePermissions('sales:read')
  @ApiOperation({
    summary: 'The invoice (and credit notes) exactly as issued — for reprints',
  })
  receipt(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.sales.receipt(auth, id);
  }

  @Get('sales/:id/receipt.html')
  @RequirePermissions('sales:read')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'",
  )
  @ApiProduces('text/html')
  @ApiOperation({
    summary: 'Print-ready 80 mm receipt (print to paper or PDF)',
  })
  async receiptHtml(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    const r = await this.sales.receipt(auth, id);
    return renderReceiptHtml(r.invoice, r.status);
  }

  @Post('sales/:id/void')
  @HttpCode(200)
  @RequirePermissions('sales:read')
  @ApiOperation({
    summary: 'Cancel a sale today (manager, or a manager’s PIN)',
  })
  void(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: voidSchema }) body: VoidInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.sales.void(auth, id, body, meta);
  }

  @Post('sales/:id/returns')
  @RequirePermissions('sales:return')
  @IDEMPOTENCY
  @ApiOperation({
    summary: 'Return items against this invoice (credit note + refund)',
  })
  async createReturn(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: createReturnSchema }) body: CreateReturnInput,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.returns.create(auth, id, body, key, meta));
  }

  @Post('sale-payments/:id/confirm')
  @HttpCode(200)
  @RequirePermissions('cash:reconcile')
  @ApiOperation({
    summary:
      'Mark a UPI/card payment as received (seen in the bank/terminal statement)',
  })
  confirm(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: paymentDecisionSchema }) body: PaymentDecisionInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.sales.confirmPayment(auth, id, body, meta);
  }

  @Post('sale-payments/:id/fail')
  @HttpCode(200)
  @RequirePermissions('cash:reconcile')
  @ApiOperation({
    summary: 'Mark a UPI/card payment as not received (the sale becomes DUE)',
  })
  fail(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: paymentDecisionSchema }) body: PaymentDecisionInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.sales.failPayment(auth, id, body, meta);
  }
}

@ApiTags('pos')
@ApiBearerAuth()
@Controller()
export class CashSessionsController {
  constructor(private readonly sessions: CashSessionsService) {}

  @Post('cash-sessions')
  @RequirePermissions('cash:session')
  @ApiOperation({ summary: 'Open your cash drawer on a counter with a float' })
  open(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: openSessionSchema }) body: OpenSessionInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.sessions.open(auth, body, meta);
  }

  @Get('cash-sessions/current')
  @RequirePermissions('cash:session')
  @ApiOperation({ summary: 'Your open drawer with live expected cash' })
  current(@CurrentAuth() auth: AuthContext) {
    return this.sessions.current(auth);
  }

  @Get('cash-sessions')
  @RequirePermissions('cash:session')
  @ApiOperation({ summary: 'Drawers (yours, or all for managers)' })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listSessionsQuery }) q: ListSessionsQuery,
  ) {
    return this.sessions.list(auth, q);
  }

  @Get('cash-sessions/:id')
  @RequirePermissions('cash:session')
  @ApiOperation({ summary: 'One drawer' })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.sessions.get(auth, id);
  }

  @Post('cash-sessions/:id/movements')
  @RequirePermissions('cash:session')
  @ApiOperation({
    summary: 'Cash put in (PAY_IN) or taken out (PAY_OUT) of your drawer',
  })
  movement(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: cashMovementSchema }) body: CashMovementInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.sessions.movement(auth, id, body, meta);
  }

  @Post('cash-sessions/:id/close')
  @HttpCode(200)
  @AllowWhenReadOnly() // counting the drawer at the end of the day records no new business
  @ApiOperation({ summary: 'Count the drawer and close it (allowed while read-only)' })
  @RequirePermissions('cash:session')
  close(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: closeSessionSchema }) body: CloseSessionInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.sessions.close(auth, id, body, meta);
  }

  @Post('cash-sessions/:id/review')
  @HttpCode(200)
  @RequirePermissions('cash:reconcile')
  @ApiOperation({ summary: 'Sign off a drawer closed with a large variance' })
  review(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: reviewSessionSchema }) body: { note: string },
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.sessions.review(auth, id, body.note, meta);
  }

  @Get('reports/cashiers')
  @RequirePermissions('cash:reconcile')
  @ApiOperation({
    summary:
      'Cashier-wise sales, tenders, refunds and drawer variance for a day',
  })
  cashiers(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: cashierReportQuery }) q: CashierReportQuery,
  ) {
    return this.sessions.cashierReport(auth, q);
  }
}
