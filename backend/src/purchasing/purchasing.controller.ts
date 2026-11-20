import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
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
import {
  CurrentAuth,
  ReqMeta,
  RequirePermissions,
  type RequestMeta,
} from '../auth/decorators.js';
import type { AuthContext } from '../auth/auth-context.js';
import { uuidParam } from '../common/schemas.js';
import { IdempotencyKey, reply } from '../common/idempotency.js';
import { SuppliersService } from './suppliers.service.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import { ReceiptsService } from './receipts.service.js';
import { ReturnsService } from './returns.service.js';
import { PaymentsService } from './payments.service.js';
import {
  createGrnSchema,
  createPaymentSchema,
  createPoSchema,
  createReturnSchema,
  createSupplierSchema,
  listGrnQuery,
  listPaymentsQuery,
  listPoQuery,
  listReturnsQuery,
  listSuppliersQuery,
  payablesQuery,
  statementQuery,
  supplierPricesSchema,
  updatePoSchema,
  updateSupplierSchema,
  type CreateGrnInput,
  type CreatePaymentInput,
  type CreatePoInput,
  type CreateReturnInput,
  type CreateSupplierInput,
  type ListGrnQuery,
  type ListPaymentsQuery,
  type ListPoQuery,
  type ListReturnsQuery,
  type ListSuppliersQuery,
  type StatementQuery,
  type SupplierPricesInput,
  type UpdatePoInput,
  type UpdateSupplierInput,
} from './purchasing.schemas.js';

const IDEMPOTENCY = ApiHeader({
  name: 'Idempotency-Key',
  required: true,
  description: 'A fresh UUID per action; resend the same one when retrying.',
});

@ApiTags('suppliers')
@ApiBearerAuth()
@Controller()
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get('suppliers')
  @ApiOperation({
    summary: 'Suppliers (balances shown to people who pay them)',
  })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listSuppliersQuery }) q: ListSuppliersQuery,
  ) {
    return this.suppliers.list(auth, q);
  }

  @Post('suppliers')
  @RequirePermissions('suppliers:manage')
  @ApiOperation({
    summary: 'Add a supplier (optionally with what we already owe them)',
  })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createSupplierSchema }) body: CreateSupplierInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.suppliers.create(auth, body, meta);
  }

  @Get('suppliers/:id')
  @ApiOperation({ summary: 'One supplier' })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.suppliers.get(auth, id);
  }

  @Patch('suppliers/:id')
  @RequirePermissions('suppliers:manage')
  @ApiOperation({ summary: 'Edit or deactivate a supplier' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updateSupplierSchema }) body: UpdateSupplierInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.suppliers.update(auth, id, body, meta);
  }

  @Get('suppliers/:id/products')
  @ApiOperation({
    summary: "The supplier's prices (kept up to date by receipts)",
  })
  prices(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.suppliers.prices(auth, id);
  }

  @Put('suppliers/:id/products')
  @RequirePermissions('suppliers:manage')
  @ApiOperation({
    summary:
      "Set the supplier's prices (excl. GST, after their usual discount)",
  })
  setPrices(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: supplierPricesSchema }) body: SupplierPricesInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.suppliers.setPrices(auth, id, body, meta);
  }

  @Get('suppliers/:id/statement')
  @ApiOperation({ summary: 'Statement of account with running balance' })
  statement(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Query({ schema: statementQuery }) q: StatementQuery,
  ) {
    return this.suppliers.statement(auth, id, q);
  }

  @Get('suppliers/:id/open-bills')
  @ApiOperation({ summary: 'Receipts with money still owed, oldest due first' })
  openBills(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.suppliers.openBills(auth, id);
  }

  @Get('reports/payables')
  @ApiOperation({
    summary:
      'What we owe each supplier, with ageing (current, 1–30, 31–60, 60+ days late)',
  })
  payables(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: payablesQuery }) q: { all: boolean },
  ) {
    return this.suppliers.payables(auth, q.all);
  }

  @Get('products/:productId/purchase-history')
  @ApiOperation({ summary: 'Receipts of a product: dates, suppliers, prices' })
  history(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', { schema: uuidParam }) id: string,
  ) {
    return this.suppliers.purchaseHistory(auth, id);
  }
}

