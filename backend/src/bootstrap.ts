import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { ENV } from './config/config.module.js';
import type { Env } from './config/env.js';

/** Everything that must be identical in production and in end-to-end tests. */
export function configureApp(app: INestApplication): Env {
  const env = app.get<Env>(ENV);
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(env.API_PREFIX);
  // Behind a load balancer the client IP (rate limits, audit) comes from X-Forwarded-For.
  if (env.TRUST_PROXY) {
    (
      app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }
    ).set('trust proxy', 1);
  }
  app.use(helmet());
  // Offline POS batches (up to 100 bills) are larger than body-parser's 100 kB default.
  (app as NestExpressApplication).useBodyParser('json', { limit: '2mb' });
  app.enableCors({
    origin: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : false,
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });
  app.enableShutdownHooks();

  if (env.SWAGGER_ENABLED) {
    const config = new DocumentBuilder()
      .setTitle('Billing API')
      .setDescription(
        'Supermarket billing, inventory and business operating system — REST API v1.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      'api/docs',
      app,
      () => SwaggerModule.createDocument(app, config),
      {
        jsonDocumentUrl: 'api/docs-json',
      },
    );
  }
  return env;
}
