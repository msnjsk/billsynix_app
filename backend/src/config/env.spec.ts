import { loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(16),
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 4000,
      API_PREFIX: 'api/v1',
      LOG_LEVEL: 'info',
      SWAGGER_ENABLED: false,
    });
    expect(env.CORS_ORIGINS).toEqual([]);
  });

  it('parses lists, booleans and trims the prefix', () => {
    const env = loadEnv({
      ...base,
      CORS_ORIGINS: ' http://a.test, http://b.test ,',
      SWAGGER_ENABLED: 'true',
      API_PREFIX: '/api/v1/',
      PORT: '8080',
    });
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    expect(env.SWAGGER_ENABLED).toBe(true);
    expect(env.API_PREFIX).toBe('api/v1');
    expect(env.PORT).toBe(8080);
  });

  it('lists every problem in one error', () => {
    expect(() =>
      loadEnv({ DATABASE_URL: 'mysql://x', PORT: 'abc' }),
    ).toThrowError(/PORT[\s\S]*DATABASE_URL|DATABASE_URL[\s\S]*PORT/);
  });

  it('rejects weak secrets and wildcard CORS in production only', () => {
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'x'.repeat(20),
        CORS_ORIGINS: '*',
      }),
    ).toThrowError(/JWT_ACCESS_SECRET[\s\S]*CORS_ORIGINS/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'development' })).not.toThrow();
    expect(() => loadEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrowError(
      /JWT_ACCESS_SECRET/,
    );
  });
});