@ApiTags('purchasing')
@ApiBearerAuth()
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly pos: PurchaseOrdersService) {}

  @Get()
  @RequirePermissions('purchases:write')
  @ApiOperation({ summary: 'Purchase orders (status=OPEN for SENT + PARTIAL)' })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listPoQuery }) q: ListPoQuery,
  ) {
    return this.pos.list(auth, q);
  }

  @Post()
  @RequirePermissions('purchases:write')
  @ApiOperation({
    summary: 'Draft a purchase order (rates default to the supplier’s prices)',
  })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createPoSchema }) body: CreatePoInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.pos.create(auth, body, meta);
  }

  @Get(':id')
  @RequirePermissions('purchases:write')
  @ApiOperation({ summary: 'One purchase order with receipt progress' })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.pos.get(auth, id);
  }

  @Patch(':id')
  @RequirePermissions('purchases:write')
  @ApiOperation({ summary: 'Edit a draft' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updatePoSchema }) body: UpdatePoInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.pos.update(auth, id, body, meta);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermissions('purchases:write')
  @ApiOperation({
    summary: 'Send it (or ask for approval when above the limit)',
  })
  submit(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.pos.submit(auth, id, meta);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('purchases:approve')
  @ApiOperation({ summary: 'Approve and send' })
  approve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.pos.approve(auth, id, meta);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('purchases:write')
  @ApiOperation({ summary: 'Cancel (only before anything was received)' })
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.pos.cancel(auth, id, meta);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermissions('purchases:write')
  @ApiOperation({ summary: 'Close short: the rest will not be delivered' })
  close(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.pos.close(auth, id, meta);
  }
}

@ApiTags('purchasing')
@ApiBearerAuth()
@Controller()
export class ReceivingController {
  constructor(
    private readonly receipts: ReceiptsService,
    private readonly returns: ReturnsService,
    private readonly payments: PaymentsService,
  ) {}

  @Post('goods-receipts')
  @RequirePermissions('purchases:write')
  @IDEMPOTENCY
  @ApiOperation({
    summary: 'Receive goods with the supplier invoice',
    description:
      'One transaction: accepted stock in, the payable to the supplier, the PO progress. Mismatches with the PO are returned in matchIssues.',
  })
  async receive(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createGrnSchema }) body: CreateGrnInput,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.receipts.create(auth, body, key, meta));
  }

  @Get('goods-receipts')
  @RequirePermissions('purchases:write')
  @ApiOperation({ summary: 'Goods receipts (unpaid=true for open bills)' })
  listReceipts(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listGrnQuery }) q: ListGrnQuery,
  ) {
    return this.receipts.list(auth, q);
  }

  @Get('goods-receipts/:id')
  @RequirePermissions('purchases:write')
  @ApiOperation({ summary: 'One goods receipt' })
  getReceipt(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.receipts.get(auth, id);
  }

  @Post('purchase-returns')
  @RequirePermissions('purchases:write')
  @IDEMPOTENCY
  @ApiOperation({ summary: 'Return goods to the supplier (debit note)' })
  async createReturn(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createReturnSchema }) body: CreateReturnInput,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.returns.create(auth, body, key, meta));
  }

  @Get('purchase-returns')
  @RequirePermissions('purchases:write')
  @ApiOperation({ summary: 'Purchase returns' })
  listReturns(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listReturnsQuery }) q: ListReturnsQuery,
  ) {
    return this.returns.list(auth, q);
  }

  @Get('purchase-returns/:id')
  @RequirePermissions('purchases:write')
  @ApiOperation({ summary: 'One purchase return' })
  getReturn(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.returns.get(auth, id);
  }

  @Post('supplier-payments')
  @RequirePermissions('supplier-payments:write')
  @IDEMPOTENCY
  @ApiOperation({ summary: 'Record a payment to (or refund from) a supplier' })
  async pay(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createPaymentSchema }) body: CreatePaymentInput,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.payments.create(auth, body, key, meta));
  }

  @Get('supplier-payments')
  @RequirePermissions('supplier-payments:write')
  @ApiOperation({ summary: 'Supplier payments' })
  listPayments(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listPaymentsQuery }) q: ListPaymentsQuery,
  ) {
    return this.payments.list(auth, q);
  }

  @Get('supplier-payments/:id')
  @RequirePermissions('supplier-payments:write')
  @ApiOperation({ summary: 'One payment with its allocations' })
  getPayment(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.payments.get(auth, id);
  }
}
