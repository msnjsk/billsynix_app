import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';

type Override = { provide: unknown; useValue: unknown };

/** Boots the real application (same configuration as production) for HTTP tests. */
export async function createTestApp(
  overrides: Override[] = [],
): Promise<INestApplication<App>> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const o of overrides)
    builder = builder.overrideProvider(o.provide).useValue(o.useValue);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    bufferLogs: true,
    rawBody: true,
  });
  configureApp(app);
  await app.init();
  return app;
}
