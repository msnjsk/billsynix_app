import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { TokenService } from './token.service.js';
import { AuthGuard } from './auth.guard.js';
import { SessionService } from './session.service.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';

/**
 * Sign-in, sessions and the two global guards. Order matters: the rate limiter runs before
 * authentication, so floods are rejected before any database work.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.JWT_ACCESS_SECRET,
        signOptions: { algorithm: 'HS256', issuer: 'billing-api' },
        verifyOptions: { algorithms: ['HS256'], issuer: 'billing-api' },
      }),
    }),
    // In-memory counters: correct for a single API instance. Use Redis storage when scaling out.
    ThrottlerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        throttlers: [
          { name: 'default', ttl: 60_000, limit: env.RATE_LIMIT_PER_MINUTE },
        ],
        errorMessage: 'Too many requests. Please wait a moment and try again.',
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    TokenService,
    SessionService,
    AuthService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [TokenService, SessionService],
})
export class AuthModule {}
