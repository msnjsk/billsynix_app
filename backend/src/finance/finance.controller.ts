import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
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
import { CustomersService } from './customers.service.js';
import { ExpensesService } from './expenses.service.js';
import {
  createCustomerSchema,
  createExpenseSchema,
  expenseCategorySchema,
  listCustomersQuery,
  listExpensesQuery,
  receiptSchema,
  updateCustomerSchema,
  updateExpenseCategorySchema,
  voidExpenseSchema,
  type CreateCustomerInput,
  type CreateExpenseInput,
  type ListCustomersQuery,
  type ListExpensesQuery,
  type ReceiptInput,
  type UpdateCustomerInput,
} from './finance.schemas.js';

const IDEMPOTENCY = ApiHeader({
  name: 'Idempotency-Key',
  required: true,
  description: 'A fresh UUID per action; resend the same one when retrying.',
});

@ApiTags('customers')
@ApiBearerAuth()
@Controller()
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get('customers')
  @RequirePermissions('customers:read')
  @ApiOperation({
    summary:
      'Customers (search by name or phone; `owing=true` for those with a balance)',
  })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listCustomersQuery }) q: ListCustomersQuery,
  ) {
    return this.customers.list(auth, q);
  }

  @Post('customers')
  @RequirePermissions('customers:write')
  @ApiOperation({ summary: 'Add a customer (credit limit, opening balance)' })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createCustomerSchema }) body: CreateCustomerInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.customers.create(auth, body, meta);
  }

  @Get('customers/:id')
  @RequirePermissions('customers:read')
  @ApiOperation({ summary: 'One customer with balance and credit available' })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.customers.get(auth, id);
  }

  @Patch('customers/:id')
  @RequirePermissions('customers:write')
  @ApiOperation({
    summary: 'Edit a customer (details, credit limit, close the account)',
  })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updateCustomerSchema }) body: UpdateCustomerInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.customers.update(auth, id, body, meta);
  }

  @Get('customers/:id/ledger')
  @RequirePermissions('customers:read')
  @ApiOperation({
    summary:
      'Account statement: credit sales, returns, receipts, balance after each',
  })
  ledger(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.customers.ledger(auth, id);
  }

  @Post('customers/:id/receipts')
  @RequirePermissions('customers:write')
  @IDEMPOTENCY
  @ApiOperation({
    summary:
      'The customer paid towards their account (cash goes into your open drawer)',
  })
  async receipt(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: receiptSchema }) body: ReceiptInput,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.customers.receipt(auth, id, body, key, meta));
  }

  @Get('reports/receivables')
  @RequirePermissions('customers:read')
  @ApiOperation({
    summary: 'What customers owe, with ageing (0–30, 31–60, 61–90, 90+ days)',
  })
  receivables(@CurrentAuth() auth: AuthContext) {
    return this.customers.receivables(auth);
  }
}

@ApiTags('expenses')
@ApiBearerAuth()
@Controller()
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get('expense-categories')
  @RequirePermissions('expenses:write')
  @ApiOperation({
    summary: 'Expense categories (defaults are created on first use)',
  })
  categories(@CurrentAuth() auth: AuthContext) {
    return this.expenses.categories(auth);
  }

  @Post('expense-categories')
  @RequirePermissions('expenses:write')
  @ApiOperation({ summary: 'Add an expense category' })
  createCategory(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: expenseCategorySchema }) body: { name: string },
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.expenses.createCategory(auth, body.name, meta);
  }

  @Patch('expense-categories/:id')
  @RequirePermissions('expenses:write')
  @ApiOperation({ summary: 'Rename or hide an expense category' })
  updateCategory(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updateExpenseCategorySchema })
    body: { name?: string; isActive?: boolean },
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.expenses.updateCategory(auth, id, body, meta);
  }

  @Get('expenses')
  @RequirePermissions('expenses:write')
  @ApiOperation({ summary: 'Expenses' })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query({ schema: listExpensesQuery }) q: ListExpensesQuery,
  ) {
    return this.expenses.list(auth, q);
  }

  @Post('expenses')
  @RequirePermissions('expenses:write')
  @IDEMPOTENCY
  @ApiOperation({
    summary:
      'Record an expense (`fromDrawer`: cash paid out of your open drawer)',
  })
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: createExpenseSchema }) body: CreateExpenseInput,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.expenses.create(auth, body, key, meta));
  }

  @Post('expenses/:id/void')
  @HttpCode(200)
  @RequirePermissions('expenses:write')
  @ApiOperation({
    summary:
      'Void an expense (its drawer pay-out is reversed while the drawer is open)',
  })
  void(
    @CurrentAuth() auth: AuthContext,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: voidExpenseSchema }) body: { reason: string },
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.expenses.void(auth, id, body.reason, meta);
  }
}
