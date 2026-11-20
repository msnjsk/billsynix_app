import { Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { SubscriptionsController } from './subscriptions.controller.js';
import { SubscriptionsService } from './subscriptions.service.js';
import { gatewayFromEnv, PAYMENT_GATEWAY } from './payment-gateway.js';

/** SaaS plans, trial, paid periods and the payment-provider webhook (Phase 10). */
@Module({
  controllers: [SubscriptionsController],
  providers: [
    SubscriptionsService,
    {
      provide: PAYMENT_GATEWAY,
      inject: [ENV],
      useFactory: (env: Env) => gatewayFromEnv(env),
    },
  ],
})
export class SubscriptionsModule {}
