import 'dotenv/config';
import { execSync } from 'node:child_process';

/** Brings the test database up to the latest migration once per run. */
export default function setup() {
  // Migrations run as the schema owner; the app (and tests) connect as the RLS-bound role.
  const owner =
    process.env['TEST_DIRECT_URL'] || process.env['TEST_DATABASE_URL'];
  if (!owner)
    throw new Error(
      'TEST_DIRECT_URL / TEST_DATABASE_URL are not set (see .env.example).',
    );
  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: owner, DIRECT_URL: owner },
  });
}
