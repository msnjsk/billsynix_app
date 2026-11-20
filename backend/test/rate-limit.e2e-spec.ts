import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp } from './utils.js';

/** Runs in its own file (own module state) so its low limits don't affect other suites. */
describe('rate limiting (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env['AUTH_RATE_LIMIT_PER_MINUTE'] = '3';
    process.env['RATE_LIMIT_PER_MINUTE'] = '20';
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('allows 3 sign-in attempts per minute per IP, then 429 with Retry-After', async () => {
    const attempt = () =>
      http()
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.test', password: 'x' });
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    const res = await attempt();
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('applies the strict limit to PIN sign-in and password reset too', async () => {
    for (const [method, url] of [
      ['post', '/api/v1/auth/pin-login'],
      ['post', '/api/v1/auth/forgot-password'],
    ] as const) {
      let last = 0;
      for (let i = 0; i < 4; i++)
        last = (await http()[method](url).send({ email: 'x@example.test' }))
          .status;
      expect(last, url).toBe(429);
    }
  });

  it('applies the general limit to other endpoints; health probes are exempt', async () => {
    for (let i = 0; i < 30; i++) await http().get('/api/v1/health').expect(200);
    let last = 0;
    for (let i = 0; i < 21; i++)
      last = (await http().get('/api/v1/stores')).status;
    expect(last).toBe(429);
  });
});
