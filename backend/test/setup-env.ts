import 'dotenv/config';

// Every e2e test talks to the dedicated test database, never the development one.
const url = process.env['TEST_DATABASE_URL'];
if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.example).');
process.env['DATABASE_URL'] = url;
process.env['DIRECT_URL'] = process.env['TEST_DIRECT_URL'] ?? '';
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = process.env['TEST_LOG_LEVEL'] ?? 'silent';
process.env['SWAGGER_ENABLED'] = 'true';
process.env['CORS_ORIGINS'] = 'http://localhost:3000';
// Suites sign in many times from one IP; the rate-limit suite sets its own low limits.
process.env['RATE_LIMIT_PER_MINUTE'] = '100000';
process.env['AUTH_RATE_LIMIT_PER_MINUTE'] = '100000';
// Uploaded files go to a throwaway folder.
process.env['STORAGE_DRIVER'] = 'local';
process.env['STORAGE_LOCAL_DIR'] =
  `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/billing-test-storage`;
