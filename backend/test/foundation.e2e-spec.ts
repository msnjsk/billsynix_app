import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp } from './utils.js';
import { PrismaService } from '../src/database/prisma.service.js';

describe('Phase 1 foundation (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health → liveness', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });

  it('GET /api/v1/health/ready → database reachable', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'ready',
      checks: { database: { status: 'up' } },
    });
  });

  it('runs against the migrated test database', async () => {
    const prisma = app.get(PrismaService);
    const rows = await prisma.$queryRaw<
      { db: string }[]
    >`SELECT current_database() AS db`;
    expect(rows[0]?.db).toBe('billing_test');
    const log = await prisma.auditLog.create({ data: { action: 'test.ping' } });
    expect(log.id).toMatch(/^[0-9a-f-]{36}$/);
    await prisma.auditLog.delete({ where: { id: log.id } });
  });

  it('generates a request id, echoes a safe client one, replaces an unsafe one', async () => {
    const gen = await request(app.getHttpServer()).get('/api/v1/health');
    expect(gen.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const given = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('X-Request-Id', 'pos-counter-1:abc123');
    expect(given.headers['x-request-id']).toBe('pos-counter-1:abc123');
    const unsafe = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('X-Request-Id', 'bad id with spaces');
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('unknown route → standard 404 error body carrying the request id', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .expect(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('routes outside the /api/v1 prefix are not served', async () => {
    await request(app.getHttpServer()).get('/health').expect(404);
  });

  it('malformed JSON → 400 VALIDATION_FAILED, no stack trace', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.(js|ts)/);
  });

  it('sets security headers, and CORS only for the allowed origin', async () => {
    const ok = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:3000');
    expect(ok.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000',
    );
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    const other = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'http://evil.test');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves the OpenAPI document', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    expect(res.body.info.title).toBe('Billing API');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/api/v1/health', '/api/v1/health/ready']),
    );
  });
});

describe('readiness when the database is down (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const down = {
      permission: { createMany: async () => ({ count: 0 }) },
      ping: () => Promise.reject(new Error('ECONNREFUSED')),
      $connect: async () => undefined,
      $disconnect: async () => undefined,
    };
    app = await createTestApp([{ provide: PrismaService, useValue: down }]);
  });
  afterAll(async () => {
    await app.close();
  });

  it('readiness → 503 SERVICE_UNAVAILABLE without internals; liveness stays 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(503);
    expect(res.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
  });
});
