import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import {
  AllowWhenReadOnly,
  CurrentAuth,
  Public,
  ReqMeta,
  RequirePermissions,
  type RequestMeta,
} from '../auth/decorators.js';
import type { AuthContext } from '../auth/auth-context.js';
import { SubscriptionsService } from './subscriptions.service.js';

const checkoutSchema = z.object({
  plan: z.string().trim().min(1).max(40),
  interval: z.enum(['MONTHLY', 'YEARLY']).default('MONTHLY'),
});

@ApiTags('subscription')
@Controller()
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Public()
  @Get('plans')
  @ApiOperation({ summary: 'Plans with prices (excl. GST) and limits' })
  plans() {
    return this.subs.plans();
  }

  @ApiBearerAuth()
  @Get('subscription')
  @RequirePermissions('tenant:read')
  @ApiOperation({
    summary:
      'This business’s plan, status (trial, active, in grace, lapsed), usage and limits',
  })
  current(@CurrentAuth() auth: AuthContext) {
    return this.subs.current(auth);
  }

  @ApiBearerAuth()
  @Get('subscription/invoices')
  @RequirePermissions('subscription:manage')
  @ApiOperation({ summary: 'Subscription invoices and payments' })
  invoices(@CurrentAuth() auth: AuthContext) {
    return this.subs.invoices(auth);
  }

  @ApiBearerAuth()
  @Post('subscription/checkout')
  @AllowWhenReadOnly()
  @RequirePermissions('subscription:manage')
  @ApiOperation({
    summary: 'Start paying for a plan: an invoice and a payment-provider order',
    description:
      'The subscription changes only when the provider’s verified webhook confirms the payment — never from the browser.',
  })
  checkout(
    @CurrentAuth() auth: AuthContext,
    @Body({ schema: checkoutSchema }) body: z.infer<typeof checkoutSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.subs.checkout(auth, body, meta);
  }

  @ApiBearerAuth()
  @Post('subscription/cancel')
  @HttpCode(200)
  @AllowWhenReadOnly()
  @RequirePermissions('subscription:manage')
  @ApiOperation({
    summary:
      'Don’t renew: keeps working until the end of the trial or paid period',
  })
  cancel(@CurrentAuth() auth: AuthContext, @ReqMeta() meta: RequestMeta) {
    return this.subs.cancel(auth, meta);
  }

  @ApiBearerAuth()
  @Post('subscription/resume')
  @HttpCode(200)
  @AllowWhenReadOnly()
  @RequirePermissions('subscription:manage')
  @ApiOperation({ summary: 'Undo a cancellation before the period ends' })
  resume(@CurrentAuth() auth: AuthContext, @ReqMeta() meta: RequestMeta) {
    return this.subs.resume(auth, meta);
  }

  @Public()
  @SkipThrottle()
  @Post('webhooks/payments/:provider')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Payment-provider webhook (signature-verified, processed once per event)',
  })
  webhook(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    return this.subs.webhook(provider, req.rawBody, headers);
  }
}
