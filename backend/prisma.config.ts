import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Migrations need a direct connection; fall back to DATABASE_URL when there is no pooler.
    url: process.env['DIRECT_URL'] || process.env['DATABASE_URL'] || '',
  },
});
